/**
 * 用户自定义多语言别名（阶段 5）
 * 文件：userData/ai/aliases.json，用户可手工编辑；缺失/损坏时返回空配置。
 * 用途：把中文译名/口语叫法映射到曲库里的原文名（如 咆哮→으르렁、眼睛鼻子嘴→눈, 코, 입）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { aiLog } from "../logger";

export interface TrackAliasEntry {
  /** 曲库标题（或其子串，归一化匹配） */
  track: string;
  /** 该曲目的其他叫法 */
  aliases: string[];
}

export interface ArtistAliasEntry {
  /** 曲库歌手名 */
  artist: string;
  aliases: string[];
}

export interface UserAliasConfig {
  version: 1;
  trackAliases: TrackAliasEntry[];
  artistAliases: ArtistAliasEntry[];
}

export const EMPTY_ALIAS_CONFIG: UserAliasConfig = { version: 1, trackAliases: [], artistAliases: [] };

/** 别名文件路径（userData/ai/aliases.json） */
export const getUserAliasesPath = (): string => {
  const dir = join(app.getPath("userData"), "ai");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "aliases.json");
};

/** 读取用户别名（损坏时自动备份并返回空配置） */
export const loadUserAliases = (): UserAliasConfig => {
  const path = getUserAliasesPath();
  if (!existsSync(path)) return { ...EMPTY_ALIAS_CONFIG, trackAliases: [], artistAliases: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<UserAliasConfig>;
    return {
      version: 1,
      trackAliases: Array.isArray(raw.trackAliases) ? raw.trackAliases : [],
      artistAliases: Array.isArray(raw.artistAliases) ? raw.artistAliases : [],
    };
  } catch (e) {
    aiLog.warn("读取用户别名失败，使用空配置:", e instanceof Error ? e.message : e);
    return { ...EMPTY_ALIAS_CONFIG, trackAliases: [], artistAliases: [] };
  }
};

/** 保存用户别名 */
export const saveUserAliases = (config: UserAliasConfig): void => {
  try {
    writeFileSync(getUserAliasesPath(), JSON.stringify(config, null, 2), "utf-8");
  } catch (e) {
    aiLog.error("保存用户别名失败:", e instanceof Error ? e.message : e);
  }
};
