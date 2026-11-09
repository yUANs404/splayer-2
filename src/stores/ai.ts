import { defineStore } from "pinia";
import {
  AI_DEFAULT_SETTINGS,
  type AiHistoryEntry,
  type AiSettings,
  type AiStatusEvent,
} from "@/types/shared";

/** ASR Worker 运行状态（设置页展示） */
export interface AsrWorkerStatus {
  running: boolean;
  ready: boolean;
  loadMs?: number;
  reservedVramMb?: number;
  restarts: number;
  lastError?: string;
  breakerOpen: boolean;
}

interface AiStore {
  /** AI 设置镜像（主进程配置的本地副本） */
  settings: AiSettings;
  /** 最近一次状态事件 */
  status: AiStatusEvent | null;
  /** 指令历史 */
  history: AiHistoryEntry[];
  /** 是否已初始化 */
  inited: boolean;
  /** ASR Worker 状态（设置页按需刷新） */
  asrStatus: AsrWorkerStatus | null;
}

export const useAiStore = defineStore("ai", {
  state: (): AiStore => ({
    settings: { ...AI_DEFAULT_SETTINGS },
    status: null,
    history: [],
    inited: false,
    asrStatus: null,
  }),
  getters: {
    /** 当前状态 */
    state: (state) => state.status?.state ?? "idle",
    /** 最近识别文本 */
    recognizedText: (state) => state.status?.recognizedText ?? "",
    /** 最近结果描述 */
    resultMessage: (state) => state.status?.result || state.status?.message || "",
  },
  actions: {
    /** 初始化：加载设置与历史并订阅主进程推送（随 initIpc 调用一次） */
    async init() {
      if (this.inited || !window.ai) return;
      this.inited = true;
      try {
        this.settings = (await window.ai.getSettings()) ?? this.settings;
        this.history = (await window.ai.getHistory()) ?? [];
      } catch (e) {
        console.error("AI 设置加载失败:", e);
      }
      window.ai.onStatus((event) => {
        this.status = event;
        if (event.state === "completed" || event.state === "error") {
          // 刷新历史
          void window.ai
            .getHistory()
            .then((list) => (this.history = list))
            .catch(() => undefined);
        }
      });
    },
    /** 更新设置（写主进程并同步镜像） */
    async updateSettings(patch: Partial<AiSettings>) {
      try {
        this.settings = await window.ai.updateSettings(patch);
      } catch (e) {
        console.error("AI 设置保存失败:", e);
      }
    },
    /** 测试 Ollama 连接 */
    async testOllama() {
      return window.ai.testOllama();
    },
    /** 刷新 ASR Worker 状态（设置页打开时调用） */
    async refreshAsrStatus() {
      try {
        this.asrStatus = await window.ai.asrStatus();
      } catch {
        this.asrStatus = null;
      }
      return this.asrStatus;
    },
    /** 获取模型列表 */
    async listModels() {
      try {
        return await window.ai.listModels();
      } catch {
        return [];
      }
    },
    /** 清空历史 */
    async clearHistory() {
      await window.ai.clearHistory();
      this.history = [];
    },
  },
  // 不持久化：设置真身在主进程 config.json，状态是易变数据
});
