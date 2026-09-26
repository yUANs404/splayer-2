# SPlayer 2 本地版 — 会话交接记忆

> 用途：新会话开始时先阅读本文件，再查看 `git log` 和工作区状态，即可恢复当前项目上下文。
> 更新时间：2026-09-25

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

按时间倒序：

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

## 8. 新会话建议启动流程

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
