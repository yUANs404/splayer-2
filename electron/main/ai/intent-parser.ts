import type { AiCommand, AiCommandParameters, AiIntent } from "@shared";

/** 意图白名单 */
const INTENT_WHITELIST: readonly AiIntent[] = [
  "play_music",
  "play_artist",
  "play_playlist",
  "search_music",
  "pause",
  "resume",
  "next",
  "previous",
  "set_volume",
  "volume_up",
  "volume_down",
  "get_current_track",
  "get_playback_status",
  "shuffle",
  "repeat",
  "stop",
  "recommend_music",
  "unknown",
] as const;

/** 各意图允许的参数字段（白名单之外一律丢弃） */
const INTENT_ALLOWED_PARAMS: Record<AiIntent, readonly string[]> = {
  play_music: ["song_name", "artist"],
  play_artist: ["artist"],
  play_playlist: ["name"],
  search_music: ["keyword"],
  pause: [],
  resume: [],
  next: [],
  previous: [],
  set_volume: ["volume"],
  volume_up: [],
  volume_down: [],
  get_current_track: [],
  get_playback_status: [],
  shuffle: ["enable"],
  repeat: ["mode"],
  stop: [],
  recommend_music: ["mood", "scene"],
  unknown: [],
};

/** 意图中文说明（用于 system prompt） */
const INTENT_PROMPTS: Record<AiIntent, string> = {
  play_music: 'play_music(播放歌曲,参数 song_name,可选 artist)',
  play_artist: "play_artist(播放某歌手的歌,参数 artist)",
  play_playlist: "play_playlist(播放歌单,参数 name)",
  search_music: "search_music(搜索歌曲,参数 keyword)",
  pause: "pause(暂停播放)",
  resume: "resume(继续播放)",
  next: "next(下一曲)",
  previous: "previous(上一曲)",
  set_volume: 'set_volume(调节音量到具体数值,参数 volume 为 0-100 整数)',
  volume_up: "volume_up(把音量调大一点,相对调节)",
  volume_down: "volume_down(把音量调小一点,相对调节)",
  get_current_track: "get_current_track(查询当前播放的歌曲)",
  get_playback_status: "get_playback_status(查询播放状态)",
  shuffle: 'shuffle(随机播放开关,参数 enable 布尔)',
  repeat: 'repeat(设置循环模式,参数 mode 为 "off"|"list"|"one")',
  stop: "stop(停止播放)",
  recommend_music: "recommend_music(按心情或场景推荐歌曲,可选参数 mood 或 scene)",
  unknown: "unknown(无法确定用户意图)",
};

/** 构建意图解析的 system prompt */
export const buildIntentSystemPrompt = (): string =>
  [
    "你是本地音乐播放器的语音指令解析器。将用户的中文语音指令转换为 JSON。只输出 JSON，格式：",
    '{"intent":"...","parameters":{...},"reply":"简短中文回复"}',
    `intent 只能是：${Object.values(INTENT_PROMPTS).join("、")}。`,
    "用户是口语化表达，可能说「来首XX」「放点XX的歌」「我想听那个XX」「随便来点」「换首XX的歌」，也可能用歌手昵称（如周董=周杰伦、华仔=刘德华），请按语义理解。",
    "无法确定用户意图时用 unknown。不要输出 JSON 以外的任何内容。",
  ].join("\n");

/** 解析结果 */
export type IntentParseResult =
  | { ok: true; command: AiCommand }
  | { ok: false; error: string };

/** 字符串参数清洗 */
const cleanString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

/** 校验并修正单个意图的参数 */
const validateParams = (
  intent: AiIntent,
  rawParams: unknown,
): { params: AiCommandParameters; error?: string } => {
  const allowed = INTENT_ALLOWED_PARAMS[intent];
  const source = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Record<
    string,
    unknown
  >;
  const params: AiCommandParameters = {};

  for (const key of allowed) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (key === "volume") {
      const num = Math.round(Number(value));
      if (Number.isNaN(num)) return { params, error: "volume 不是有效数字" };
      params.volume = Math.min(100, Math.max(0, num));
    } else if (key === "enable") {
      params.enable = Boolean(value);
    } else if (key === "mode") {
      if (value === "off" || value === "list" || value === "one") {
        params.mode = value;
      } else {
        return { params, error: `mode 取值非法: ${String(value)}` };
      }
    } else {
      const str = cleanString(value);
      if (str) (params as Record<string, unknown>)[key] = str;
    }
  }

  // 必填参数检查
  if (intent === "play_music" && !params.song_name) {
    return { params, error: "play_music 缺少 song_name" };
  }
  if (intent === "play_artist" && !params.artist) {
    return { params, error: "play_artist 缺少 artist" };
  }
  if (intent === "play_playlist" && !params.name) {
    return { params, error: "play_playlist 缺少 name" };
  }
  if (intent === "search_music" && !params.keyword) {
    return { params, error: "search_music 缺少 keyword" };
  }
  if (intent === "set_volume" && params.volume === undefined) {
    return { params, error: "set_volume 缺少 volume" };
  }

  return { params };
};

/** 解析模型输出的指令 JSON（白名单校验 + 参数修正） */
export const parseIntentJson = (raw: string, rawText?: string): IntentParseResult => {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "模型输出不是合法 JSON" };
  }

  const intent = obj.intent as AiIntent;
  if (!INTENT_WHITELIST.includes(intent)) {
    // 保持本模块零宿主依赖，便于独立测试
    console.warn(`[ai] 未知意图被降级为 unknown: ${String(intent)}`);
    return {
      ok: true,
      command: {
        intent: "unknown",
        parameters: {},
        reply: typeof obj.reply === "string" ? obj.reply : "我不太明白你的意思",
        rawText,
      },
    };
  }

  const { params, error } = validateParams(intent, obj.parameters);
  if (error) {
    return { ok: false, error };
  }

  return {
    ok: true,
    command: {
      intent,
      parameters: params,
      reply: typeof obj.reply === "string" && obj.reply ? obj.reply : "已收到指令",
      rawText,
    },
  };
};

/** 构建修复重试的用户提示词（携带上次输出与错误原因） */
export const buildRepairPrompt = (raw: string, error: string, userText: string): string =>
  [
    `你上一次的输出无法通过校验：${error}`,
    `上次输出：${raw.slice(0, 500)}`,
    `用户指令：${userText}`,
    "请重新只输出符合要求的 JSON。",
  ].join("\n");
