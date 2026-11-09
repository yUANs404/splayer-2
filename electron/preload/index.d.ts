import { ElectronAPI } from "@electron-toolkit/preload";
import type { StoreType } from "../main/store";
import type {
  AiCommand,
  AiHistoryEntry,
  AiOllamaStatus,
  AiSettings,
  AiStatusEvent,
} from "@shared";

/** AI 助手渲染层 API（白名单通道） */
export interface AiApi {
  getSettings(): Promise<AiSettings>;
  updateSettings(patch: Partial<AiSettings>): Promise<AiSettings>;
  testOllama(): Promise<AiOllamaStatus>;
  listModels(): Promise<string[]>;
  getStatus(): Promise<AiStatusEvent>;
  submitText(text: string): Promise<{ success: boolean; message: string }>;
  getHistory(): Promise<AiHistoryEntry[]>;
  clearHistory(): Promise<boolean>;
  /** 播放歧义确认中选中的歌曲 */
  playTrack(trackId: string): Promise<{ success: boolean; message: string }>;
  /** 订阅状态推送，返回取消订阅函数 */
  onStatus(callback: (event: AiStatusEvent) => void): () => void;
  /** 订阅复杂播放指令，返回取消订阅函数 */
  onCommand(callback: (command: AiCommand) => void): () => void;
  /** 上送麦克风 PCM 分片（仅录音中有效） */
  sendMicChunk(data: ArrayBuffer): void;
  /** 开发/性能测试：注入 WAV 走完整识别管线（音频仅进内存） */
  devInjectWav(wavB64: string): Promise<{ success: boolean; message: string }>;
  /** 查询 ASR Worker 状态（设置页展示） */
  asrStatus(): Promise<{
    running: boolean;
    ready: boolean;
    loadMs?: number;
    reservedVramMb?: number;
    restarts: number;
    lastError?: string;
    breakerOpen: boolean;
  }>;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    ai: AiApi;
    api: {
      store: {
        get<K extends keyof StoreType>(key: K): Promise<StoreType[K]>;
        set<K extends keyof StoreType>(key: K, value: StoreType[K]): Promise<boolean>;
        has(key: keyof StoreType): Promise<boolean>;
        delete(key: keyof StoreType): Promise<boolean>;
        reset(keys?: (keyof StoreType)[]): Promise<boolean>;
        export(data: any): Promise<{ success: boolean; path?: string; error?: string }>;
        import(): Promise<{ success: boolean; data?: any; error?: string }>;
      };
    };
    // logs
    logger: {
      info: (message: string, ...args: unknown[]) => void;
      warn: (message: string, ...args: unknown[]) => void;
      error: (message: string, ...args: unknown[]) => void;
      debug: (message: string, ...args: unknown[]) => void;
    };
  }
}
