import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aiLog } from "../logger";
import { AI_DEFAULT_SETTINGS, type AiSettings } from "@shared";

/** AI 模块数据目录 */
let aiDir: string | null = null;

/** 获取 AI 数据目录（userData/ai） */
export const getAiDir = (): string => {
  if (!aiDir) {
    aiDir = join(app.getPath("userData"), "ai");
    if (!existsSync(aiDir)) {
      mkdirSync(aiDir, { recursive: true });
    }
  }
  return aiDir;
};

/** 获取配置文件路径 */
export const getAiConfigPath = (): string => join(getAiDir(), "config.json");

/** 获取缓存目录（语音临时文件等） */
export const getAiCacheDir = (): string => {
  const dir = join(getAiDir(), "cache");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
};

/** 读取 AI 配置（不存在或损坏时回退默认值） */
export const getAiSettings = (): AiSettings => {
  const configPath = getAiConfigPath();
  if (!existsSync(configPath)) {
    return { ...AI_DEFAULT_SETTINGS };
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<AiSettings>;
    return { ...AI_DEFAULT_SETTINGS, ...raw };
  } catch (e) {
    aiLog.error("读取 AI 配置失败，使用默认配置:", e);
    return { ...AI_DEFAULT_SETTINGS };
  }
};

/** 更新并持久化 AI 配置 */
export const updateAiSettings = (patch: Partial<AiSettings>): AiSettings => {
  const merged = { ...getAiSettings(), ...patch };
  try {
    writeFileSync(getAiConfigPath(), JSON.stringify(merged, null, 2), "utf-8");
  } catch (e) {
    aiLog.error("写入 AI 配置失败:", e);
  }
  return merged;
};
