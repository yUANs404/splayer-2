/**
 * @fileoverview AI 语音助手的主/渲染共享类型与 IPC 频道常量
 */

/** 支持的指令意图白名单 */
export type AiIntent =
  | "play_music"
  | "play_artist"
  | "play_playlist"
  | "search_music"
  | "pause"
  | "resume"
  | "next"
  | "previous"
  | "set_volume"
  | "volume_up"
  | "volume_down"
  | "get_current_track"
  | "get_playback_status"
  | "shuffle"
  | "repeat"
  | "stop"
  | "recommend_music"
  | "unknown";

/** 指令参数（按意图取用，统一在此校验） */
export interface AiCommandParameters {
  /** 歌曲名 */
  song_name?: string;
  /** 歌手名 */
  artist?: string;
  /** 歌单名 */
  name?: string;
  /** 搜索关键词 */
  keyword?: string;
  /** 音量 0-100 */
  volume?: number;
  /** 随机开关 */
  enable?: boolean;
  /** 循环模式 */
  mode?: "off" | "list" | "one";
  /** 心情描述 */
  mood?: string;
  /** 场景描述 */
  scene?: string;
  /** 曲库召回的歌曲 id（主进程终裁后附带，渲染层可直接精确命中） */
  track_id?: string;
}

/** 大模型解析出的结构化指令 */
export interface AiCommand {
  intent: AiIntent;
  parameters: AiCommandParameters;
  /** 模型生成的简短回复 */
  reply: string;
  /** 语音识别原文 */
  rawText?: string;
}

/** AI 助手状态机状态 */
export type AiState =
  | "idle"
  | "recording"
  | "processing"
  | "recognizing"
  | "thinking"
  | "executing"
  | "completed"
  | "confirm"
  | "error";

/** 歧义确认的候选歌曲（精简结构供 UI 选择） */
export interface AiCandidateOption {
  id: string;
  title: string;
  artist: string;
}

/** 状态推送事件 */
export interface AiStatusEvent {
  state: AiState;
  /** 用户可读提示 */
  message?: string;
  /** 语音识别文本 */
  recognizedText?: string;
  /** 解析出的指令 */
  command?: AiCommand;
  /** 执行结果描述 */
  result?: string;
  /** 错误信息 */
  error?: string;
  /** 歧义确认候选（state=confirm 时附带） */
  candidates?: AiCandidateOption[];
  timestamp: number;
}

/** 语音识别引擎：qwen3 = Qwen3-ASR Worker（首选）；whisper = whisper-cli（回退基准） */
export type AsrProvider = "qwen3" | "whisper";

/** 统一语音识别结果（两引擎共用，打点用） */
export interface ASRResult {
  text: string;
  language?: string;
  /** 录音有效时长（毫秒，预处理后） */
  durationMs: number;
  /** 识别推理耗时（毫秒） */
  inferenceMs: number;
  provider: AsrProvider;
  /** 仅引擎真实提供置信度时才有值；当前两引擎均不提供，不伪造 */
  confidence?: number;
  error?: string;
}

/** AI 助手配置 */
export interface AiSettings {
  /** 是否启用 AI 助手 */
  enabled: boolean;
  /** 触发快捷键（虚拟键码名称，如 F8） */
  shortcutKey: string;
  /** 触发模式：按住说话 / 点击切换 */
  triggerMode: "push" | "toggle";
  /** Ollama 服务地址 */
  ollamaBaseUrl: string;
  /** Ollama 模型名 */
  ollamaModel: string;
  /** Ollama 请求超时（毫秒） */
  ollamaTimeoutMs: number;
  /** 模型温度 */
  ollamaTemperature: number;
  /** whisper-cli 可执行文件路径（回退引擎） */
  whisperExePath: string;
  /** whisper 模型文件路径（回退引擎） */
  whisperModelPath: string;
  /** 识别语言 */
  whisperLanguage: string;
  /** 语音识别引擎（qwen3 失败时自动回退 whisper） */
  asrProvider: AsrProvider;
  /** Python 解释器路径（Qwen3-ASR Worker 的 venv python.exe） */
  asrPythonPath: string;
  /** Qwen3-ASR 模型目录 */
  asrModelPath: string;
  /** Qwen3-ASR 单次识别超时（毫秒），超时重启进程并回退 whisper */
  asrTimeoutMs: number;
  /** 最长录音时长（毫秒） */
  maxRecordMs: number;
  /** 多个匹配结果时自动播放最匹配项 */
  autoPlayBestMatch: boolean;
  /** 是否保存指令历史 */
  saveHistory: boolean;
  /** 是否在历史中保存识别文本 */
  saveRecognizedText: boolean;
  /** 录音时自动暂停播放（避免音乐干扰识别，说完自动续播） */
  duckPlayback: boolean;
}

/** AI 历史条目 */
export interface AiHistoryEntry {
  id: string;
  time: number;
  /** 识别文本（受 saveRecognizedText 控制） */
  text: string;
  command: AiCommand | null;
  /** 执行结果描述 */
  result: string;
  success: boolean;
}

/** Ollama 连接测试结果 */
export interface AiOllamaStatus {
  ok: boolean;
  version?: string;
  models?: string[];
  error?: string;
}

/** 指令执行结果 */
export interface AiExecuteResult {
  success: boolean;
  message: string;
  data?: unknown;
}

/** AI 相关 IPC 频道常量 */
export const AI_IPC_CHANNELS = {
  /** 主进程 → 渲染层：状态推送 */
  STATUS: "ai-status",
  /** 主进程 → 渲染层：播放指令（复杂意图） */
  COMMAND: "ai-command",
  /** 渲染层 → 主进程：读取设置 */
  GET_SETTINGS: "ai-get-settings",
  /** 渲染层 → 主进程：更新设置 */
  UPDATE_SETTINGS: "ai-update-settings",
  /** 渲染层 → 主进程：测试 Ollama 连接 */
  TEST_OLLAMA: "ai-test-ollama",
  /** 渲染层 → 主进程：获取模型列表 */
  LIST_MODELS: "ai-list-models",
  /** 渲染层 → 主进程：查询当前状态 */
  GET_STATUS: "ai-get-status",
  /** 渲染层 → 主进程：提交文本走完整管线（调试/无麦克风场景） */
  SUBMIT_TEXT: "ai-submit-text",
  /** 渲染层 → 主进程：读取历史 */
  GET_HISTORY: "ai-get-history",
  /** 渲染层 → 主进程：清空历史 */
  CLEAR_HISTORY: "ai-clear-history",
  /** 渲染层 → 主进程：回执播放器适配层执行结果 */
  REPORT_RESULT: "ai-report-result",
  /** 渲染层 → 主进程：上报歧义候选（由面板确认） */
  AMBIGUOUS: "ai-ambiguous",
  /** 渲染层 → 主进程：播放指定歌曲（面板选择后） */
  PLAY_TRACK: "ai-play-track",
  /** 渲染层 → 主进程：查询 ASR Worker 状态（设置页展示） */
  ASR_STATUS: "ai-asr-status",
  /** 渲染层 → 主进程：注入 WAV 走完整识别管线（开发/性能测试用，音频仅进内存） */
  DEV_INJECT: "ai-dev-inject",
  /** 主进程 → 渲染层：开始麦克风采集 */
  MIC_START: "ai-mic-start",
  /** 主进程 → 渲染层：停止麦克风采集 */
  MIC_STOP: "ai-mic-stop",
  /** 渲染层 → 主进程：麦克风 PCM 分片上送 */
  MIC_CHUNK: "ai-mic-chunk",
  /** 主进程 → 渲染层：录音开始，请静音播放 */
  DUCK_START: "ai-duck-start",
  /** 主进程 → 渲染层：录音结束，恢复播放 */
  DUCK_END: "ai-duck-end",
} as const;

/** AI 默认配置 */
export const AI_DEFAULT_SETTINGS: AiSettings = {
  enabled: false,
  shortcutKey: "F8",
  triggerMode: "push",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  ollamaModel: "qwen2.5:7b",
  ollamaTimeoutMs: 60000,
  ollamaTemperature: 0.1,
  whisperExePath: "",
  whisperModelPath: "",
  whisperLanguage: "zh",
  asrProvider: "qwen3",
  asrPythonPath: "",
  asrModelPath: "",
  asrTimeoutMs: 15000,
  maxRecordMs: 15000,
  autoPlayBestMatch: true,
  saveHistory: true,
  saveRecognizedText: false,
  duckPlayback: true,
};
