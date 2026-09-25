import { app, ipcMain, powerSaveBlocker } from "electron";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ipcLog } from "../logger";
import { useStore } from "../store";

/**
 * 初始化系统 IPC 通信
 * @returns void
 */
const initSystemIpc = (): void => {
  const store = useStore();

  /** 阻止系统息屏 ID */
  let preventId: number | null = null;

  // 是否阻止系统息屏
  ipcMain.on("prevent-sleep", (_event, val: boolean) => {
    if (val) {
      preventId = powerSaveBlocker.start("prevent-display-sleep");
      ipcLog.info("⏾ System sleep prevention started");
    } else {
      if (preventId !== null) {
        powerSaveBlocker.stop(preventId);
        ipcLog.info("✅ System sleep prevention stopped");
      }
    }
  });

  // 退出应用
  ipcMain.on("quit-app", () => {
    app.quit();
  });

  // 重启应用
  ipcMain.on("restart-app", () => {
    ipcLog.info("🔄 Restarting application...");
    app.relaunch();
    app.exit(0);
  });

  // 获取系统全部字体
  ipcMain.handle("get-all-fonts", async () => {
    try {
      const fontDirs =
        process.platform === "win32"
          ? [join(process.env.WINDIR || "C:/Windows", "Fonts")]
          : process.platform === "darwin"
            ? ["/System/Library/Fonts", "/Library/Fonts", join(process.env.HOME || "", "Library/Fonts")]
            : ["/usr/share/fonts", "/usr/local/share/fonts", join(process.env.HOME || "", ".fonts")];
      const names = new Set<string>();
      const supported = /\.(ttf|ttc|otf|woff|woff2)$/i;
      const walk = async (dir: string, depth = 0): Promise<void> => {
        if (!dir || depth > 3) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) await walk(fullPath, depth + 1);
          else if (supported.test(entry.name)) {
            names.add(entry.name.replace(/\.(ttf|ttc|otf|woff|woff2)$/i, ""));
          }
        }
      };
      for (const dir of fontDirs) await walk(dir);
      return [...names].sort();
    } catch (error) {
      ipcLog.error(`❌ Failed to get all system fonts: ${error}`);
      return [];
    }
  });

  // 重置全部设置
  ipcMain.on("reset-setting", () => {
    store.reset();
    ipcLog.info("✅ Reset setting successfully");
  });
};

export default initSystemIpc;
