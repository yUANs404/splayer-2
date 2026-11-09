/**
 * 曲库知识库召回模块
 * 把识别文本与本地曲库（歌名/歌手）做字面 + 拼音双通道模糊匹配，
 * 解决语音识别的谐音字错误（如"周杰轮"→"周杰伦"、"反方向的钟"误识别）
 */
import { pinyin } from "pinyin-pro";
import type { MusicTrack } from "../database/LocalMusicDB";
import type { UserAliasConfig } from "./user-aliases";

/** 候选歌曲 */
export interface SongCandidate {
  id: string;
  title: string;
  artist: string;
  album: string;
  score: number;
  /** 命中通道（调试/置信度决策用） */
  matchedBy?: "title" | "alias" | "artist" | "artist-alias";
}

/** 索引条目 */
interface RecallItem {
  track: MusicTrack;
  titleNorm: string;
  artistNorm: string;
  titlePy: string;
  titlePyFirst: string;
  artistPy: string;
  /** 多语言别名（已归一化，来自用户配置） */
  titleAliases: string[];
  artistAliases: string[];
  /** 纯拉丁字母 token（EXO/TAEYANG 等，用于缩写模糊匹配） */
  latinTokens: string[];
}

/** 文本归一化：小写、去空白与常见标点 */
export const normalizeText = (text: string): string =>
  (text || "")
    .replace(/[\s《》【】[\]()（）"'“”、，。！？!?\-_.·~*&#@]+/g, "")
    .toLowerCase();

const norm = normalizeText;

/** 转全拼（无声调，中文转拼音、其余保留） */
const toPinyin = (text: string): string =>
  pinyin(text, { toneType: "none", nonZh: "consecutive" }).replace(/\s+/g, "");

/** 转拼音首字母 */
const toPinyinFirst = (text: string): string =>
  pinyin(text, { pattern: "first", toneType: "none", nonZh: "consecutive" }).replace(/\s+/g, "");

/** 最长公共子串长度（连续匹配，用于模糊度计算） */
const lcs = (a: string, b: string): number => {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      // 不连续即归零，保证是"子串"而非"子序列"
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
      best = Math.max(best, cur[j]);
    }
    prev = cur;
  }
  return best;
};

/** Levenshtein 编辑距离（小字符串专用，O(nm)） */
const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
};

/** 提取纯拉丁字母/数字 token（缩写与英文名模糊匹配用） */
const latinRuns = (s: string): string[] => (s.match(/[a-z0-9]+/g) ?? []);

/** 拉丁 token 模糊相等：短 token 允许 1 处编辑（X O→exo、ESO→exo），长 token 允许 2 处 */
const latinFuzzyEq = (a: string, b: string): boolean => {
  if (!a || !b || Math.abs(a.length - b.length) > 2) return false;
  const budget = a.length <= 5 ? 1 : 2;
  return levenshtein(a, b) <= budget;
};

/** 拉丁标题分段停用词（Ver/Live/Remix 等版本后缀，不参与命中） */
const TITLE_SEGMENT_STOPWORDS = new Set([
  "ver", "version", "live", "remix", "inst", "instrumental", "acoustic",
  "feat", "official", "mv", "audio", "video", "hd", "4k", "full", "prod",
]);

/** 标题分段：按括号/空白拆出核心词（"으르렁 (Growl) (EXO-K Ver.)" → 으르렁/growl/exok） */
const titleSegments = (rawTitle: string): string[] =>
  rawTitle
    .split(/[\s()（）[\]【】·\-_,，、]+/)
    .map((p) => norm(p))
    .filter((p) => {
      if (!p) return false;
      const hasLatin = /[a-z0-9]/.test(p);
      const isPureLatin = [...p].every((c) => c.charCodeAt(0) <= 0xff);
      if (hasLatin && isPureLatin) {
        // 纯拉丁段：≥3 字符且非停用词（exo/beatit 这类有意义的缩写保留）
        return p.length >= 3 && !TITLE_SEGMENT_STOPWORDS.has(p);
      }
      return p.length >= 2; // 韩文/日文/中文核心段
    });

/** 构建曲库召回索引（附带用户多语言别名） */
export const buildRecallIndex = (tracks: MusicTrack[], aliases?: UserAliasConfig): RecallItem[] => {
  const trackAliasRows = aliases?.trackAliases ?? [];
  const artistAliasRows = aliases?.artistAliases ?? [];
  return tracks.map((track) => {
    const titleNorm = norm(track.title || "");
    const artistNorm = norm(track.artist || "");
    // 命中规则：条目名归一化后与标题相等，或是标题的子串（"으르렁 (Growl) (EXO-K Ver.)" 含 "으르렁"）
    const titleAliases = [
      ...trackAliasRows
        .filter((row) => {
          const t = norm(row.track);
          return t && (t === titleNorm || titleNorm.includes(t));
        })
        .flatMap((row) => row.aliases.map(norm))
        .filter(Boolean),
      // 标题自身分段（用户常只说核心名，如"播放으르렁"）
      ...titleSegments(track.title || ""),
    ];
    const artistAliases = artistAliasRows
      .filter((row) => {
        const a = norm(row.artist);
        return a && (a === artistNorm || artistNorm.includes(a) || a.includes(artistNorm));
      })
      .flatMap((row) => row.aliases.map(norm))
      .filter(Boolean);
    const latinTokens = [
      ...latinRuns(titleNorm),
      ...latinRuns(artistNorm),
      ...titleAliases.flatMap(latinRuns),
      ...artistAliases.flatMap(latinRuns),
    ].filter((t) => t.length >= 2);
    return {
      track,
      titleNorm,
      artistNorm,
      titlePy: toPinyin(track.title || ""),
      titlePyFirst: toPinyinFirst(track.title || ""),
      artistPy: toPinyin(track.artist || ""),
      titleAliases: [...new Set(titleAliases)],
      artistAliases: [...new Set(artistAliases)],
      latinTokens: [...new Set(latinTokens)],
    };
  });
};

/** 常见歌手昵称/别称 → 规范名（覆盖口语表达，可按需补充） */
const ARTIST_ALIASES: Record<string, string> = {
  周董: "周杰伦",
  杰伦: "周杰伦",
  华仔: "刘德华",
  e神: "陈奕迅",
  奕迅: "陈奕迅",
  歌神: "张学友",
  雨神: "萧敬腾",
  紫棋: "邓紫棋",
};

/** 展开口语别名：命中昵称时把规范名追加进召回文本 */
export const expandAliases = (text: string): string => {
  let out = text;
  const lower = text.toLowerCase();
  for (const [alias, canonical] of Object.entries(ARTIST_ALIASES)) {
    if (lower.includes(alias.toLowerCase())) {
      out += ` ${canonical}`;
    }
  }
  return out;
};

/** 单曲打分（0-100+，越高越匹配）；返回分数与命中通道 */
const scoreItem = (item: RecallItem, textNorm: string, textPy: string) => {
  const { titleNorm, artistNorm, titlePy, titlePyFirst, artistPy, titleAliases, artistAliases, latinTokens } = item;
  let titleScore = 0;
  let aliasScore = 0;
  let artistScore = 0;
  let artistAliasScore = 0;

  // 提取识别文本中的拉丁 token（如 "播放xo的咆哮" → ["xo"]）
  const textRuns = latinRuns(textNorm);

  // 标题通道
  if (titleNorm) {
    // 字面包含（双向，要求标题至少 2 字命中）
    if (textNorm.includes(titleNorm)) {
      titleScore = Math.max(titleScore, 80 + Math.min(20, (titleNorm.length / Math.max(1, textNorm.length)) * 20));
    } else if (titleNorm.includes(textNorm) && textNorm.length >= 2) {
      titleScore = Math.max(titleScore, 60);
    }
    // 字面模糊（公共子串，要求至少 3 字避免单字误命中）
    const lcsTitle = lcs(textNorm, titleNorm);
    if (lcsTitle >= 3 && lcsTitle / titleNorm.length >= 0.5) {
      titleScore = Math.max(titleScore, 40 + (lcsTitle / titleNorm.length) * 30);
    }
    // 拼音包含（谐音纠错关键通道）
    if (titlePy && textPy.includes(titlePy)) {
      titleScore = Math.max(titleScore, 75 + Math.min(15, (titlePy.length / Math.max(1, textPy.length)) * 15));
    } else {
      // 拼音模糊（要求公共子串至少 4 字母）
      const lcsPy = lcs(textPy, titlePy);
      if (lcsPy >= 4 && lcsPy / titlePy.length >= 0.7) {
        titleScore = Math.max(titleScore, 55);
      }
    }
    // 首字母匹配（弱信号）
    if (titlePyFirst && titlePyFirst.length >= 2 && textPy.includes(titlePyFirst)) {
      titleScore = Math.max(titleScore, 45);
    }
  }

  // 多语言别名通道（咆哮→으르렁、Growl 等）
  for (const alias of titleAliases) {
    if (textNorm.includes(alias)) {
      aliasScore = Math.max(aliasScore, 80 + Math.min(15, (alias.length / Math.max(1, textNorm.length)) * 15));
    }
  }
  // 拉丁缩写模糊（"X O"/"ESO" → exo）
  for (const token of latinTokens) {
    if (token.length <= 8 && textRuns.some((run) => latinFuzzyEq(run, token))) {
      aliasScore = Math.max(aliasScore, 55);
    }
  }

  // 歌手通道（全量或部分发音匹配："薛之谦"被听成"之前的"、"周杰"→"周杰伦"）
  if (artistNorm) {
    const lcsArtistNorm = lcs(textNorm, artistNorm);
    const lcsArtistPy = lcs(textPy, artistPy);
    const artistMatched =
      textNorm.includes(artistNorm) ||
      textPy.includes(artistPy) ||
      (lcsArtistNorm >= 2 && lcsArtistNorm / artistNorm.length >= 0.5) ||
      (lcsArtistPy >= 4 && lcsArtistPy / artistPy.length >= 0.6);
    if (artistMatched) artistScore = 50;
  }
  // 歌手别名通道（昵称表 + 用户配置 + 拉丁缩写模糊）
  for (const alias of artistAliases) {
    if (textNorm.includes(alias)) {
      artistAliasScore = Math.max(artistAliasScore, 50);
    }
  }
  for (const token of [...latinRuns(artistNorm), ...artistAliases.flatMap(latinRuns)]) {
    if (token.length >= 2 && token.length <= 8 && textRuns.some((run) => latinFuzzyEq(run, token))) {
      artistAliasScore = Math.max(artistAliasScore, 50);
    }
  }

  const titleBest = Math.max(titleScore, aliasScore);
  const artistBest = Math.max(artistScore, artistAliasScore);
  if (titleBest && artistBest) {
    return {
      score: Math.max(titleBest, artistBest) + 10,
      matchedBy: (titleBest >= artistBest
        ? aliasScore >= titleScore ? "alias" : "title"
        : artistAliasScore >= artistScore ? "artist-alias" : "artist") as SongCandidate["matchedBy"],
    };
  }
  if (titleBest) {
    return { score: titleBest, matchedBy: (aliasScore >= titleScore ? "alias" : "title") as SongCandidate["matchedBy"] };
  }
  return {
    score: artistBest,
    matchedBy: (artistAliasScore >= artistScore ? "artist-alias" : "artist") as SongCandidate["matchedBy"],
  };
};

/**
 * 从曲库召回与识别文本最匹配的歌曲
 * @param index 召回索引
 * @param text 识别文本（整句，如"播放周杰伦的反方向的钟"）
 * @param limit 返回条数
 */
export const recallCandidates = (
  index: RecallItem[],
  rawText: string,
  limit = 10,
): SongCandidate[] => {
  // 口语别名展开（周董→周杰伦等）后再匹配
  const text = expandAliases(rawText);
  const textNorm = norm(text);
  const textPy = toPinyin(text);
  if (!textNorm) return [];
  return index
    .map((item) => {
      const { score, matchedBy } = scoreItem(item, textNorm, textPy);
      return {
        id: item.track.id,
        title: item.track.title,
        artist: item.track.artist,
        album: item.track.album,
        score,
        matchedBy,
      };
    })
    .filter((c) => c.score >= 40)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

/**
 * 智能召回：歌手命中时剥离歌手名与「的/歌」，用剩余片段二次匹配歌名
 * 「周杰伦的晴天」→ 一次召回仅歌手命中 → 剥离后「晴天」歌名强命中 → 升到首位
 * 纯歌手请求（「周杰伦的歌」剥离后无有效片段）保持歌手候选
 */
export const recallCandidatesSmart = (
  index: RecallItem[],
  rawText: string,
  limit = 10,
): SongCandidate[] => {
  const first = recallCandidates(index, rawText, limit);
  const top = first[0];
  if (!top) return first;
  if (top.matchedBy === "title" || top.matchedBy === "alias") return first;
  const artistNorm = norm(top.artist || "");
  const textNorm = norm(expandAliases(rawText));
  if (!artistNorm || !textNorm.includes(artistNorm)) return first;
  // 剥离歌手名与助词/泛指词，保留歌名片段
  // ⚠️ 必须全局删除：expandAliases 可能追加规范名（"周杰伦的今天"→含两个"周杰伦"），
  // 只删第一处会让剩余片段残留歌手名，导致二次召回退回歌手泛匹配
  const rest = norm(textNorm.split(artistNorm).join(" ").replace(/的|歌|首|来|放/g, " "));
  if (rest.length < 2) return first; // 纯歌手请求
  const second = recallCandidates(index, rest, limit);
  if (second.length) {
    const ids = new Set(second.map((c) => c.id));
    return [...second, ...first.filter((c) => !ids.has(c.id))].slice(0, limit);
  }
  // 二次无命中：在该歌手的歌曲里按「剩余片段拼音相似度」挑疑似谐音歌名
  // （「周杰伦的今天」→《晴天》jintian/qingtian 相似 0.5），交给 LLM 终裁确认
  const restPy = toPinyin(rest);
  const artistSongs = index.filter((it) => {
    const a = norm(it.track.artist || "");
    return a && (a.includes(artistNorm) || artistNorm.includes(a));
  });
  const fuzzy = artistSongs
    .map((it) => ({
      item: it,
      ratio: it.titlePy ? lcs(restPy, it.titlePy) / it.titlePy.length : 0,
    }))
    .filter((x) => x.ratio >= 0.4)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 2)
    .map(
      (x): SongCandidate => ({
        id: x.item.track.id,
        title: x.item.track.title,
        artist: x.item.track.artist,
        album: x.item.track.album,
        score: 50 + x.ratio * 20,
        matchedBy: "alias",
      }),
    );
  if (fuzzy.length) {
    const ids = new Set(fuzzy.map((c) => c.id));
    return [...fuzzy, ...first.filter((c) => !ids.has(c.id))].slice(0, limit);
  }
  return first;
};

/**
 * 清洗 whisper 复读循环伪影
 * 音乐混入麦克风时 whisper 会输出"大碗碗碗碗""播放: 播放:"这类循环，
 * 将单字符连续重复 ≥3 次折叠为 1 次，短语重复 ≥2 次折叠为 1 次
 */
export const dedupeRepeats = (text: string): string => {
  let out = text.replace(/(.)\1{2,}/g, "$1");
  // 短语（2-6 字）紧邻重复两次以上折叠，如"播放: 播放: 播放:"→"播放:"
  out = out.replace(/(.{2,6}?)\s*(?:[:：，,]?\s*\1){2,}/g, "$1");
  return out;
};

/**
 * 生成 whisper 初始提示词（注入歌手词表，提升专有名词识别）
 * whisper prompt 有限（约百余 token），只放去重后的歌手名
 */
export const buildWhisperPrompt = (tracks: MusicTrack[]): string => {
  const artists = [...new Set(tracks.map((t) => (t.artist || "").trim()).filter(Boolean))];
  if (!artists.length) return "";
  // 注入歌手词表 + 常见指令词，双通道纠偏（防语种漂移/专有名词误识）
  const prompt = `播放歌曲，暂停，下一首，上一首。以下是可能出现的歌手名：${artists.join("、")}。`;
  return prompt.length > 360 ? prompt.slice(0, 360) : prompt;
};
