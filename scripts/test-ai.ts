/**
 * AI 模块核心逻辑单元测试
 * 运行：pnpm test:ai
 * 覆盖：意图 JSON 解析（白名单/参数校验/降级）、音频缓冲（WAV 组装/有效性）
 */
import { strict as assert } from "node:assert";
import { buildIntentSystemPrompt, parseIntentJson, buildRepairPrompt } from "../electron/main/ai/intent-parser";
import { AudioBufferCollector } from "../electron/main/ai/audio-buffer";
import { buildRecallIndex, recallCandidates, recallCandidatesSmart, dedupeRepeats } from "../electron/main/ai/song-recall";
import { detectFastIntent } from "../electron/main/ai/fast-intent";
import type { MusicTrack } from "../electron/main/ai/../database/LocalMusicDB";

let passed = 0;
let failed = 0;

const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failed++;
    console.error(`❌ ${name}:`, e instanceof Error ? e.message : e);
  }
};

// ---------- 意图解析 ----------

test("system prompt 包含全部白名单意图", () => {
  const prompt = buildIntentSystemPrompt();
  for (const intent of ["play_music", "set_volume", "recommend_music", "unknown"]) {
    assert.ok(prompt.includes(intent), `缺少意图 ${intent}`);
  }
});

test("合法播放指令解析", () => {
  const result = parseIntentJson(
    JSON.stringify({
      intent: "play_music",
      parameters: { song_name: "晴天", artist: "周杰伦" },
      reply: "正在播放",
    }),
    "播放周杰伦的晴天",
  );
  assert.ok(result.ok);
  assert.equal(result.ok && result.command.intent, "play_music");
  assert.equal(result.ok && result.command.parameters.artist, "周杰伦");
  assert.equal(result.ok && result.command.rawText, "播放周杰伦的晴天");
});

test("非法意图降级为 unknown", () => {
  const result = parseIntentJson(JSON.stringify({ intent: "format_disk", parameters: {} }));
  assert.ok(result.ok);
  assert.equal(result.ok && result.command.intent, "unknown");
});

test("非 JSON 输出返回错误", () => {
  const result = parseIntentJson("这不是 JSON");
  assert.ok(!result.ok);
});

test("play_music 缺少 song_name 报错", () => {
  const result = parseIntentJson(JSON.stringify({ intent: "play_music", parameters: {} }));
  assert.ok(!result.ok);
  assert.ok(result.ok === false && result.error.includes("song_name"));
});

test("音量越界自动收敛到 0-100", () => {
  const r1 = parseIntentJson(JSON.stringify({ intent: "set_volume", parameters: { volume: 150 } }));
  assert.ok(r1.ok && r1.command.parameters.volume === 100);
  const r2 = parseIntentJson(JSON.stringify({ intent: "set_volume", parameters: { volume: -5 } }));
  assert.ok(r2.ok && r2.command.parameters.volume === 0);
});

test("白名单之外的参数被丢弃", () => {
  const result = parseIntentJson(
    JSON.stringify({ intent: "pause", parameters: { evil: "rm -rf /", song_name: "x" } }),
  );
  assert.ok(result.ok);
  assert.deepEqual(result.ok && result.command.parameters, {});
});

test("repeat 模式白名单校验", () => {
  const ok = parseIntentJson(JSON.stringify({ intent: "repeat", parameters: { mode: "list" } }));
  assert.ok(ok.ok && ok.command.parameters.mode === "list");
  const bad = parseIntentJson(JSON.stringify({ intent: "repeat", parameters: { mode: "all" } }));
  assert.ok(!bad.ok);
});

test("修复重试提示词包含错误与原文", () => {
  const prompt = buildRepairPrompt("上次输出", "JSON 非法", "播放晴天");
  assert.ok(prompt.includes("JSON 非法") && prompt.includes("播放晴天"));
});

// ---------- 音频缓冲 ----------

test("空缓冲判定为无效录音", () => {
  const collector = new AudioBufferCollector();
  assert.equal(collector.isValid, false);
});

test("短于 300ms 判定为无效录音", () => {
  const collector = new AudioBufferCollector();
  collector.addChunk(new Uint8Array(3200)); // 100ms @16k/16bit
  assert.equal(collector.isValid, false);
});

test("WAV 头部与数据长度正确", () => {
  const collector = new AudioBufferCollector();
  // 两段含语音信号的 PCM（恒定振幅 3000）
  const voiced = Buffer.alloc(32000);
  for (let i = 0; i < 16000; i++) voiced.writeInt16LE(3000, i * 2);
  collector.addChunk(voiced);
  collector.addChunk(voiced);
  const wav = collector.toWav();
  assert.ok(wav, "应产出有效 WAV");
  assert.equal(wav.length, 64044);
  assert.equal(wav.slice(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.slice(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt32LE(24), 16000); // 采样率
  assert.equal(wav.readUInt16LE(22), 1); // 单声道
  assert.equal(wav.readUInt32LE(40), 64000); // data 长度
  assert.equal(collector.durationMs, 2000);
});

test("reset 清空缓冲", () => {
  const collector = new AudioBufferCollector();
  collector.addChunk(new Uint8Array(32000));
  collector.reset();
  assert.equal(collector.sizeBytes, 0);
  assert.equal(collector.isValid, false);
});

test("远场小信号自动增益归一化", () => {
  const collector = new AudioBufferCollector();
  // 模拟远场：峰值仅 500（约 -36dB）的 1 秒语音
  const quiet = Buffer.alloc(32000);
  for (let i = 0; i < 16000; i++) {
    const amp = i < 1600 ? 0 : Math.round(500 * Math.abs(Math.sin(i / 80)));
    quiet.writeInt16LE(amp, i * 2);
  }
  collector.addChunk(quiet);
  const wav = collector.toWav();
  assert.ok(wav, "应产出有效 WAV");
  let peak = 0;
  for (let i = 44; i < wav.length - 1; i += 2) {
    peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
  }
  assert.ok(peak > 12000, `增益后峰值应接近 16000，实际 ${peak}`);
});

test("纯静音返回 null", () => {
  const collector = new AudioBufferCollector();
  collector.addChunk(Buffer.alloc(64000)); // 1 秒纯静音
  assert.equal(collector.toWav(), null);
});

// ---------- 曲库召回（谐音纠错） ----------

const mockTracks: MusicTrack[] = [
  { id: "t1", path: "E:/m/反方向的钟.flac", title: "反方向的钟", artist: "周杰伦", album: "Jay", duration: 258000, mtime: 0, size: 1 },
  { id: "t2", path: "E:/m/晴天.flac", title: "晴天", artist: "周杰伦", album: "叶惠美", duration: 269000, mtime: 0, size: 1 },
  { id: "t3", path: "E:/m/光年之外.flac", title: "光年之外", artist: "G.E.M.邓紫棋", album: "光年之外", duration: 235000, mtime: 0, size: 1 },
  { id: "t4", path: "E:/m/Beat It.mp3", title: "Beat It", artist: "Michael Jackson", album: "Thriller", duration: 258000, mtime: 0, size: 1 },
  { id: "t5", path: "E:/m/绅士.flac", title: "绅士", artist: "薛之谦", album: "绅士", duration: 254000, mtime: 0, size: 1 },
];
const recallIndex = buildRecallIndex(mockTracks);

test("完整正确句召回第一名", () => {
  const hits = recallCandidates(recallIndex, "播放周杰伦的反方向的钟");
  assert.ok(hits.length > 0);
  assert.equal(hits[0].title, "反方向的钟");
  assert.equal(hits[0].artist, "周杰伦");
});

test("谐音错字仍能锁定歌曲（周杰轮/反方向的中）", () => {
  const hits = recallCandidates(recallIndex, "播放周杰轮的反方向的中");
  assert.ok(hits.length > 0, "应有召回");
  assert.equal(hits[0].title, "反方向的钟");
});

test("纯歌名识别偏差仍可召回（拼音通道）", () => {
  const hits = recallCandidates(recallIndex, "凡方向的钟");
  assert.ok(hits.length > 0 && hits[0].title === "反方向的钟");
});

test("无关文本不误召回", () => {
  const hits = recallCandidates(recallIndex, "今天天气怎么样");
  assert.equal(hits.length, 0);
});

test("歌手名谐音可召回其歌曲", () => {
  const hits = recallCandidates(recallIndex, "播放周杰轮的歌");
  assert.ok(hits.length >= 2);
  assert.ok(hits.every((c) => c.artist === "周杰伦"));
});

test("中英混排歌手名可召回", () => {
  const hits = recallCandidates(recallIndex, "播放邓紫棋的光年之外");
  assert.ok(hits.length > 0 && hits[0].title === "光年之外");
});

test("复读循环伪影清洗", () => {
  assert.equal(dedupeRepeats("大碗碗碗碗"), "大碗");
  assert.equal(dedupeRepeats("播放: 播放: 播放: 播放:"), "播放:");
  assert.equal(dedupeRepeats("晴天"), "晴天"); // 正常文本不受影响
  assert.equal(dedupeRepeats("天天"), "天天"); // 两连字保留
});

test("口语昵称展开召回（周董→周杰伦）", () => {
  const hits = recallCandidates(recallIndex, "来首周董的晴天");
  assert.ok(hits.length > 0 && hits[0].title === "晴天" && hits[0].artist === "周杰伦");
  const hits2 = recallCandidates(recallIndex, "放点华仔的歌");
  assert.equal(hits2.length, 0); // 曲库里没有刘德华的歌，不应误召回
});

test("歌手名谐音整句（是之前的歌→薛之谦）", () => {
  const hits = recallCandidates(recallIndex, "是之前的歌");
  assert.ok(hits.length > 0, "应召回薛之谦候选");
  assert.equal(hits[0].artist, "薛之谦");
});

// ---------- 多语言别名与拉丁缩写（阶段 5） ----------

const koreanTracks: MusicTrack[] = [
  { id: "k1", path: "E:/m/으르렁.mp3", title: "으르렁 (Growl) (EXO-K Ver.)", artist: "EXO", album: "XOXO", duration: 227000, mtime: 0, size: 1 },
  { id: "k2", path: "E:/m/눈, 코, 입.mp3", title: "눈, 코, 입", artist: "TAEYANG", album: "RISE", duration: 247000, mtime: 0, size: 1 },
];
const koreanAliasConfig = {
  version: 1 as const,
  trackAliases: [
    { track: "으르렁", aliases: ["咆哮", "growl"] },
    { track: "눈, 코, 입", aliases: ["眼睛鼻子嘴", "eyes nose lips"] },
  ],
  artistAliases: [{ artist: "EXO", aliases: ["XO"] }],
};
const koreanIndex = buildRecallIndex(koreanTracks, koreanAliasConfig);

test("中文译名别名命中韩文歌（咆哮→으르렁）", () => {
  const hits = recallCandidates(koreanIndex, "播放EXO的咆哮");
  assert.ok(hits.length > 0, "应召回 으르렁");
  assert.equal(hits[0].id, "k1");
  assert.equal(hits[0].matchedBy, "alias");
});

test("ASR 拆字母（X O）与误听（ESO）仍命中 EXO", () => {
  const hits1 = recallCandidates(koreanIndex, "我想听X O的咆哮");
  assert.ok(hits1.length > 0 && hits1[0].id === "k1", "X O 应命中");
  const hits2 = recallCandidates(koreanIndex, "play ESO growl");
  assert.ok(hits2.length > 0 && hits2[0].id === "k1", "ESO 模糊应命中 EXO");
});

test("韩文原名直接命中（说韩语场景）", () => {
  const hits = recallCandidates(koreanIndex, "播放으르렁");
  assert.ok(hits.length > 0 && hits[0].id === "k1");
});

test("英文别名命中韩文歌（眼睛鼻子嘴）", () => {
  const hits = recallCandidates(koreanIndex, "我想听eyes nose lips");
  assert.ok(hits.length > 0 && hits[0].id === "k2", "eyes nose lips 应命中 눈, 코, 입");
});

// ---------- 快速意图（阶段 6：零 LLM 规则） ----------

test("控制指令快速命中", () => {
  assert.equal(detectFastIntent("暂停")?.intent, "pause");
  assert.equal(detectFastIntent("下一首")?.intent, "next");
  assert.equal(detectFastIntent("上一首")?.intent, "previous");
  assert.equal(detectFastIntent("继续播放")?.intent, "resume");
  assert.equal(detectFastIntent("大点声")?.intent, "volume_up");
  assert.equal(detectFastIntent("小声点")?.intent, "volume_down");
  assert.equal(detectFastIntent("单曲循环")?.intent, "repeat");
  assert.equal(detectFastIntent("随机播放")?.intent, "shuffle");
  assert.equal(detectFastIntent("停止播放")?.intent, "stop");
});

test("音量数值快速命中", () => {
  const c = detectFastIntent("音量调到50");
  assert.equal(c?.intent, "set_volume");
  assert.equal(c?.parameters.volume, 50);
  assert.equal(detectFastIntent("音量 80")?.parameters.volume, 80);
});

test("控制词混入歌名不误判（整句锚定）", () => {
  assert.equal(detectFastIntent("播放暂停的时刻"), null);
  assert.equal(detectFastIntent("我想听下一首歌"), null);
  assert.equal(detectFastIntent("来一首继续"), null);
});

test("长句和普通点歌不走快速规则", () => {
  assert.equal(detectFastIntent("播放周杰伦的晴天"), null);
  assert.equal(detectFastIntent("我要听那种适合下雨天听的歌可以吗"), null);
});

// ---------- 智能召回：歌手剥离二次匹配（用户反馈修复） ----------

test("歌手+谐音歌名：剥离歌手后按拼音命中（周杰伦的情天→晴天）", () => {
  const hits = recallCandidatesSmart(recallIndex, "周杰伦的情天");
  assert.ok(hits.length > 0 && hits[0].title === "晴天", "情天谐音应命中晴天");
  assert.equal(hits[0].matchedBy, "title");
});

test("纯歌手请求保持歌手候选，不虚构歌名（周杰伦的歌）", () => {
  const hits = recallCandidatesSmart(recallIndex, "周杰伦的歌");
  assert.ok(hits.length > 0, "应召回周杰伦候选");
  assert.ok(hits.every((h) => h.artist === "周杰伦"));
});

test("歌手+谐音歌名：拼音候选兜底（周杰伦的今天→晴天进候选）", () => {
  const hits = recallCandidatesSmart(recallIndex, "周杰伦的今天");
  const qt = hits.find((h) => h.title === "晴天");
  assert.ok(qt, "晴天应作为疑似谐音候选出现");
  assert.equal(qt.artist, "周杰伦");
  assert.equal(qt.matchedBy, "alias");
});

test("正常歌名请求不受剥离影响（播放周杰伦的晴天）", () => {
  const hits = recallCandidatesSmart(recallIndex, "播放周杰伦的晴天");
  assert.ok(hits.length > 0 && hits[0].title === "晴天");
});

// ---------- 汇总 ----------

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
