import { ipcMain } from "electron";
import { aiService } from "../ai";
import { asrService } from "../ai/asr-service";
import { aiLog } from "../logger";
import { AI_IPC_CHANNELS, type AiSettings } from "@shared";

/**
 * 初始化 AI 助手 IPC
 * @returns void
 */
const initAiIpc = (): void => {
  aiService.init();

  // 读取设置
  ipcMain.handle(AI_IPC_CHANNELS.GET_SETTINGS, () => aiService.getSettings());

  // 更新设置（做基本字段白名单过滤）
  ipcMain.handle(AI_IPC_CHANNELS.UPDATE_SETTINGS, (_, patch: Partial<AiSettings>) => {
    if (!patch || typeof patch !== "object") {
      return aiService.getSettings();
    }
    const allowedKeys: readonly (keyof AiSettings)[] = [
      "enabled",
      "shortcutKey",
      "triggerMode",
      "ollamaBaseUrl",
      "ollamaModel",
      "ollamaTimeoutMs",
      "ollamaTemperature",
      "whisperExePath",
      "whisperModelPath",
      "whisperLanguage",
      "asrProvider",
      "asrPythonPath",
      "asrModelPath",
      "asrTimeoutMs",
      "maxRecordMs",
      "autoPlayBestMatch",
      "saveHistory",
      "saveRecognizedText",
      "duckPlayback",
    ];
    const safePatch: Partial<AiSettings> = {};
    for (const key of allowedKeys) {
      if (key in patch) {
        (safePatch as Record<string, unknown>)[key] = patch[key];
      }
    }
    return aiService.updateSettings(safePatch);
  });

  // 测试 Ollama 连接
  ipcMain.handle(AI_IPC_CHANNELS.TEST_OLLAMA, () => aiService.testOllama());

  // 获取模型列表
  ipcMain.handle(AI_IPC_CHANNELS.LIST_MODELS, () => aiService.getModels());

  // 查询状态
  ipcMain.handle(AI_IPC_CHANNELS.GET_STATUS, () => aiService.getStatus());

  // 查询 ASR Worker 状态（设置页）
  ipcMain.handle(AI_IPC_CHANNELS.ASR_STATUS, () => asrService.getStatus());

  // 开发/性能测试：注入 WAV 走完整识别管线（音频仅进内存）
  ipcMain.handle(AI_IPC_CHANNELS.DEV_INJECT, (_event, wavB64: unknown) => {
    if (typeof wavB64 !== "string" || wavB64.length > 8_000_000) {
      return { success: false, message: "参数错误" };
    }
    return aiService.debugInjectWav(wavB64);
  });

  // 提交文本走完整管线（调试与无麦克风场景）
  ipcMain.handle(AI_IPC_CHANNELS.SUBMIT_TEXT, async (_, text: string) => {
    if (typeof text !== "string") {
      return { success: false, message: "参数错误" };
    }
    return aiService.handleRecognizedText(text);
  });

  // 历史记录
  ipcMain.handle(AI_IPC_CHANNELS.GET_HISTORY, () => aiService.getHistory());
  ipcMain.handle(AI_IPC_CHANNELS.CLEAR_HISTORY, () => {
    aiService.clearHistory();
    return true;
  });

  // 麦克风 PCM 分片上送（录音中）
  ipcMain.on(AI_IPC_CHANNELS.MIC_CHUNK, (_event, data: unknown) => {
    aiService.addMicChunk(data);
  });

  // 渲染层适配层执行结果回执
  ipcMain.on(
    AI_IPC_CHANNELS.REPORT_RESULT,
    (_event, payload: { success?: boolean; message?: string }) => {
      if (!payload || typeof payload.message !== "string") return;
      aiService.onExecutionResult(Boolean(payload.success), payload.message);
    },
  );

  // 歧义候选上报 → 面板确认
  ipcMain.on(
    AI_IPC_CHANNELS.AMBIGUOUS,
    (_event, payload: { message?: string; candidates?: { id: string; title: string; artist: string }[] }) => {
      if (!payload || !Array.isArray(payload.candidates) || !payload.candidates.length) return;
      aiService.onAmbiguous(
        typeof payload.message === "string" ? payload.message : "请选择歌曲",
        payload.candidates.slice(0, 3),
      );
    },
  );

  // 面板选择候选后播放
  ipcMain.handle(AI_IPC_CHANNELS.PLAY_TRACK, (_event, trackId: unknown) => {
    if (typeof trackId !== "string") {
      return { success: false, message: "参数错误" };
    }
    return aiService.playTrack(trackId);
  });

  aiLog.info("AI IPC 已注册");
};

export default initAiIpc;
