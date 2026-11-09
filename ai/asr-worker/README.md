# SPlayer AI 语音助手 — Qwen3-ASR 低延迟方案部署说明（Windows 11）

## 一、方案总览

```text
F8 按下 → 录音（16k/单声道，录音时自动暂停音乐）
F8 松开 → 静音裁剪+增益归一化 → Qwen3-ASR-0.6B Worker（GPU 常驻，热态 ~445ms）
       → 零 LLM 快速通道：控制指令规则（~0ms）｜曲库高置信直通（~3ms）
       → 仅歧义时调用 Ollama qwen2.5:7b 单次终裁（热态 ~1.1s）
       → 渲染层 PlayerController 真实播放
```

实测（RTX 4060 Laptop 8GB / i7-13700H，TTS 语料 12 条 × 3 轮）：

| 指标 | 实测 | 目标 |
|---|---|---|
| 普通命令松开→播放（零 LLM） | **P50 461ms / P95 612ms** | P50≤1.0s P95≤1.8s ✓ |
| 歧义指令（含 1 次 LLM 终裁） | P50 1476ms / P95 1769ms | 尽量≤3s ✓ |
| ASR 推理 | P50 445ms / P95 623ms | — |
| 本地曲库索引检索 | ~3ms | ≤50ms ✓ |
| whisper-cli 基线（同语料） | ~3400ms/条 | 新方案 **7.6× 加速** |

## 二、环境安装（一次性）

### 1. Python 虚拟环境（路径必须纯 ASCII！）

> ⚠️ 关键坑：qwen-asr 依赖链里的 nagisa/dynet 无法从含中文的路径读取模型文件，
> venv 和模型目录必须放在纯 ASCII 路径（如 `E:\aitools\`）。

```powershell
python -m venv E:\aitools\qwen3-asr\venv
E:\aitools\qwen3-asr\venv\Scripts\python.exe -m pip install -U pip
E:\aitools\qwen3-asr\venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu126
E:\aitools\qwen3-asr\venv\Scripts\python.exe -m pip install -r ai\asr-worker\requirements.txt
```

### 2. 下载模型（ModelScope，国内快）

```powershell
E:\aitools\qwen3-asr\venv\Scripts\modelscope.exe download --model Qwen/Qwen3-ASR-0.6B --local_dir E:\aitools\qwen3-asr\models\Qwen3-ASR-0.6B
```

或 Python API：`from modelscope import snapshot_download; snapshot_download("Qwen/Qwen3-ASR-0.6B", local_dir=...)`

### 3. 应用内配置

`设置 → AI 语音助手 → 语音识别引擎`：
- 识别引擎：Qwen3-ASR（推荐）
- Python 解释器路径：`E:\aitools\qwen3-asr\venv\Scripts\python.exe`
- Qwen3-ASR 模型目录：`E:\aitools\qwen3-asr\models\Qwen3-ASR-0.6B`

Worker 在应用启动时自动后台预热（约 10-13s，只此一次），状态可在设置页查看。

### 4. Ollama（消歧模型，已有则跳过）

```powershell
ollama pull qwen2.5:7b        # 默认（准确率优先）
ollama pull qwen2.5:3b-instruct  # 可选：速度优先（热态 ~350ms vs 7B ~1.4s，准确率相当）
```

模型名在 `设置 → AI 语音助手 → 指令理解模型` 中可切换。

## 三、GPU 显存调度策略（8GB VRAM 实测）

| 模型 | 显存 | 策略 |
|---|---|---|
| Qwen3-ASR-0.6B | ~1.8GB | 应用启动即常驻（ASR 优先级最高） |
| qwen2.5:7b | ~5GB | 仅歧义时按需加载，keep_alive=5m 自动卸载 |
| 桌面/其他应用 | ~3-4.7GB | 两者不同时满载：ASR 常驻 + 7B 按需 |

回退链：Qwen3 Worker 启动失败/超时 → 自动回退 whisper-cli → 两者都不可用才报错；
Ollama 未启动 → 本地规则与曲库检索照常工作（零 LLM 路径不受影响）。
Worker 崩溃自动重启（3 次启动失败熔断 60s，期间走 whisper）。

Ollama 环境变量建议（可选，未默认修改用户环境）：
`OLLAMA_MAX_LOADED_MODELS=1`、`OLLAMA_NUM_PARALLEL=1`、`OLLAMA_KV_CACHE_TYPE=q8_0`。

## 四、多语言与别名

- Qwen3-ASR 支持 30 语种自动检测（中/英/韩/日…），官方支持歌声与带 BGM 音频
- 曲库匹配通道：字面 / 拼音 / 标题分段 / 用户别名 / 拉丁缩写模糊（"X O"→EXO）
- 用户别名文件：`%APPDATA%\Splayer\ai\aliases.json`，示例：

```json
{
  "version": 1,
  "trackAliases": [{ "track": "으르렁", "aliases": ["咆哮", "growl"] }],
  "artistAliases": [{ "artist": "EXO", "aliases": ["XO"] }]
}
```

改完即生效（下次语音指令时自动重建索引）。

## 五、性能测试与调试工具

| 工具 | 位置 | 用途 |
|---|---|---|
| 语料生成 | `ai-tools/qwen3-asr/tests/gen-corpus.ps1` | TTS 生成 16k 测试语料（含「播放EXO的咆哮」） |
| Worker 基准 | `ai-tools/qwen3-asr/tests/bench_local.py` | 模型加载/逐条推理/峰值显存 |
| Worker 协议测试 | `ai-tools/qwen3-asr/tests/test_worker.py` | spawn→ready→transcribe→shutdown |
| 全链路注入 | `ai-validation/scripts/dev-inject.mjs` | WAV→Worker→快速通道/LLM→真实播放 |
| 性能统计 | `ai-validation/scripts/perf-run.mjs` | N 轮全语料 P50/P95（读 ai-perf 日志） |
| LLM A/B | `ai-validation/scripts/llm-ab-test.mjs` | 7B vs 3B 消歧延迟/正确率 |
| whisper 基线 | `ai-tools/qwen3-asr/tests/whisper-baseline.sh` | 同语料 whisper-cli 对照 |

延迟打点：日志 `(ai-perf)` 行，如
`(ai-perf) prep=0ms asr(qwen3:Chinese)=445ms recall_fast=3ms dispatch=1ms total=446ms | fast:recall "播放晴天。"`

## 六、已知限制

1. 韩文歌的中文译名需在 `aliases.json` 中配置（无在线翻译，纯本地）
2. 「只听清歌手名」时播放该歌手全部歌曲（LLM 终裁如实告知）
3. Worker 冷启动 10-13s 仅发生在应用启动后台，不阻塞首次语音指令（预热中首条指令自动走 whisper）
4. 本机扬声器→麦克风声学回环极弱，自动化测试用 dev-inject 注入，真人实测为准
