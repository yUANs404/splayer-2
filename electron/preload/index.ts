import { contextBridge, ipcRenderer } from "electron";
import { electronAPI } from "@electron-toolkit/preload";
import { AI_IPC_CHANNELS } from "@shared";

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    // Expose store API via preload
    contextBridge.exposeInMainWorld("api", {
      store: {
        get: (key: string) => ipcRenderer.invoke("store-get", key),
        set: (key: string, value: unknown) => ipcRenderer.invoke("store-set", key, value),
        has: (key: string) => ipcRenderer.invoke("store-has", key),
        delete: (key: string) => ipcRenderer.invoke("store-delete", key),
        reset: (keys?: string[]) => ipcRenderer.invoke("store-reset", keys),
        export: (data: any) => ipcRenderer.invoke("store-export", data),
        import: () => ipcRenderer.invoke("store-import"),
      },
    });
    // Expose logger API via preload
    contextBridge.exposeInMainWorld("logger", {
      info: (message: string, ...args: unknown[]) =>
        ipcRenderer.send("renderer-log", "info", message, args),
      warn: (message: string, ...args: unknown[]) =>
        ipcRenderer.send("renderer-log", "warn", message, args),
      error: (message: string, ...args: unknown[]) =>
        ipcRenderer.send("renderer-log", "error", message, args),
      debug: (message: string, ...args: unknown[]) =>
        ipcRenderer.send("renderer-log", "debug", message, args),
    });
    // Expose AI assistant API via preload（白名单通道）
    contextBridge.exposeInMainWorld("ai", {
      getSettings: () => ipcRenderer.invoke(AI_IPC_CHANNELS.GET_SETTINGS),
      updateSettings: (patch: unknown) =>
        ipcRenderer.invoke(AI_IPC_CHANNELS.UPDATE_SETTINGS, patch),
      testOllama: () => ipcRenderer.invoke(AI_IPC_CHANNELS.TEST_OLLAMA),
      listModels: () => ipcRenderer.invoke(AI_IPC_CHANNELS.LIST_MODELS),
      getStatus: () => ipcRenderer.invoke(AI_IPC_CHANNELS.GET_STATUS),
      submitText: (text: string) => ipcRenderer.invoke(AI_IPC_CHANNELS.SUBMIT_TEXT, text),
      getHistory: () => ipcRenderer.invoke(AI_IPC_CHANNELS.GET_HISTORY),
      clearHistory: () => ipcRenderer.invoke(AI_IPC_CHANNELS.CLEAR_HISTORY),
      /** 播放歧义确认中选中的歌曲 */
      playTrack: (trackId: string) => ipcRenderer.invoke(AI_IPC_CHANNELS.PLAY_TRACK, trackId),
      onStatus: (callback: (event: unknown) => void) => {
        const listener = (_e: unknown, payload: unknown) => callback(payload);
        ipcRenderer.on(AI_IPC_CHANNELS.STATUS, listener);
        return () => ipcRenderer.removeListener(AI_IPC_CHANNELS.STATUS, listener);
      },
      onCommand: (callback: (command: unknown) => void) => {
        const listener = (_e: unknown, payload: unknown) => callback(payload);
        ipcRenderer.on(AI_IPC_CHANNELS.COMMAND, listener);
        return () => ipcRenderer.removeListener(AI_IPC_CHANNELS.COMMAND, listener);
      },
      /** 上送麦克风 PCM 分片（仅录音中有效） */
      sendMicChunk: (data: ArrayBuffer) => {
        ipcRenderer.send(AI_IPC_CHANNELS.MIC_CHUNK, data);
      },
      /** 开发/性能测试：注入 WAV 走完整识别管线（音频仅进内存） */
      devInjectWav: (wavB64: string): Promise<{ success: boolean; message: string }> =>
        ipcRenderer.invoke(AI_IPC_CHANNELS.DEV_INJECT, wavB64),
      /** 查询 ASR Worker 状态（设置页展示） */
      asrStatus: () => ipcRenderer.invoke(AI_IPC_CHANNELS.ASR_STATUS),
    });
  } catch (error) {
    console.error(error);
  }
}
