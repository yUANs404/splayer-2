<div align="center">
<img alt="logo" height="100" width="100" src="public/icons/favicon.png" />
<h2>SPlayer 2 · 本地版</h2>
<p>一个纯本地音乐播放器 —— 无登录、无联网、无推荐，只播放你硬盘里的歌</p>

[![License](https://img.shields.io/badge/License-AGPL_3.0-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/Version-3.2.0--ai-orange.svg)](../../releases)
[![基于 SPlayer](https://img.shields.io/badge/基于-SPlayer_3.1.1-4c8bf5.svg)](https://github.com/SPlayer-Dev/SPlayer)

[下载发行版](../../releases) · [移除清单](./LOCAL-EDITION.md) · [AI 部署指南](./ai/asr-worker/README.md) · [上游项目](https://github.com/SPlayer-Dev/SPlayer)

</div>

---

## 这是什么

基于 [SPlayer](https://github.com/SPlayer-Dev/SPlayer)（v3.1.1，AGPL-3.0，作者 imsyy）深度裁剪的**纯本地音乐播放器**。

原版 SPlayer 是一款优秀的网易云音乐客户端；本版本在其 Electron + Vue 3 架构上**彻底移除了全部在线音乐服务**——没有网易云 API、没有登录、没有搜索、没有推荐、没有评论，也不会发出任何在线音乐请求（已实测断网全功能可用）。

**适合谁**：手里有本地音乐文件（MP3 / FLAC 等），想要一个界面好看、歌词封面齐全、没有任何联网行为的桌面播放器。

## 功能

- **本地音乐库**：目录管理、递归扫描、专辑 / 艺术家 / 文件夹视图、模糊搜索
- **完整播放控制**：播放 / 暂停 / 切歌 / 进度 / 音量 / 倍速 / 循环 / 随机
- **音效**：10 段均衡器、AB 循环、自动关闭、音乐渐入渐出、ReplayGain 音量平衡、Automix 自动混音（BPM 对齐 / Smart Cut，Beta）
- **三播放引擎**：Web Audio（默认）/ FFmpeg（解码兼容性最强）/ MPV，一键切换
- **歌词**：内嵌歌词（LRC / YRC / QRC / TTML）+ 本地歌词目录覆盖、逐字歌词、翻译 / 音译、简繁转换、Apple Music-like 歌词界面
- **封面**：内嵌封面自动提取 + 曲库封面缓存
- **系统集成**：任务栏进度、托盘、全局快捷键、桌面歌词、任务栏歌词 *、系统媒体控制 *、Discord RPC
- **本地歌单**：新建 / 编辑 / 拖拽排序 / 批量操作
- **遥控**：局域网 WebSocket 遥控 + 本地 HTTP 控制接口（`/api/control`）
- **个性化**：主题色 / 明暗模式 / 背景图 / 自定义字体 / 自定义 CSS / JS
- **AI 语音助手（3.2.0 新增）**：按住 F8 说话即可点歌 / 控制，全程本地推理，详见下文

<sub>* 任务栏歌词与系统媒体控制（SMTC / MPRIS）需要编译 Rust 原生模块，见下文构建说明。</sub>

## AI 语音助手（v3.2.0）

按住 **F8** 说话，松开即执行：「播放EXO的咆哮」自动映射到韩文歌 `으르렁`，「暂停」「下一首」「调高音量」「周董的歌」等口语指令全部支持。**语音识别与推理全部在本机完成，不上传任何录音，也不依赖任何云端 AI。**

### 工作原理（低延迟架构）

```text
按住 F8 → 录音（同时自动暂停音乐，松开自动续播）
松开 F8 → 静音裁剪 + 增益归一化 → Qwen3-ASR-0.6B（GPU 常驻 Worker，热态 ~0.45s）
       → 零 LLM 快速通道：控制指令规则命中（~0ms）｜曲库高置信直通（~3ms）
       → 仅歧义时才调用 Ollama qwen2.5:7b 单次终裁（热态 ~1.5s）
       → 调用播放器原有接口播放
```

实测（RTX 4060 Laptop 8GB）：普通指令松开到播放 **P50 0.46s / P95 0.61s**，歧义指令 ~1.5-2.5s；识别准确率对比同语料 whisper.cpp 提速 7.6 倍。

### 使用的 AI 模型（全部本地开源权重）

| 模型 | 用途 | 体积 | 是否必需 |
|---|---|---|---|
| [Qwen3-ASR-0.6B](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) | 语音识别（30 语种自动检测，支持歌声/带 BGM） | ~1.8GB | 推荐 |
| `qwen2.5:7b`（Ollama） | 仅歧义指令消歧（歌名谐音改判等） | ~4.7GB | 推荐 |
| `qwen2.5:3b-instruct`（Ollama） | 消歧的低延迟替代（可选切换） | ~1.9GB | 可选 |
| whisper-cli large-v3-turbo（whisper.cpp CUDA） | 备用识别引擎，Qwen3 不可用时自动回退 | ~1.6GB | 可选 |

隐私说明：录音只在内存中处理，识别完成后即丢弃，从不写盘、从不上传；指令历史默认仅存文本且可一键清空。

### 在你的电脑上复用

硬件要求：NVIDIA GPU（4GB+ 显存即可，8GB 体验最佳）、Windows 10/11。完整步骤见 **[ai/asr-worker/README.md](./ai/asr-worker/README.md)**，概要：

1. 一键脚本：`powershell -ExecutionPolicy Bypass -File ai\asr-worker\setup-windows.ps1`（自动创建 Python 虚拟环境、安装 CUDA 版 torch 与 qwen-asr、下载 Qwen3-ASR-0.6B 权重）
2. `ollama pull qwen2.5:7b`
3. 应用内配置：`设置 → AI 语音助手 → 识别引擎选 Qwen3-ASR`，填入 Python 路径与模型目录
4. 不配置 AI 也完全不影响播放器本体——AI 是可选增强，任何组件故障都自动回退或静默降级

## 下载

前往 [Releases](../../releases) 下载：

| 文件 | 说明 |
|---|---|
| `SPlayer-x.x.x-x64-setup.exe` | 安装版（NSIS 安装向导） |
| `SPlayer-x.x.x-x64-portable.exe` | 便携版（单文件，免安装） |

首次启动：同意用户协议 → 设置 → 本地歌曲目录 → 添加你的音乐文件夹 → 等待扫描完成即可播放。

## 与上游的主要差异

完整移除清单见 [LOCAL-EDITION.md](./LOCAL-EDITION.md)，概要：

- **移除**：内嵌网易云 API 服务器、解灰服务、QQ 音乐歌词代理、登录与用户体系、搜索 / 发现 / 电台 / MV / 评论 / 云盘 / 每日推荐等 17 组页面、Last.fm、Subsonic/Jellyfin 流媒体、在线歌词获取、歌曲下载、网页版部署链
- **保留**：本地播放全功能、本地歌词与封面、任务栏歌词、系统媒体控制、桌面歌词、本地歌单、全部本地化设置
- **新增修复**：
  1. 本地扫描器在原生模块缺失时自动回退为 JS 实现（上游会直接崩溃）
  2. 解除 FFmpeg 引擎的跨源隔离门槛（修复部分转码批次 FLAC 无法播放的问题）
  3. 设置迁移 v13：自动清理旧版本的在线残留配置

## 构建

```bash
pnpm install

# 开发模式（未安装 Rust 时跳过原生模块）
SKIP_NATIVE_BUILD=true pnpm dev

# 构建可运行目录版
SKIP_NATIVE_BUILD=true pnpm build:unpack

# 打包 Windows 安装版 + 便携版
SKIP_NATIVE_BUILD=true pnpm build:win
```

> 未安装 Rust 工具链时请加 `SKIP_NATIVE_BUILD=true`（本项目自带的行为）：本地扫描会自动回退为 JS 实现；任务栏歌词与系统媒体控制需要编译 Rust 原生模块后才可用。

## 协议与致谢

- 本项目基于 [SPlayer](https://github.com/SPlayer-Dev/SPlayer)（作者 [imsyy](https://github.com/imsyy)）修改，遵循 **[AGPL-3.0](./LICENSE)** 开源协议
- 依据 AGPL-3.0，本衍生版本同样以 AGPL-3.0 开源，修改内容见 [LOCAL-EDITION.md](./LOCAL-EDITION.md)
- 感谢原项目作者与所有贡献者
