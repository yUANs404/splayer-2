import mainWindow from "../windows/main-window";
import { getTrackInfoFromRenderer } from "../utils/track-info";
import { aiLog } from "../logger";
import { AI_IPC_CHANNELS, type AiCommand, type AiExecuteResult } from "@shared";

/** 简单意图 → 渲染层既有命令事件（与快捷键/ControlAPI 同一通道） */
const SIMPLE_INTENT_EVENTS: Partial<Record<AiCommand["intent"], string>> = {
  pause: "pause",
  resume: "play",
  next: "playNext",
  previous: "playPrev",
  volume_up: "volumeUp",
  volume_down: "volumeDown",
};

/** 发送渲染层事件，失败返回错误描述 */
const sendToRenderer = (channel: string, ...args: unknown[]): string | null => {
  const mainWin = mainWindow.getWin();
  if (!mainWin || mainWin.isDestroyed() || mainWin.webContents.isDestroyed()) {
    return "主窗口不可用";
  }
  mainWin.webContents.send(channel, ...args);
  return null;
};

/**
 * 分发执行 AI 指令
 * 注意：简单命令为异步转发，此处返回"已发送"语义；
 * 播放类复杂意图由渲染层适配器执行后回传结果（阶段五接入）
 */
export const executeAiCommand = async (command: AiCommand): Promise<AiExecuteResult> => {
  const { intent, parameters } = command;

  // 查询类：直接从渲染层取真实数据
  if (intent === "get_current_track") {
    try {
      const info = await getTrackInfoFromRenderer();
      return { success: true, message: "查询成功", data: info };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, message: `查询失败：${message}` };
    }
  }
  if (intent === "get_playback_status") {
    try {
      const info = await getTrackInfoFromRenderer();
      return { success: true, message: "查询成功", data: info };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, message: `查询失败：${message}` };
    }
  }

  // 简单控制类：复用既有事件通道
  const simpleEvent = SIMPLE_INTENT_EVENTS[intent];
  if (simpleEvent) {
    const error = sendToRenderer(simpleEvent);
    if (error) {
      return { success: false, message: error };
    }
    aiLog.info(`指令已转发渲染层: ${intent} -> ${simpleEvent}`);
    return { success: true, message: "命令已发送" };
  }

  // 复杂意图（play_music/play_artist/set_volume/repeat/shuffle/...）
  // 统一交渲染层 AI 适配器执行（匹配歌曲、精确音量等需要访问渲染层 Store）
  const error = sendToRenderer(AI_IPC_CHANNELS.COMMAND, command);
  if (error) {
    return { success: false, message: error };
  }
  aiLog.info(`复杂指令已下发: ${intent}`, parameters);
  return { success: true, message: "命令已发送" };
};
