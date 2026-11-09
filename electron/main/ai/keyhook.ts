import { globalShortcut } from "electron";
import { aiLog } from "../logger";

/** 按键钩子句柄 */
export interface KeyhookHandle {
  stop: () => void;
}

/** 按键码映射（uiohook-napi 的 UiohookKey 键名） */
const KEY_ALIASES: Record<string, string> = {
  F8: "F8",
  F9: "F9",
  F10: "F10",
};

/**
 * 启动「按住说话」全局按键钩子
 * 长按会产生键盘自动重复的 DOWN 事件，必须用 held 标记防抖
 */
export const startPushKeyhook = async (
  keyName: string,
  onPress: () => void,
  onRelease: () => void,
): Promise<KeyhookHandle> => {
  const alias = KEY_ALIASES[keyName] ?? "F8";
  const { uIOhook, UiohookKey } = await import("uiohook-napi");
  const keycode = (UiohookKey as unknown as Record<string, number>)[alias];
  if (!keycode) {
    throw new Error(`不支持的快捷键: ${keyName}`);
  }

  let held = false;
  const keydown = (e: { keycode: number }) => {
    if (e.keycode !== keycode || held) return;
    held = true;
    onPress();
  };
  const keyup = (e: { keycode: number }) => {
    if (e.keycode !== keycode || !held) return;
    held = false;
    onRelease();
  };

  uIOhook.on("keydown", keydown);
  uIOhook.on("keyup", keyup);
  uIOhook.start();
  aiLog.info(`全局按键钩子已启动: ${alias} (按住模式)`);

  return {
    stop: () => {
      try {
        uIOhook.off("keydown", keydown);
        uIOhook.off("keyup", keyup);
        // uIOhook 为全局单例，其他系统功能未使用时安全停止
        uIOhook.stop();
        aiLog.info("全局按键钩子已停止");
      } catch (e) {
        aiLog.error("停止按键钩子失败:", e);
      }
    },
  };
};

/**
 * 启动「点击切换」模式（uiohook 钩子失败时的降级方案）
 * 复用 Electron globalShortcut，按下即切换
 */
export const startToggleKeyhook = (
  keyName: string,
  onToggle: () => void,
): KeyhookHandle => {
  const accelerator = keyName || "F8";
  const success = globalShortcut.register(accelerator, onToggle);
  if (!success) {
    throw new Error(`快捷键 ${accelerator} 注册失败，可能被其他程序占用`);
  }
  aiLog.info(`全局快捷键已注册: ${accelerator} (切换模式)`);

  return {
    stop: () => {
      try {
        globalShortcut.unregister(accelerator);
      } catch (e) {
        aiLog.error("注销全局快捷键失败:", e);
      }
    },
  };
};
