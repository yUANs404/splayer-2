# SPlayer-2 本地 AI 语音音乐助手 — 第一阶段源码分析与实施方案

> 状态：待用户确认。本文档为开发前规划文档，确认后按阶段实施，实施完成前不改动任何业务代码。
> 更新时间：2026-11-08

---

## A. 当前项目真实技术架构

| 层 | 技术 | 说明 |
|---|---|---|
| 桌面框架 | Electron 41 + electron-vite 5 | main / preload / renderer 三进程，`contextIsolation` 开启 |
| 前端 | Vue 3 + TypeScript + Pinia + Naive UI | pnpm 管理，`@` / `@shared` / `@native` 等别名 |
| 主进程服务 | Fastify（内嵌 HTTP，端口 25884） | 同时服务渲染页面静态文件 + `/api/control` 本地遥控 + 更新检查 |
| 局域网遥控 | WebSocket（ipc-socket.ts） | 独立于本方案，可复用其状态上报模式 |
| 播放内核 | 完全在渲染进程 | `PlayerController` + `AudioManager` + 三引擎（AudioElement / FFmpeg WASM / MPV） |
| 数据库 | better-sqlite3（主进程） | `LocalMusicDB`（曲库）+ `CacheDB`；本次会话已修复为外部依赖，随 `app.asar.unpacked` 发布 |
| 原生模块 | Rust (NAPI) ×3 + WASM ×1 | `tools`（曲库扫描）、`external-media-integration`（SMTC/Discord）、`taskbar-lyric`、`ferrous-opencc-wasm` |
| 本地版改造 | 无任何在线 API | 播放源 100% `song.path -> file://`，曲库来自本地扫描 |

**环境探测结论（2026-11-08 实测）**

| 依赖 | 状态 | 影响 |
|---|---|---|
| Rust 工具链（cargo/rustc） | ❌ 未安装 | 无法在本机编译任何新 Rust 模块（现有构建用 `SKIP_NATIVE_BUILD=true` 跳过） |
| whisper.cpp | ✅ 已部署 | `ai-tools/whisper/bin/Release/whisper-cli.exe`（b5454）+ `models/ggml-small.bin`（465MB），中文识别实测通过 |
| Ollama (127.0.0.1:11434) | ✅ v0.40.13 | 本地已有 `qwen2.5:7b`（4.7GB） |
| Qwen2.5 模型 | ✅ 验证通过 | 6/6 指令 JSON 全部合法，延迟 0.4–4.7s |

## 阶段二验证结果（2026-11-08）

| 验证项 | 结果 | 备注 |
|---|---|---|
| uiohook-napi F8 按下/松开 | ✅ 通过 | win32-x64 预编译自带；**长按会触发键盘自动重复 DOWN（约 32ms/条），必须做录音中防抖** |
| Ollama + Qwen JSON 服从性 | ✅ 6/6 | 含 unknown 正确拒答；首载 4.7s，后续 0.4–0.6s |
| whisper-cli 中文识别 | ✅ 通过 | TTS“播放周杰伦的晴天”→“播放周杰倫的《晴天》”；**输出含繁体与书名号，匹配前需 OpenCC 繁→简归一化 + 去标点**（渲染层已有 ferrous-opencc-wasm 可复用） |
| 渲染层后台采集（getUserMedia） | ⏳ 阶段四应用内验证 | 窗口隐藏到托盘时渲染进程持续存活，理论上可用 |

## B. 真实目录结构（与 AI 相关的部分）

```text
SPlayer/
├─ electron/
│  ├─ main/
│  │  ├─ index.ts              # 应用生命周期、服务初始化
│  │  ├─ ipc/                  # ipc-cache/file/lyric/media/mpv/shortcut/socket/store/system/taskbar/... 共 17 个
│  │  ├─ shortcut/index.ts     # globalShortcut 封装（注册/查询/全部卸载）
│  │  ├─ server/control/       # /api/control 本地遥控（主→渲染命令转发）
│  │  ├─ windows/              # 主窗口/桌面歌词/任务栏歌词
│  │  ├─ services/             # LocalMusicService、CacheService、MusicMetadataService
│  │  ├─ database/             # LocalMusicDB、CacheDB（better-sqlite3）
│  │  └─ utils/                # native-loader、track-info（主→渲染查询当前曲目）、format
│  └─ preload/index.ts         # window.electron（ipcRenderer）、window.api.store、window.logger
├─ native/                     # Rust 模块（tools / external-media-integration / taskbar-lyric / ferrous-opencc-wasm）
├─ scripts/build-native.ts     # cargo 可用时逐个 pnpm --filter <mod> build，否则要求 SKIP_NATIVE_BUILD=true
└─ src/
   ├─ core/player/
   │  ├─ PlayerController.ts   # 播放业务核心（playSong/updatePlayList/play/pause/nextOrPrev/setVolume/setSeek/...）
   │  ├─ PlayerIpc.ts          # 渲染→主状态上报（SMTC/任务栏/桌面歌词/Socket）
   │  ├─ AudioManager.ts       # 引擎选择与封装
   │  └─ SongManager.ts        # 音频源解析（本地 path → file://）
   ├─ stores/                  # data（播放队列）/ music / status / setting / shortcut / local（曲库）
   ├─ utils/initIpc.ts         # 渲染层监听主进程命令：play/pause/playOrPause/playNext/playPrev/volumeUp/volumeDown/seek...
   ├─ utils/helper.ts          # fuzzySearch（Fuse.js，name/alia/artists/album 加权，threshold 0.35）
   ├─ types/shared/            # 主/渲染共享类型（taskbar-ipc.ts、play-mode.ts）
   └─ components/Setting/config/  # 各设置分区（general/keyboard/local/play/...）
```

## C. 歌曲搜索与播放调用链（实测确认）

**播放链：**

```text
UI / AI
 → PlayerController.updatePlayList(songs, {play})      # 写入 data store 播放队列 (src/core/player/PlayerController.ts:1051)
 → PlayerController.playSong({autoPlay, seek})         # :250
 → prepareAudioSource(song)                            # :126 → SongManager.getAudioSource()：本地 path → file://
 → audioManager.load(url)                              # 按 settingStore.audioEngine 选 AudioElement / FFmpeg / MPV 引擎
 → 引擎事件 → statusStore（进度/时长/播放状态）
 → PlayerIpc.ts 把状态上报主进程（SMTC、任务栏歌词、桌面歌词、LAN Socket）
```

**主→渲染命令模式（AI 直接复用）：**

- 全局快捷键：`ipc-shortcut.ts` → `mainWin.webContents.send(key)`（key 即 `playOrPause`/`playNext` 等）。
- 本地遥控：`electron/server/control/index.ts` → `mainWin.webContents.send("play"|"pause"|"playOrPause"|"playNext"|"playPrev")`。
- 渲染层统一监听：`src/utils/initIpc.ts:27-42` → 调用 `PlayerController` 同名方法。**AI 的简单指令走同一条通道，天然与 UI 同一套逻辑。**

**主→渲染查询模式（AI 复用）：** `electron/main/utils/track-info.ts` 通过 `request-track-info` / `return-track-info`（带 2s 超时）从渲染层取当前曲目信息 → 可直接用于 `get_current_track` / `get_playback_status`。

**搜索链：** 主进程 `LocalMusicService`（Rust 扫描 + JS 回退）→ SQLite `LocalMusicDB` → IPC `local-music-sync` → `localStore.localSongs` → 前端 `fuzzySearch()`（Fuse.js）。

## D. 快捷键与 IPC 实现方式

- 快捷键体系：`src/stores/shortcut.ts`（持久化 `shortcutList`，含 app 内 `shortcut` 与 `globalShortcut` 两列）→ IPC `register-all-shortcut` → `electron/main/shortcut/index.ts`（globalShortcut 注册，返回注册失败列表做冲突检测）→ 设置页 `keyboard.ts` + `ShortcutRecorder.vue` 可录制改键。
- **关键限制：Electron `globalShortcut` 只有按下事件，没有松开事件**，无法实现「按住说话/松开识别」，需要补充方案（见 H/I）。
- IPC 面：约 45 个 `ipcMain.handle` 白名单通道；preload 通过 `@electron-toolkit/preload` 暴露 `window.electron.ipcRenderer`，另有 `window.api.store`、`window.logger`。AI 模块遵循同样模式，新增独立 `window.ai` 桥（不扩大现有暴露面）。

## E. Rust 原生模块情况

- 现有 4 个模块均为 Rust crate（各自 `Cargo.toml` + `package.json`），由 `scripts/build-native.ts` 统一 `pnpm --filter <name> build` 编译为 `.node`；打包经 `electron-builder.config.ts` 的 `extraResources` 复制到 `resources/native/`，运行时由 `loadNativeModule()` 加载。
- **本机当前没有 Rust 工具链**：所有既有验证均以 `SKIP_NATIVE_BUILD=true` 完成。新增 Rust 模块（音频采集 / 键盘钩子 / Whisper 封装）在本机无法编译验证，除非先安装 Rust。
- 因此方案按「零 Rust 可用版先行」设计，Rust 原生采集作为可选增强（见 I-1）。

## F. AI 助手接入位置（复用点）

| 接入点 | 文件 | 方式 |
|---|---|---|
| 主进程编排 | `electron/main/ai/*`（新增） | 快捷键状态机、录音缓冲、调 Whisper/Ollama、分发指令 |
| 快捷键 | `electron/main/ai/keyhook.ts`（新增） | uiohook-napi 全局 keydown/keyup；降级走现有 `registerShortcut` |
| 命令下发 | 复用 `mainWin.webContents.send` | 简单意图直接发既有事件（play/pause/playNext/...）；复杂意图发新 `ai-command` |
| 状态查询 | 复用 `track-info.ts` 模式 | get_current_track / get_playback_status |
| 渲染层执行 | `src/utils/initIpc.ts`（追加）+ 新 `src/services/ai/player-adapter.ts` | 调用 PlayerController 既有公共方法，不复制播放逻辑 |
| 歌曲匹配 | 复用 `localStore.localSongs` + `fuzzySearch` | 加歌手加权过滤 + 归一化 + 歧义确认 |
| 共享类型 | `src/types/shared/ai.ts`（新增） | 主/渲染/前端三处共用 |
| 设置 | `src/components/Setting/config/ai.ts`（新增） | 跟随现有 SettingConfig 体系 |
| 数据 | `userData/ai/`（新增目录） | config.json + 可选 history.db（复用 better-sqlite3）+ cache/ + logs/ |

## G. 需要新增的文件及职责

```text
electron/main/ai/
├─ index.ts               # AIOrchestrator：录音→ASR→意图→执行 状态机与总装
├─ ai-config.ts           # userData/ai/config.json 读写、默认值、迁移
├─ keyhook.ts             # F8 全局按下/松开（uiohook-napi），失败降级为 globalShortcut 切换模式
├─ audio-buffer.ts        # 渲染层 PCM 分片汇聚、16k 单声道 WAV 内存组装、空音频/超长检测
├─ whisper-service.ts     # spawn whisper-cli.exe（子进程，不阻塞主线程），临时文件写读删
├─ ollama-client.ts       # /api/tags、/api/chat（format=json、temperature、超时、中断、重试）
├─ intent-parser.ts       # 意图 JSON 白名单解析 + 参数校验 + 异常输出修复重试
├─ command-dispatcher.ts  # 意图→渲染命令映射；简单意图走既有通道，复杂走 ai-command
└─ ai-history.ts          # 可选 SQLite 历史（独立 history.db，可关闭，绝不存原始录音）

electron/main/ipc/ipc-ai.ts    # ai-start/stop/status/settings/test-connection + mic-audio-chunk 接收
electron/preload/api/ai.ts     # window.ai 白名单桥（startCapture/stopCapture/onStatus/getSettings/...）

src/services/ai/
├─ mic-capture.ts        # getUserMedia + AudioWorklet 降采样 16k 单声道，分片 IPC 上送
└─ player-adapter.ts     # 监听 ai-command → PlayerController 既有方法；歌曲匹配（复用 fuzzySearch）

src/stores/ai.ts                  # AI 状态镜像（idle/recording/.../error、识别文本、结果、历史）
src/types/shared/ai.ts            # 意图/参数/状态/事件类型（主、渲染共享）
src/components/Setting/config/ai.ts  # AI 设置分区（基础/语音/模型/指令/隐私）
src/components/Modal/AI/AiPanel.vue  # AI 助手面板（状态/文本/结果/历史）
```

新增运行时依赖仅 1 个：`uiohook-napi`（全局键盘按下/松开事件，自带 win32-x64 预编译二进制，约数 MB；用途与必要性：globalShortcut 无 keyup，这是按住说话的前提；设置中可整体关闭，关闭后走 globalShortcut 切换模式）。其余全部复用现有依赖（HTTP 用全局 fetch、SQLite 用 better-sqlite3、子进程用 node:child_process）。

## H. 技术实施方案

```text
F8 按下(uiohook, 主进程)
 → main 发 "ai-voice-start" → 渲染层 mic-capture 启动 getUserMedia
    （窗口可隐藏在托盘，渲染进程持续存活，不抢焦点、不显示窗口）
 → AudioWorklet 降采样 16k/单声道 PCM，经 IPC 分片上送主进程内存缓冲
F8 松开
 → 渲染层停止采集 → 主进程组装 WAV（内存，写临时文件供 whisper 读取）
 → spawn whisper-cli.exe（-m 用户模型 -l zh -f temp.wav --output-json）→ 得到文本 → 删除临时文件
 → OllamaClient /api/chat（Qwen2.5，format:"json"，system prompt 给定意图 schema，temperature 0.1，超时可配）
 → intent-parser 白名单校验（intent 枚举 + 参数类型/范围）；解析失败带错误信息重试 1 次
 → CommandDispatcher
    ├─ 简单意图（pause/resume/next/previous/set_volume/stop/shuffle/repeat...）
    │    → 直接 webContents.send 既有事件，渲染层 initIpc 已有处理
    ├─ 复杂意图（play_music/play_artist/play_playlist/search_music/recommend_music）
    │    → webContents.send("ai-command", cmd) → player-adapter：
    │      localStore.localSongs + fuzzySearch 匹配 → 唯一命中 playSong 播放；
    │      多命中按设置（自动播最匹配 / 弹出确认列表）；未命中明确回执
    └─ 查询意图（get_current_track/get_playback_status）→ track-info 模式回查
 → 全程状态经 "ai-status" 单通道推送（idle/recording/processing/recognizing/thinking/executing/completed/error）
```

安全边界：意图白名单枚举、参数 TypeScript 校验、音量 clamp 0-100、模型输出永不拼接命令/SQL/eval、渲染层不接触文件系统与 Ollama（全在主进程）、临时音频用后即删、历史记录默认关闭原始文本存储可清空。

## I. 兼容性问题与对策

1. **无 Rust 工具链**：按「零 Rust 版」实施（getUserMedia + uiohook-napi + whisper-cli.exe）。后续装好 Rust 后，可将采集替换为 `native/audio-capture`（cpal + napi），接口不变。
2. **Ollama 当前未运行**（连接被拒）：功能上线前需启动；设置页提供连接测试，未连接时 AI 面板显示明确错误，SPlayer 原有功能零影响。
3. **globalShortcut 无松开事件**：按住说话依赖 uiohook-napi；若其被安全软件拦截或用户关闭，降级为「单击开始/再击结束」切换模式。
4. **uiohook-napi 全局钩子**：新依赖需说明（见 G）；打包无需额外配置（预编译二进制随依赖分发）。
5. **Whisper 部署**：需用户下载 whisper.cpp Windows 版 `whisper-cli.exe` 与 ggml 模型（base≈148MB / small≈488MB / medium≈1.5GB）；中文效果建议 small 起步；识别延迟 CPU 上约数秒，与音频时长成正比。程序与模型路径均由用户配置，不打入安装包。
6. **Qwen 小模型 JSON 服从性**：`format:"json"` + 低温度 + schema 化 system prompt + 1 次修复重试兜底；仍失败则回 `unknown` 意图并提示。
7. **事件名冲突**：新通道统一 `ai-` 前缀；简单意图复用的既有事件名与现有快捷键共用，无新增冲突面。
8. **构建门禁**：全程保持 `pnpm lint / typecheck / SKIP_NATIVE_BUILD=true pnpm build / electron-builder --config` 通过；AI 关闭时不占用麦克风/CPU/内存（模块懒初始化，默认关闭）。

## J. 分阶段开发顺序与预计工作量

| 阶段 | 内容 | 预计 |
|---|---|---|
| 2 技术验证 | Ollama 连通 + Qwen JSON 输出实测；uiohook F8 down/up 实测；getUserMedia 后台录音实测；whisper-cli 样例音频中文识别实测 | 0.5–1 天 |
| 3 AI 基础模块 | shared 类型、ai-config、ollama-client、intent-parser、command-dispatcher、ipc-ai、日志 | 1 天 |
| 4 语音链路 | keyhook、mic-capture、whisper-service、状态机、临时文件管理 | 1 天 |
| 5 播放器集成 | player-adapter、歌曲匹配与歧义策略、查询意图、与 initIpc 打通 | 0.5–1 天 |
| 6 UI | AI 面板、设置五分区、菜单入口 | 1–1.5 天 |
| 7 测试与交付 | 单测（parser/dispatcher/匹配/音量）、任务书场景 1–9、lint/typecheck/build/打包、文档与交接更新 | 1 天 |

合计约 **5–7 个工作会话**；可选 Rust 原生采集增强（需先安装 Rust 工具链）另计 1–2 天。

---

**等待确认后再进入阶段二（技术验证）。本文档确认后随首阶段代码一并归档或按需删除。**
