/**
 * 快速意图识别（阶段 6）
 * 播放器控制类指令用确定性规则直接命中，完全绕过 LLM——
 * 只有规则不命中的文本才进入 LLM 意图解析。
 * 所有控制规则要求整句匹配（锚定），避免歌名里恰好含"暂停"等词造成误判。
 */
import type { AiCommand, AiIntent } from "@shared";

interface FastRule {
  re: RegExp;
  intent: AiIntent;
  parameters?: AiCommand["parameters"];
  reply: string;
}

/** 控制指令规则（按优先级排列，先具体后一般） */
const FAST_RULES: FastRule[] = [
  // 音量到具体数值（最具体，优先）
  {
    re: /^(?:把)?(?:音量|声音)\s*(?:调到|调至|设为|设置成|调|到|为)?\s*(\d{1,3})(?:%)?$/,
    intent: "set_volume",
    reply: "音量已调整",
  },
  // 相对音量（两种词序：调高音量 / 音量调高 / 大点声 / 小声点）
  {
    re: /^(?:把)?(?:调高|调大|加大|开大)(?:一)?点?(?:音量|声音)$|^(?:把)?(?:音量|声音)(?:调高|调大|加大|开大)(?:一)?点?$|^大(?:声|点声|声点)(?:一)?点?$|^大声$|^音量更大$/,
    intent: "volume_up",
    reply: "已调高音量",
  },
  {
    re: /^(?:把)?(?:调低|调小|减小|关小)(?:一)?点?(?:音量|声音)$|^(?:把)?(?:音量|声音)(?:调低|调小|减小|关小)(?:一)?点?$|^小(?:声|点声|声点)(?:一)?点?$|^小声$|^音量更小$/,
    intent: "volume_down",
    reply: "已调低音量",
  },
  // 循环模式
  { re: /^(?:开启|设置)?单曲循环$/, intent: "repeat", parameters: { mode: "one" }, reply: "已设置单曲循环" },
  { re: /^(?:开启|设置)?列表循环$|^(?:循环播放|循环)(?:列表)?$/, intent: "repeat", parameters: { mode: "list" }, reply: "已设置列表循环" },
  { re: /^(?:关闭|取消)(?:单曲|列表)?循环$|^不循环$|^关闭循环$/, intent: "repeat", parameters: { mode: "off" }, reply: "已关闭循环" },
  // 随机播放
  { re: /^随机播放$|^随便放$|^随机(?:模式)?$/, intent: "shuffle", parameters: { enable: true }, reply: "已开启随机播放" },
  { re: /^关闭随机(?:播放)?$/, intent: "shuffle", parameters: { enable: false }, reply: "已关闭随机播放" },
  // 停止 / 暂停（停止优先，避免"停止"命中暂停规则）
  { re: /^(?:停止|停掉)播放?$|^停止音乐$/, intent: "stop", reply: "已停止播放" },
  { re: /^暂停$|^暂停播放$|^暂停(?:一)?下$|^停一下$|^先停一下$|^别放(?:了|歌|音乐)$/, intent: "pause", reply: "已暂停" },
  // 恢复
  { re: /^继续$|^继续(?:播放|放)$|^接着放$|^恢复播放$/, intent: "resume", reply: "继续播放" },
  // 切歌
  { re: /^下一(?:首|曲)$|^切歌$|^换一(?:首|个)$|^换首歌$/, intent: "next", reply: "已切换到下一首" },
  { re: /^上一(?:首|曲)$|^切回(?:去|上一首)$|^返回上一(?:首|曲)$/, intent: "previous", reply: "已切换到上一首" },
];

/**
 * 尝试用确定性规则解析控制类指令
 * @returns 命中的指令；null = 走 LLM 管线
 */
export const detectFastIntent = (text: string): AiCommand | null => {
  // ASR 常带句尾标点（"暂停。"），先剥离再整句锚定
  const clean = text.trim().replace(/[。．.!！?？~～、，,]+$/, "");
  if (!clean || clean.length > 16) return null; // 长句不太可能是控制指令
  for (const rule of FAST_RULES) {
    const m = clean.match(rule.re);
    if (!m) continue;
    const parameters: AiCommand["parameters"] = { ...(rule.parameters ?? {}) };
    if (rule.intent === "set_volume") {
      const n = Math.round(Number(m[1]));
      if (Number.isNaN(n)) continue;
      parameters.volume = Math.min(100, Math.max(0, n));
    }
    return {
      intent: rule.intent,
      parameters,
      reply: rule.reply,
      rawText: clean,
    };
  }
  return null;
};
