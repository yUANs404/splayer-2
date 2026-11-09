# SPlayer 2 本地版 — 会话交接记忆

> 用途：新会话开始时先阅读本文件，再查看 `git log` 和工作区状态，即可恢复当前项目上下文。
> 更新时间：2026-11-08 深夜（**AI 低延迟优化完成**，快照见第 11 节——新会话**优先读第 11 节**；语音助手 v1 背景见第 10 节）

## 1. 当前仓库与分支

- 本地目录：`E:/Zcode/Zcode项目6/Splayer修改/SPlayer`
- 当前分支：`main`
- 主仓库：`origin = https://github.com/yUANs404/splayer-2.git`
- 上游仓库：`upstream = https://github.com/SPlayer-Dev/SPlayer.git`
- 旧 fork：`fork = https://github.com/yUANs404/SPlayer-1.git`
- GitHub 主仓库：https://github.com/yUANs404/splayer-2
- 默认分支：`main`
- 发布页：https://github.com/yUANs404/splayer-2/releases/tag/v3.1.1-local.1
- 当前工作区在本次交接写入前应保持干净；如果有未提交变更，先执行 `git status -sb` 判断是否来自新任务。

## 2. 项目目标

这是基于 SPlayer 3.1.1（上游 `dev` 分支，基线 commit `40d9ec60`）的纯本地版：

- 只播放本地文件路径（`song.path -> file://`）
- 保留本地音乐库、SQLite 曲库、本地歌单、播放队列、播放控制、歌词、封面、小窗/全屏、桌面歌词、任务栏歌词、系统媒体控制、托盘、快捷键、WebSocket 局域网遥控和 `/api/control` 本地控制 API
- 已彻底移除在线音乐功能、账号登录、搜索、推荐、在线歌单、评论、MV、解灰、Last.fm、在线歌词、流媒体和在线下载
- 协议：AGPL-3.0，`LICENSE` 原样保留；作者/上游致谢保留

## 3. 已完成的主要修改

### UI / 路由

- 删除在线路由与页面：搜索、发现、歌手、专辑、MV、百科、评论、播客、云盘、每日推荐、收藏、流媒体、在线下载等。
- `src/router/routes.ts` 只保留首页、本地歌单、本地音乐库、最近播放、状态页、桌面歌词。
- `src/components/Layout/Menu.vue` 改为本地菜单：首页、音乐库、专辑、艺术家、最近播放、本地歌单。
- 删除顶部搜索框和用户菜单。
- `HomeLocal.vue` 不再是占位符，改为本地统计卡片 + 本地歌单首页。
- `views/List/playlist.vue` 重写为纯本地歌单详情。
- 播放器移除喜欢、评论、下载、MV、在线音质、在线音源、动态封面、私人 FM 等入口。

### API / 服务

删除：

- `src/api/album.ts`
- `artist.ts`
- `cloud.ts`
- `comment.ts`
- `lastfm.ts`
- `login.ts`
- `playlist.ts`
- `qqmusic.ts`
- `radio.ts`
- `rec.ts`
- `search.ts`
- `song.ts`
- `user.ts`
- `video.ts`
- `src/api/streaming/`
- `electron/server/netease/`
- `electron/server/unblock/`
- `electron/server/qqmusic/`

保留：

- `src/api/other.ts` 仅用于 GitHub 更新日志，已改用原生 `fetch`，不再依赖 axios。
- `electron/server/control/`：这是本地播放遥控 API，必须保留。
- `electron/server/index.ts` 只注册 ControlAPI 和生产静态文件服务。

### 状态层与设置

- `data` store 只保留 `playList`、`originalPlayList`、`historyList`。
- `music` store 删除 `personalFM`、`dailySongsData`。
- `status` store 删除在线音源、解灰、评论、TTML/QRC 在线状态、私人 FM、心动模式。
- 删除 `stores/streaming.ts`、`types/streaming.ts`。
- `setting.ts` 删除约 45 个在线设置键：在线开关、搜索、分享链接、解灰、在线歌词、网络代理、Last.fm、流媒体、在线下载、云盘/评论/首页在线栏目等。
- `settingMigrations.ts` 当前 schema 为 v13，启动时会清理旧在线设置残留键。
- `SidebarHideManager`、`FullscreenPlayerManager`、`ContextMenuManager`、`CoverManager` 均已改为本地键。

### 核心播放与歌词

- `SongManager.getAudioSource()`：仅支持 `song.path`，检查本地文件存在后返回 `toFileUrl(song.path)`；没有 `path` 的历史在线歌曲会返回空源并被 PlayerController 自动跳过，不会崩溃。
- 删除官方 URL 获取、解灰 URL、在线缓存、私人 FM、心动模式。
- `LyricManager` 只处理：音频内嵌歌词、本地歌词目录覆盖、本地歌词缓存、OpenCC 简繁转换。
- `PlayModeManager` 只保留列表/单曲循环和普通随机。
- `AutomixManager` 删除在线音频缓存逻辑，只处理本地音频分析。
- `PlayerController` 删除 Last.fm、喜欢同步、在线重试；非本地歌曲播放失败直接跳过。

### 主进程 / IPC

- 删除登录窗口、orpheus 协议处理、协议 IPC、音乐缓存服务、下载服务、在线服务器。
- 保留窗口、托盘、桌面歌词、任务栏歌词、SMTC/MPRIS、WebSocket、文件/本地音乐 IPC、ControlAPI。
- 删除托盘“我喜欢”菜单与喜欢状态 IPC。
- 删除网络代理 IPC 和 electron-store 中的在线代理/AMLL/下载字段。
- **新增本地扫描 JS 回退**：`electron/main/services/LocalMusicService.ts` 在 `tools.node` 不存在时使用 Node.js + `music-metadata` 扫描目录；支持音频扩展名、封面、mtime/size 增量、批量同步、已删除路径清理。
- **删除 `font-list`**：`get-all-fonts` IPC 改为扫描系统字体目录，解决发行包中 `font-list` 的 `./libs/core` 缺失问题。
- **复制发行版启动修复**：主进程和 preload 依赖直接内置打包；`.npmrc` 使用 `node-linker=hoisted`；删除 `font-list`，避免复制到其他目录后依赖开发目录或 `font-list/libs/core`。
- **便携版 SQLite 扫描修复（最新）**：主进程保留 `better-sqlite3` 为外部依赖，避免 Rollup 将其原生模块的动态 `require` 替换为报错桩；Electron Builder 会将 `better_sqlite3.node` 放入 `app.asar.unpacked/node_modules/better-sqlite3/build/Release/`。
- 已验证：将 `dist/win-unpacked` 复制到桌面新目录后，主进程正常启动；原生 `.node` 缺失只产生预期降级日志，不会导致主进程异常；重新打包后 SQLite 原生二进制存在且主进程代码不再包含 `Could not dynamically require` 报错桩。

### 构建 / 依赖 / CI

- 删除在线依赖：`@neteasecloudmusicapienhanced/api`、axios、axios-retry、js-cookie、md5、plyr、change-case、file-saver、crypto-js 及相关 types。
- 删除 Docker/nginx/vercel 在线部署文件和 Docker 发布工作流。
- `electron-builder.config.ts` 删除 orpheus 协议注册。
- `.npmrc` 增加：`node-linker=hoisted`。
- `electron.vite.config.ts`：
  - `main.build.externalizeDeps = false`
  - `preload.build.externalizeDeps = false`
  - 目的：主进程/preload 依赖直接打入 bundle，避免复制版或便携版从开发目录解析依赖。
- `.github/workflows/release.yml`：
  - 只构建 Windows x64
  - 不构建 macOS/Linux/Windows arm64
  - 直接调用 `electron-builder --win --config electron-builder.config.ts --x64 --publish never`
  - tag 发布时创建 Draft Release
  - 手动运行只构建 Artifact
  - 已删除 `.github/workflows/docker.yml`
- 最新 CI 手动构建成功过一次：run `36131308605`，Artifact 名为 `SPlayer-Windows-x64`。

## 4. 最新关键提交

按时间倒序（新会话先以 `git log --oneline -12` 为准）：

- `eeee73bb` 添加本交接文档（上一轮快照）
- `14d28262` 修复复制发行版的主进程依赖与字体模块加载
- `7c1d65f9` 主进程/preload 依赖内置打包
- `b5234388` 修复 electron-builder 隐式发布，显式 `--publish never`
- `4f3d4365` CI 只构建 Windows x64，删除 Docker 发布工作流
- `2b674c51` 新仓库 README 本地版重写
- `033873be` 新增 `LOCAL-EDITION.md`
- `3b001503` 解除 FFmpeg 引擎跨源隔离门槛
- `e4fdc936` 原生扫描器缺失时 JS 回退
- `974868c4` 清理在线死代码
- `8eccfb74` 清理在线依赖和网页部署配置
- `7a5d0f5f` 清理主进程在线服务
- `e067a011` 核心播放仅本地源
- `ed2c6d5e` 清理在线状态层
- `f866bcb6` 删除在线 API
- `ada81d70` 删除在线 UI

## 5. 已验证的命令

本机使用便携 Node 22：

```bash
export PATH="/e/Zcode/Zcode项目6/Splayer修改/tools/node22/node-v22.23.3-win-x64:$PATH"
cd "E:/Zcode/Zcode项目6/Splayer修改/SPlayer"
```

已通过：

```bash
pnpm install
pnpm lint
pnpm typecheck
SKIP_NATIVE_BUILD=true pnpm build
SKIP_NATIVE_BUILD=true npx electron-builder --win --config electron-builder.config.ts
```

说明：本机没有 Rust 工具链，所以用 `SKIP_NATIVE_BUILD=true` 验证；发行包中的任务栏歌词、SMTC/MPRIS 原生模块会缺失，但 JS 扫描回退和本地播放仍可用。

## 6. 当前本地发行包

当前构建目录：

```text
E:/Zcode/Zcode项目6/Splayer修改/SPlayer/dist/
```

典型文件：

- `SPlayer-3.1.1-x64-setup.exe`
- `SPlayer-3.1.1-x64-portable.exe`
- `win-unpacked/SPlayer.exe`

GitHub Release：

- `https://github.com/yUANs404/splayer-2/releases/tag/v3.1.1-local.1`

## 7. 已知问题与排坑记录

### A. 复制版启动报 `Cannot find package '@electron-toolkit/utils'`

原因：electron-vite 外置了主进程依赖，开发目录可从 node_modules 解析，复制版不能。

修复：`externalizeDeps=false` + `.npmrc node-linker=hoisted`，并重新安装依赖、重新打包。不要继续使用修复前的旧 exe。

### B. 复制版启动报 `Cannot find module './libs/core'`

原因：`font-list` 的内部相对模块在发行包中丢失。

修复：删除 `font-list`，改用系统字体目录扫描。不要恢复该依赖。

### C. 本地曲库报 `scanMusicLibrary` 为 null

原因：Rust 的 `tools.node` 没有编译；上游没有空值保护。

修复：`LocalMusicService` 加 JS 扫描回退。原生模块存在时仍优先使用 Rust 扫描。

### D. 周杰伦部分本地 FLAC 播放不了

不是网易云版权问题，而是这批 FLAC Chromium 原生解码失败。FFmpeg 引擎可解码。

修复：移除 FFmpeg 引擎的跨源隔离门槛，因为本地 `file://` 路径走 WORKERFS 整文件解码，不依赖 SharedArrayBuffer。使用时在设置中选择：

```text
设置 → 播放设置 → 音频处理引擎 → FFmpeg
```

实测“晴天”“一路向北”“七里香”等原先失败歌曲均已播放成功。

### E. electron-builder CI 失败并报 GitHub Token 403

原因：CI 中 `GH_TOKEN` 触发 electron-builder 隐式发布，但 build job 没有发布权限。

修复：直接调用 `electron-builder --publish never`，不让构建 job 自动发布；Release 由单独 release job 处理。

### F. 手动测试时路径转义错误

Windows 路径通过多层 shell/JS 字符串传递时，反斜杠可能被吃掉，例如：

```text
E:ZcodeZcode项目6Splayer修改\testmusic
```

这不是应用问题。测试脚本中优先使用正斜杠：

```text
E:/Zcode/Zcode项目6/Splayer修改/testmusic
```

## 8. 当前任务进度快照

### 已完成

- [x] Fork 上游仓库并建立独立工作分支
- [x] 完成在线功能影响面扫描
- [x] 删除在线 UI、路由、页面、弹窗和菜单入口
- [x] 删除网易云/解灰/QQ 音乐/Last.fm/流媒体 API
- [x] 清理 Pinia store、在线设置、登录/收藏/云盘/下载/私人 FM/心动模式
- [x] 播放内核限制为本地 `path -> file://`，历史在线歌曲自动跳过
- [x] 保留本地播放、歌词、封面、歌单、窗口、托盘、任务栏歌词、系统媒体控制接口
- [x] 删除主进程在线服务器、登录窗口、协议唤起、代理 IPC、在线缓存/下载服务
- [x] 删除在线依赖和 Docker/网页在线部署链
- [x] 新建 `splayer-2` 仓库并将当前版本设为 `main`
- [x] 重写本地版 README 与 `LOCAL-EDITION.md`
- [x] CI 改为只构建 Windows x64，禁用 Docker 发布和 electron-builder 自动发布
- [x] 修复本地扫描器：缺少 Rust `tools.node` 时使用 JS 回退扫描
- [x] 修复 FFmpeg 引擎隔离门槛，部分特殊 FLAC 已验证可播放
- [x] 修复复制发行版缺少主进程/preload 依赖的问题
- [x] 删除 `font-list`，改用系统字体目录扫描，修复 `./libs/core` 启动错误
- [x] 修复便携版扫描目录时报 `Could not dynamically require ... better_sqlite3.node`：外置 `better-sqlite3` 并重新生成 Windows 安装版/便携版

### 已验证

- [x] `pnpm install`
- [x] `pnpm lint`：0 错误、0 警告
- [x] `pnpm typecheck`：node + web 均通过
- [x] `SKIP_NATIVE_BUILD=true pnpm build`
- [x] `electron-builder --win --config electron-builder.config.ts`
- [x] 解包版复制到桌面新目录后可启动，依赖不再从开发目录解析
- [x] JS 回退扫描能把本地文件写入 SQLite 曲库并显示在音乐库
- [x] 本地 WAV 播放、暂停、恢复、进度、Control API 已验证
- [x] 周杰伦特殊 FLAC：切换 FFmpeg 后“晴天 / 一路向北 / 七里香”均已播放成功
- [x] CDP 网络监控：播放和本地页面期间无外部请求
- [x] GitHub Actions Windows x64 手动构建成功（run `36131308605`）

### 当前已完成的最新修复

- `14d28262`：修复复制发行版的主进程依赖与字体模块加载
- `eeee73bb`：添加上一轮会话交接文档
- `89dad63e`：更新本交接文档至依赖修复状态

### 仍需人工确认或后续工作

- [ ] 在有 Rust 工具链的机器上重新构建并验证任务栏歌词、Windows SMTC、Rust 原生扫描器
- [ ] 在真实朋友设备上测试安装版和便携版（尤其是杀毒软件/临时目录环境）
- [ ] 如果需要正式 CI Release，可推送新的 `v3.1.1-local.2` 标签；当前 `v3.1.1-local.1` 已存在，不要覆盖已发布 Release
- [ ] 可选：清理用户本地设置中已删除的测试目录（例如旧的 `testmusic` 路径）
- [ ] 可选：进一步验证 portable 在所有 Windows 用户环境下的首次自解压启动行为
- [ ] 使用新生成的 `dist/SPlayer-3.1.1-x64-portable.exe` 在真实便携版环境中选择本地音乐目录，确认扫描结果和封面写入

## 10. AI 语音助手 — 交接快照（2026-11-08 晚，交接给下一次会话）

> **一句话状态**：功能开发全部完成（7 个阶段 + 4 轮可用性增强），门禁全绿（lint/typecheck/test:ai 24/24/build/pack），双安装包已出。**待办核心 = 用户用最新构建做真人语音实测**（薛之谦/周杰伦案例），已修复的"谐音改判/部分歌手名/远场增益"三项尚未经真人确认。

### 10.1 运行入口与版本对齐（⚠️ 最高频踩坑）

- **唯一正确入口**：`dist/win-unpacked/SPlayer.exe`（我每轮构建后自动启动的就是它）或重装最新 `dist/SPlayer-3.1.1-x64-setup.exe`
- 用户多次启动旧 exe（桌面快捷方式/旧安装目录）导致"修复失效"假象；判断版本：设置 → AI 语音助手有「录音时自动暂停播放」开关 + 日志无 `�` 且「大碗」能召回
- win-unpacked/安装版 userData = `%APPDATA%\Splayer`；便携版 = `dist\UserData`（两套配置独立）

### 10.2 当前配置（用户已生效，无需重配）

- 音频引擎：CUDA whisper-cli（`../ai-tools/whisper-cuda/bin/Release/whisper-cli.exe`）+ ggml-large-v3-turbo（`../ai-tools/whisper-cuda/models/`，1.6GB）；RTX 4060 加速下 1.7s
- Ollama：qwen2.5:7b（`http://127.0.0.1:11434`）
- `autoPlayBestMatch: true`（歧义自动播最匹配，已写进用户 config）；`duckPlayback: true`（录音自动暂停/续播）
- 曲库：231 首（`%APPDATA%\Splayer\DataCache\local-data\library.db`，含晴天/大碗宽面×2/绅士/逆光/反方向的钟等）

### 10.3 架构与关键文件

```text
electron/main/ai/          编排核心
├─ index.ts                AiService：状态机、录音会话、曲库终裁（含意图改判）、onExecutionResult/onAmbiguous/playTrack
├─ song-recall.ts          曲库召回：字面+全拼+首字母三通道、ARTIST_ALIASES 昵称表、dedupeRepeats、buildWhisperPrompt
├─ whisper-service.ts      spawn whisper-cli（⚠️ Buffer.concat 一次性解码；⚠️ cwd=exeDir+相对模型路径）
├─ keyhook.ts              uiohook-napi 按住模式（DOWN 防抖）+ globalShortcut 切换模式降级
├─ audio-buffer.ts         静音裁剪(-48dBFS) + 峰值归一化(-6dBFS, ≤+28dB) + 有效语音校验(≥350ms)
├─ intent-parser.ts        意图白名单解析（零 electron 依赖，可单测）
├─ ollama-client.ts        /api/chat JSON 模式
└─ ai-config.ts            userData/ai/config.json
electron/main/ipc/ipc-ai.ts        全部 ai-* 通道（含 AMBIGUOUS/PLAY_TRACK/MIC_CHUNK/REPORT_RESULT）
src/services/ai/mic-capture.ts     getUserMedia→16k Int16 分片（AGC/NS 开、EC 关）
src/services/ai/player-adapter.ts  ai-command 执行 + 歧义上报 + track_id 精确播放
src/stores/ai.ts、src/components/Modal/AI/AiPanel.vue（候选按钮）、Setting/config/ai.ts
src/types/shared/ai.ts             全部共享类型/频道/默认值
scripts/test-ai.ts                 pnpm test:ai（24 项）
```

数据流：F8 按下→DUCK_START(暂停音乐)→getUserMedia 分片上送→内存缓冲→松开→DUCK_END(续播)→裁剪/归一化→spawn whisper→文本→Qwen 解析意图→**曲库召回 Top12→Qwen 终裁（可改判意图，结果必须命中候选原文）**→分发（简单意图走既有 pause/playNext 等通道；复杂走 ai-command→适配器）→ai-report-result 回执→面板确认按钮（歧义时）。

### 10.4 已验证能力（全部实测）

- 播放/暂停/切歌/音量真实生效；晴天/大碗宽面/反方向的钟/绅士 全链路真实播放
- 错字纠错：「周杰轮的反方向的中」「是之前的歌(=薛之谦)」「周董」均能锁定正确歌曲
- A/B：small 2 处错 vs turbo 全对；CUDA 1.7s
- 远场：裁剪+增益（模拟 -36dB 信号 → 归一到 -6dB）有单测覆盖

### 10.5 全部关键坑（合并清单，按 AI 必读）

1. **spawn 子进程读流禁止逐块 toString**——中文被分块边界切断成 `�`（U+FFFD），曾是"识别乱码"真凶；必须 Buffer.concat 后统一解码
2. **whisper 模型路径必须相对 exe 目录**（cwd=exeDir）：绝对中文路径触发 ggml 动态后端加载崩溃 0xC0000409
3. **uiohook-napi / better-sqlite3 必须在 main.rollupOptions.external**，内联即坏
4. **lcs 是子串不是子序列**（曾致"今天天气怎么样"误召回晴天）
5. **recallText 片段去重**（"大碗"+song_name"大碗" 拼接破坏包含打分）
6. CDP `/json/list` 桌面歌词窗口排在主窗口前，必须按 URL 选 `http://localhost:25884/#/`
7. `pnpm build | tail && next` 管道掩盖退出码；重打包前必须 taskkill SPlayer.exe + sleep 5（否则 rimraf EPERM 出旧产物）
8. 重录音循环（"大碗碗碗碗"）= 音乐混入麦克风 → duckPlayback 已修；dedupeRepeats 兜底
9. 扬声器→麦克风声学回环在本机极弱（峰值 0.049，疑似耳机），自动化语音测试用 submitText 或页面注入 PCM；真人实测为准
10. node 直接 spawn powershell 会卡死（Add-Type），PS 脚本须从 bash 起且带 BOM

### 10.6 调试工具

- `../ai-validation/scripts/`：f8-hold.ps1（注入按住）、f8-speak.ps1（扬声器 TTS+按住）、voice-inject.mjs（PCM 注入）、mic-diag.mjs（麦克风录音诊断）、spawn-repro.mjs、gen-tts*.ps1
- 用户日志：`%APPDATA%\Splayer\logs\`（按 AI 直接读取，用户说"看日志"即可）；AI 行均带 `(ai)` 前缀
- 管线直测（绕过语音）：CDP `await window.ai.submitText('播放晴天')`

### 10.7 待办（下一步）

- [ ] **用户真人实测最新构建**：薛之谦（改判意图）、周杰伦、远场快语速——尚未确认
- [ ] 实测通过后：出正式安装包（当前 dist 下 exe 已是最新，含全部修复）
- [ ] 可选：歧义确认按钮的持久化提示、TTS 语音播报、Rust 原生采集（需装工具链）、ARTIST_ALIASES 扩充
- [ ] 提交代码：当前全部改动未提交（15 修改 + 12 新增），需用户点头后 git 提交

### 10.8 历史轮次归档（细节备查）

- 阶段一~七（分析/验证/基础模块/语音链路/适配层/UI/测试交付）：全部完成，逐阶段实测记录见 git 历史与本文件 git 版本
- 增强轮 1：曲库知识库召回 + CUDA/turbo 模型（A/B：small 2 错 vs turbo 全对）
- 增强轮 2：录音自动暂停 + 复读清洗 + 口语化别名
- 增强轮 3：UTF-8 分块解码 bug 修复（乱码真凶）
- 增强轮 4：召回文本去重 + 歧义确认闭环 + autoPlayBestMatch 默认开
- 增强轮 5：意图改判（薛之谦案例）+ 歌手部分发音匹配 + 远场阈值下调 + 增益归一化



### 11.6 用户反馈修复轮（2026-11-09 凌晨，已验证）

- **play_artist 随机化**：`player-adapter.ts handlePlayArtist` 全部歌曲入列 + 随机一首起播（「播放邓紫棋的歌」→20首入列随机起播，已 E2E 验证）
- **歌手+歌名二次召回**：`song-recall.ts recallCandidatesSmart` 命中歌手时剥离歌手名与「的/歌/首/来/放」再匹配歌名；二次无命中时按剩余片段拼音相似度(≥0.4)挑疑似谐音歌名进候选（「周杰伦的今天」→《晴天》0.5 相似进候选→LLM 终裁选中，E2E 验证）
- **关键坑：expandAliases 会把规范名重复追加**（别名「杰伦」⊂「周杰伦」触发）→ 剥离必须 split/join 全局删除，否则剩余片段残留歌手名使二次召回退回泛匹配
- **终裁提示词重写**：纯歌手请求（「XX的歌」）→ play_artist 不擅自选歌；有歌名线索（含谐音）→ play_music 用候选原文
- 「是之前的歌」类输入现在走 play_artist（全列表随机），不再虚拟点《丑八怪》
- test:ai 32→36 项；36/36 通过

## 9. 新会话建议启动流程

```bash
cd "E:/Zcode/Zcode项目6/Splayer修改/SPlayer"
git status -sb
git remote -v
git log --oneline -8
```

然后阅读本文件。修改后必须至少运行：

```bash
pnpm lint
pnpm typecheck
SKIP_NATIVE_BUILD=true pnpm build
```

需要发行包时：

```bash
SKIP_NATIVE_BUILD=true npx electron-builder --win --config electron-builder.config.ts
```

不要执行没有 `--config electron-builder.config.ts` 的 `npx electron-builder --win`，否则会使用默认配置，只生成默认命名的安装版，不一定生成 portable，也可能触发错误的发布行为。

## 11. AI 低延迟优化 — 交接快照（2026-11-08 深夜，Qwen3-ASR 重构）

> **一句话状态**：任务书 12 阶段全部完成。ASR 换 Qwen3-ASR-0.6B Python 常驻 Worker（热态 445ms，whisper 7.6 倍加速），新增零 LLM 快速通道（普通命令 P50 461ms / P95 612ms），多语言别名引擎打通「播放EXO的咆哮→韩文歌 으르렁」。12/12 语料 E2E 全过、32/32 单测、门禁全绿。**全部改动未提交，待用户点头。**

### 11.1 关键架构变化（相对第 10 节的 v1）

```text
松开 F8 → 预处理 → Qwen3-ASR Worker(GPU常驻) → 三段式管线：
  ① fast-intent.ts   零 LLM 控制规则（暂停/切歌/音量…16句式整句锚定，~0ms）
  ② 高置信曲库直通   recall≥85 且领先15 → track_id 直接播放（~3ms）
  ③ 有候选→单次LLM终裁（省意图解析调用，延迟减半）；无候选→意图解析
  → executeAiCommand（既有渲染层适配器，未改播放系统）
```

- **ASR**：`electron/main/ai/asr-service.ts` 管 Worker 生命周期（spawn/ready/超时杀/崩溃重启/熔断/whisper 回退）；Worker 源码 `ai/asr-worker/asr_worker.py`（stdin/stdout 行式 JSON，WAV base64 传入）
- **别名**：`user-aliases.ts` 读 `%APPDATA%\Splayer\ai\aliases.json`（已种子化 4 首韩文歌）；`song-recall.ts` 新增 别名通道+拉丁缩写模糊(lev≤1)+标题分段（유희 "으르렁 (Growl) (EXO-K Ver.)" 拆 으르렁/growl/exok）
- **打点**：`PerfTrace` 输出 `(ai-perf)` 行；`ai-dev-inject` IPC = 标准化 E2E/性能测试注入通道
- **设置 UI**：引擎选择/Python 路径/模型目录/Worker 状态标签（`Setting/config/ai.ts`）

### 11.2 实测数据（RTX 4060 8GB，12 语料×3轮，dev-inject 注入）

| 指标 | 实测 | whisper-cli 基线 |
|---|---|---|
| ASR 推理 | P50 445ms / P95 623ms | ~3400ms/条（每次 spawn） |
| 普通命令端到端 | **P50 461ms / P95 612ms** | — |
| 歧义命令（1次7B终裁） | P50 1476ms / P95 1769ms | — |
| Worker 峰值显存 | 1802MB（常驻） | — |
| LLM A/B | 7B 热态 1470ms vs 3B 347ms，正确率均 2/3（失败均可接受降级） |

### 11.3 新增关键坑（合并清单）

11. **nagisa/dynet（qwen-asr 依赖链）不能从中文路径读模型** → venv+模型必须 ASCII 路径（E:\aitools\）；已建联接 `E:\SPlayerJ`(仓库) `E:\aitoolsJ`(ai-tools)
12. **Worker 脚本必须 extraResources**（asar 内 Python 读不了）；`electron-builder.config.ts` 已配 ai/asr-worker
13. **`new Uint8Array(atob(b64), mapFn)` 产出全零**（字符串逐字符 ToNumber NaN→0）——上轮 voice-inject.mjs 的注入从未真正成功过；正确写法 `Uint8Array.from(atob(b64), c=>c.charCodeAt(0))`
14. `pnpm build` 会 rimraf dist（electron-builder 产物），打发行包要重新 electron-builder
15. Git Bash 直接 exec 中文路径 exe 会 exit 127（间歇性编码状态）→ 走 ASCII 联接
16. devInjectWav 不能自带 busy 锁（handleRecognizedText 会拒），busy 由后者管理
17. 控制规则必须剥句尾标点（ASR 输出「暂停。」）+ 整句锚定防歌名误判；MIN_VOICED_MS 400→200（短命令仅 264ms 浊音）

### 11.4 待办

- [ ] 用户真人实测（同 10.7 三项 + EXO 咆哮案例）
- [ ] 用户点头后 git 提交（改动清单见 11.5）
- [ ] 可选：切 qwen2.5:3b-instruct 为默认消歧模型（热态 347ms，需更多真人语料验证准确率）
- [ ] 可选：OLLAMA_KV_CACHE_TYPE=q8_0 等环境变量（任务书要求未经确认不改用户环境）

### 11.5 本次改动清单（未提交）

新增：`ai/asr-worker/{asr_worker.py,requirements.txt,README.md,setup-windows.ps1}`、`electron/main/ai/{asr-service.ts,fast-intent.ts,user-aliases.ts}`
修改：`electron/main/ai/{index,song-recall,audio-buffer,ollama-client,intent-parser,command-dispatcher}.ts`、`electron/main/ipc/ipc-ai.ts`、`electron/preload/{index.ts,index.d.ts}`、`electron-builder.config.ts`、`src/types/shared/ai.ts`、`src/stores/ai.ts`、`src/components/Setting/config/ai.ts`、`scripts/test-ai.ts`（24→32 项）
工具（仓库外）：`ai-validation/scripts/{dev-inject,inject-only,perf-run,llm-ab-test}.mjs`、`keyinject.py`；`ai-tools/qwen3-asr/tests/*`
