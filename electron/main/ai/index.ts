import { app } from "electron";
import { randomUUID } from "node:crypto";
import mainWindow from "../windows/main-window";
import { aiLog } from "../logger";
import { chatOllama, checkOllama, listOllamaModels } from "./ollama-client";
import {
  buildIntentSystemPrompt,
  buildRepairPrompt,
  parseIntentJson,
} from "./intent-parser";
import { executeAiCommand } from "./command-dispatcher";
import { detectFastIntent } from "./fast-intent";
import { getAiSettings, updateAiSettings } from "./ai-config";
import { AudioBufferCollector } from "./audio-buffer";
import { asrService } from "./asr-service";
import {
  buildRecallIndex,
  recallCandidatesSmart,
  buildWhisperPrompt,
  normalizeText,
  dedupeRepeats,
  type SongCandidate,
} from "./song-recall";
import { startPushKeyhook, startToggleKeyhook, type KeyhookHandle } from "./keyhook";
import { loadUserAliases } from "./user-aliases";
import { LocalMusicService } from "../services/LocalMusicService";
import type { MusicTrack } from "../database/LocalMusicDB";
import {
  AI_IPC_CHANNELS,
  type AiCommand,
  type AiExecuteResult,
  type AiHistoryEntry,
  type AiOllamaStatus,
  type AiSettings,
  type AiState,
  type AiStatusEvent,
} from "@shared";

/** 需要曲库终裁的意图 */
const MUSIC_INTENTS = new Set<string>([
  "play_music",
  "play_artist",
  "play_playlist",
  "search_music",
  "recommend_music",
]);

/** 允许曲库终裁改判意图的原意图（如"薛之谦的歌"被误听成"是之前的歌"→切歌） */
const RECONSIDERABLE_INTENTS = new Set<string>(["unknown", "previous", "next"]);

/**
 * 端到端延迟打点（松开 F8 → 播放，阶段 7/11 的度量基础）
 * done() 记录各阶段完成时刻，summary() 输出相邻差分
 */
class PerfTrace {
  private readonly t0 = performance.now();
  private readonly marks: Array<[string, number]> = [];
  /** 记录某阶段完成 */
  done(label: string): void {
    this.marks.push([label, performance.now()]);
  }
  /** 单行摘要：asr=430ms llm=1050ms total=1520ms（首段从松开 F8 算起） */
  summary(): string {
    let prev = this.t0;
    const parts = this.marks.map(([label, t]) => {
      const delta = Math.round(t - prev);
      prev = t;
      return `${label}=${delta}ms`;
    });
    parts.push(`total=${Math.round(prev - this.t0)}ms`);
    return parts.join(" ");
  }
}

/** AI 助手主进程服务（状态机 + 语音/文本指令处理管线） */
class AiService {
  /** 当前状态 */
  private state: AiState = "idle";
  /** 防止并发处理 */
  private busy = false;
  /** 历史记录（内存，受 saveHistory 控制） */
  private history: AiHistoryEntry[] = [];
  /** 清理函数 */
  private cleanupDone = false;
  /** 当前按键钩子句柄 */
  private keyhook: KeyhookHandle | null = null;
  /** 是否正在录音 */
  private isRecording = false;
  /** 当前录音缓冲 */
  private collector: AudioBufferCollector | null = null;
  /** 最长录音定时器 */
  private maxRecordTimer: ReturnType<typeof setTimeout> | null = null;
  /** 已启动语音系统时记录的配置（用于变更检测） */
  private voiceConfig: { enabled: boolean; key: string; mode: string } | null = null;
  /** 曲库访问（独立实例，只读） */
  private libraryService = new LocalMusicService();
  /** 曲库缓存与召回索引 */
  private libraryTracks: MusicTrack[] = [];
  private recallIndex = buildRecallIndex([]);
  /** 别名配置签名（变更时重建召回索引） */
  private aliasConfigSig = "";

  /** 获取曲库（数量或别名配置变化时重建召回索引） */
  private async getLibraryTracks(): Promise<MusicTrack[]> {
    try {
      const tracks = await this.libraryService.getAllTracks();
      const aliasCfg = loadUserAliases();
      const sig = JSON.stringify(aliasCfg);
      if (tracks.length !== this.libraryTracks.length || sig !== this.aliasConfigSig) {
        this.libraryTracks = tracks;
        this.aliasConfigSig = sig;
        this.recallIndex = buildRecallIndex(tracks, aliasCfg);
      }
      return tracks;
    } catch (e) {
      aiLog.warn("读取曲库失败，使用缓存:", e instanceof Error ? e.message : e);
      return this.libraryTracks;
    }
  }

  /** 广播状态到渲染层 */
  private emitStatus(event: Omit<AiStatusEvent, "timestamp">): void {
    this.state = event.state;
    const mainWin = mainWindow.getWin();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send(AI_IPC_CHANNELS.STATUS, {
        ...event,
        timestamp: Date.now(),
      } satisfies AiStatusEvent);
    }
    aiLog.info(`[${event.state}]`, event.message ?? "");
  }

  /** 当前状态查询 */
  public getStatus(): AiStatusEvent {
    return { state: this.state, timestamp: Date.now() };
  }

  /** 读取设置 */
  public getSettings(): AiSettings {
    return getAiSettings();
  }

  /** 更新设置（语音相关配置变化时自动重启按键钩子；ASR 配置变化时重启 Worker） */
  public updateSettings(patch: Partial<AiSettings>): AiSettings {
    const merged = updateAiSettings(patch);
    const needRestart =
      patch.enabled !== undefined ||
      patch.shortcutKey !== undefined ||
      patch.triggerMode !== undefined;
    if (needRestart) {
      void this.syncVoiceSystem();
    }
    if (
      patch.asrProvider !== undefined ||
      patch.asrPythonPath !== undefined ||
      patch.asrModelPath !== undefined
    ) {
      // ensureStarted 检测到配置签名变化会自动重启旧 Worker
      void asrService.ensureStarted().catch(() => undefined);
    }
    aiLog.info("AI 设置已更新");
    return merged;
  }

  /** 测试 Ollama 连接 */
  public async testOllama(): Promise<AiOllamaStatus> {
    const settings = getAiSettings();
    return checkOllama(settings.ollamaBaseUrl);
  }

  /** 获取模型列表 */
  public async getModels(): Promise<string[]> {
    const settings = getAiSettings();
    return listOllamaModels(settings.ollamaBaseUrl);
  }

  /** 历史记录 */
  public getHistory(): AiHistoryEntry[] {
    return this.history;
  }

  /** 清空历史 */
  public clearHistory(): void {
    this.history = [];
  }

  /** 追加历史（受设置控制） */
  private pushHistory(text: string, command: AiCommand | null, result: string, success: boolean) {
    const settings = getAiSettings();
    if (!settings.saveHistory) return;
    this.history.unshift({
      id: randomUUID(),
      time: Date.now(),
      text: settings.saveRecognizedText ? text : "",
      command,
      result,
      success,
    });
    // 上限 100 条，避免内存增长
    if (this.history.length > 100) {
      this.history.length = 100;
    }
  }

  /**
   * 处理识别文本：AI 理解 → 校验 → 分发执行
   * 阶段四的语音识别结果与调试用文本输入都走此入口
   * @param trace 可选的端到端延迟打点（语音链路传入）
   */
  public async handleRecognizedText(text: string, trace?: PerfTrace): Promise<AiExecuteResult> {
    const cleanText = text.trim();
    if (!cleanText) {
      return { success: false, message: "识别内容为空" };
    }
    if (this.busy) {
      return { success: false, message: "上一条指令仍在处理中" };
    }
    this.busy = true;

    try {
      // ① 零 LLM 快速通道：确定性控制指令（暂停/切歌/音量/循环等）
      const fastCommand = detectFastIntent(cleanText);
      if (fastCommand) {
        return await this.executeFast(fastCommand, cleanText, trace, "rule");
      }

      // ② 曲库先行：高置信点歌直通（歌名/别名强命中，不调 LLM）
      const fastRecall = await this.tryFastRecall(cleanText);
      if (fastRecall) {
        return await this.executeFast(fastRecall, cleanText, trace, "recall");
      }

      // ③ 曲库有候选 → 单次 LLM 终裁直达（省去意图解析调用，歧义路径延迟减半；
      //    终裁本身支持意图改判，unknown→play_music/play_artist）
      await this.getLibraryTracks();
      const preCandidates = recallCandidatesSmart(this.recallIndex, cleanText, 5);
      if (preCandidates.length) {
        const command: AiCommand = { intent: "unknown", parameters: {}, reply: "", rawText: cleanText };
        await this.finalizeWithLibrary(command, cleanText, trace);
        if (command.intent !== "unknown") {
          // 终裁已确定播放意图，直接执行
          this.emitStatus({
            state: "executing",
            message: command.reply,
            recognizedText: cleanText,
            command,
          });
          const result = await executeAiCommand(command);
          trace?.done("dispatch");
          if (trace) {
            aiLog.info(`(ai-perf) ${trace.summary()} | finalize "${cleanText}"`);
          }
          this.emitStatus({
            state: result.success ? "completed" : "error",
            message: result.message,
            recognizedText: cleanText,
            command,
            result: result.message,
            error: result.success ? undefined : result.message,
          });
          this.pushHistory(cleanText, command, result.message, result.success);
          return result;
        }
        // 终裁认为候选都不合适 → 继续走完整意图解析（下方）
      }

      // ④ LLM 意图解析（复杂/含糊/非曲库表达）
      const settings = getAiSettings();
      this.emitStatus({ state: "thinking", message: "AI 正在理解指令" });
      let raw = await chatOllama({
        baseUrl: settings.ollamaBaseUrl,
        model: settings.ollamaModel,
        system: buildIntentSystemPrompt(),
        user: cleanText,
        timeoutMs: settings.ollamaTimeoutMs,
        temperature: settings.ollamaTemperature,
        numCtx: 2048,
        keepAlive: "5m", // 连续对话（意图解析→曲库终裁）复用热模型
        numPredict: 200,
      });
      trace?.done("llm_parse");

      // 解析 + 一次修复重试
      let parsed = parseIntentJson(raw, cleanText);
      if (!parsed.ok) {
        aiLog.warn("指令解析失败，尝试修复重试:", parsed.error);
        this.emitStatus({ state: "thinking", message: "指令格式异常，正在重试" });
        raw = await chatOllama({
          baseUrl: settings.ollamaBaseUrl,
          model: settings.ollamaModel,
          system: buildIntentSystemPrompt(),
          user: buildRepairPrompt(raw, parsed.error, cleanText),
          timeoutMs: settings.ollamaTimeoutMs,
          temperature: settings.ollamaTemperature,
        });
        parsed = parseIntentJson(raw, cleanText);
        trace?.done("llm_repair");
      }
      if (!parsed.ok) {
        this.emitStatus({ state: "error", error: parsed.error, message: "指令解析失败" });
        this.pushHistory(cleanText, null, parsed.error, false);
        return { success: false, message: `指令解析失败：${parsed.error}` };
      }

      const command = parsed.command;

      // 曲库知识库终裁：播放类意图校正参数；误判意图（如歌名被听成"之前的歌"）
      // 允许结合候选改判意图
      if (MUSIC_INTENTS.has(command.intent) || RECONSIDERABLE_INTENTS.has(command.intent)) {
        await this.finalizeWithLibrary(command, cleanText, trace);
      }

      this.emitStatus({
        state: "executing",
        message: command.reply,
        recognizedText: cleanText,
        command,
      });

      // unknown 意图不执行
      if (command.intent === "unknown") {
        const message = command.reply || "我不太明白你的意思";
        this.emitStatus({ state: "completed", message, recognizedText: cleanText, command });
        this.pushHistory(cleanText, command, message, true);
        return { success: true, message };
      }

      // 分发执行
      const result = await executeAiCommand(command);
      trace?.done("dispatch");
      if (trace) {
        aiLog.info(`(ai-perf) ${trace.summary()} | "${cleanText}"`);
      }
      this.emitStatus({
        state: result.success ? "completed" : "error",
        message: result.message,
        recognizedText: cleanText,
        command,
        result: result.message,
        error: result.success ? undefined : result.message,
      });
      this.pushHistory(cleanText, command, result.message, result.success);
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      aiLog.error("AI 指令处理失败:", message);
      this.emitStatus({ state: "error", error: message, message: `AI 处理失败：${message}` });
      this.pushHistory(cleanText, null, message, false);
      return { success: false, message: `AI 处理失败：${message}` };
    } finally {
      this.busy = false;
    }
  }

  // ==================== 快速通道（阶段 6：不依赖 LLM） ====================

  /** 疑似点歌表达（快速召回前置判断；含英文口语动词） */
  private static readonly PLAY_REQUEST_RE =
    /播放|放一首|放首歌|放个|来一首|来首歌|来点|我想听|听一下|点一首|点播|随便放|随便来|play\b|put on|listen to|sing\b/i;

  /**
   * 高置信点歌直通：曲库召回优先于 LLM
   * 门槛：标题/别名强命中（≥85）+ 明显高于次名（≥15）；只命中歌手的交给 LLM 终裁
   */
  private async tryFastRecall(text: string): Promise<AiCommand | null> {
    if (!AiService.PLAY_REQUEST_RE.test(text)) return null;
    await this.getLibraryTracks();
    const candidates = recallCandidatesSmart(this.recallIndex, text, 2);
    const top = candidates[0];
    if (!top) return null;
    const margin = candidates[1] ? top.score - candidates[1].score : top.score;
    if (top.score < 85 || margin < 15 || top.matchedBy === "artist" || top.matchedBy === "artist-alias") {
      return null;
    }
    return {
      intent: "play_music",
      parameters: { track_id: top.id, song_name: top.title, artist: top.artist || undefined },
      reply: `播放《${top.title}》`,
      rawText: text,
    };
  }

  /** 快速通道执行：状态推送 + 分发 + 性能日志（不走 LLM） */
  private async executeFast(
    command: AiCommand,
    text: string,
    trace: PerfTrace | undefined,
    tag: string,
  ): Promise<AiExecuteResult> {
    trace?.done(tag === "rule" ? "rule" : "recall_fast");
    this.emitStatus({ state: "executing", message: command.reply, recognizedText: text, command });
    const result = await executeAiCommand(command);
    trace?.done("dispatch");
    if (trace) {
      aiLog.info(`(ai-perf) ${trace.summary()} | fast:${tag} "${text}"`);
    } else {
      aiLog.info(`(ai-perf) fast:${tag} "${text}"`);
    }
    this.emitStatus({
      state: result.success ? "completed" : "error",
      message: result.message,
      recognizedText: text,
      command,
      result: result.message,
      error: result.success ? undefined : result.message,
    });
    this.pushHistory(text, command, result.message, result.success);
    return result;
  }

  // ==================== 曲库知识库终裁 ====================

  /** 终裁校正提示词 */
  private buildFinalizeSystemPrompt = (): string =>
    [
      "你是音乐播放器的指令校正器。用户的语音识别文本可能有谐音错别字。",
      "根据提供的曲库候选，判断用户真正想听的歌曲。",
      '只能输出 JSON：{"intent":"...","parameters":{...},"reply":"简短中文回复"}',
      "判定规则：",
      "1. 先看识别文本去掉歌手名之后还剩什么：",
      '   a. 剩余片段能与某候选歌名对应（字面/谐音/拼音相近，如「周杰伦的今天」→《晴天》、',
      '      「反方向的中」→《反方向的钟》）→ intent=play_music，parameters.song_name 必须用候选原文；',
      '   b. 剩余为空或只是「的歌」（如「周杰伦的歌」「邓紫棋的歌」）→ intent=play_artist，',
      "      parameters.artist 用候选歌手原文。不要替用户擅自挑具体歌曲，系统会把该歌手全部歌曲加入列表随机播放；",
      '2. 识别文本可能是歌手名的谐音误读（如「是之前的歌」=「薛之谦的歌」、「周杰轮」=「周杰伦」），按规则 1b 走 play_artist；',
      "3. 无法确定时保持原 intent 与 parameters 不变。",
    ].join("\n");

  private buildFinalizeUserPrompt = (text: string, command: AiCommand, candidates: SongCandidate[]): string =>
    JSON.stringify({
      intent: command.intent,
      原解析参数: command.parameters,
      识别文本: text,
      曲库候选: candidates.map((c) => ({
        id: c.id,
        song_name: c.title,
        artist: c.artist,
        album: c.album,
        匹配分: Math.round(c.score),
      })),
    });

  /** 用曲库候选校正指令参数 */
  private async finalizeWithLibrary(command: AiCommand, text: string, trace?: PerfTrace): Promise<void> {
    const tracks = await this.getLibraryTracks();
    if (!tracks.length) return;

    const recallText = [
      text,
      command.parameters.song_name ?? "",
      command.parameters.artist ?? "",
    ]
      .filter(Boolean)
      // 去除与整句重复的片段（"大碗" + song_name"大碗" → 只保留一份，
      // 否则重复文本会破坏标题包含比例的打分）
      .filter((seg, i, arr) => arr.findIndex((s) => s.includes(seg) || seg.includes(s)) === i || seg === text)
      .join(" ");
    const candidates = recallCandidatesSmart(this.recallIndex, recallText, 5);
    trace?.done("recall");
    if (!candidates.length) {
      aiLog.info("曲库无召回候选，按原指令执行");
      return;
    }
    aiLog.info(
      `曲库召回 ${candidates.length} 条，Top3:`,
      candidates
        .slice(0, 3)
        .map((c) => `${c.title}/${c.artist}(${Math.round(c.score)})`)
        .join(" | "),
    );

    const settings = getAiSettings();
    try {
      this.emitStatus({ state: "thinking", message: "正在比对本地曲库" });
      const raw = await chatOllama({
        baseUrl: settings.ollamaBaseUrl,
        model: settings.ollamaModel,
        system: this.buildFinalizeSystemPrompt(),
        user: this.buildFinalizeUserPrompt(text, command, candidates),
        timeoutMs: settings.ollamaTimeoutMs,
        temperature: 0,
        numCtx: 2048,
        numPredict: 200,
      });
      trace?.done("llm_final");
      const finalized = parseIntentJson(raw, text);
      if (!finalized.ok) {
        aiLog.warn("曲库终裁未通过校验，按原指令执行");
        return;
      }
      // 原意图不可改判时，终裁意图必须一致
      const p = finalized.command.parameters;
      const intentChanged = finalized.command.intent !== command.intent;
      if (intentChanged && !RECONSIDERABLE_INTENTS.has(command.intent)) {
        aiLog.warn("终裁意图变更被拒绝（原意图不可改判）:", command.intent, "->", finalized.command.intent);
        return;
      }
      // 幻觉防护：终裁的歌名/歌手必须命中候选原文（归一化比对）
      const matched =
        (finalized.command.intent === "play_music" &&
          candidates.find(
            (c) => p.song_name && normalizeText(c.title) === normalizeText(p.song_name),
          )) ||
        (finalized.command.intent === "play_artist" &&
          candidates.find((c) => p.artist && normalizeText(c.artist).includes(normalizeText(p.artist))));
      if (!matched) {
        aiLog.warn("终裁歌名/歌手未命中候选，按原指令执行");
        return;
      }
      command.intent = finalized.command.intent;
      command.parameters = { ...p };
      if (finalized.command.intent === "play_music") {
        command.parameters.song_name = matched.title;
        command.parameters.artist = matched.artist || p.artist || command.parameters.artist;
        command.parameters.track_id = matched.id;
      } else if (finalized.command.intent === "play_artist") {
        command.parameters.artist = matched.artist;
      }
      command.reply = finalized.command.reply || command.reply;
      aiLog.info(
        `曲库终裁生效: ${command.intent}`,
        matched.title ? `${matched.title} / ${matched.artist}` : matched.artist,
      );
    } catch (e) {
      aiLog.warn("曲库终裁调用失败，按原指令执行:", e instanceof Error ? e.message : e);
    }
  }

  /** 接收渲染层适配层的真实执行回执 */
  public onExecutionResult(success: boolean, message: string): void {
    this.emitStatus({
      state: success ? "completed" : "error",
      message,
      result: message,
      error: success ? undefined : message,
    });
  }

  /** 接收歧义候选，推送 confirm 状态供面板展示选择按钮 */
  public onAmbiguous(message: string, candidates: { id: string; title: string; artist: string }[]): void {
    this.emitStatus({
      state: "confirm",
      message,
      candidates,
    });
  }

  /** 播放指定歌曲（面板确认后调用，走渲染层适配器） */
  public async playTrack(trackId: string): Promise<AiExecuteResult> {
    if (!trackId) {
      return { success: false, message: "参数错误" };
    }
    this.emitStatus({ state: "executing", message: "正在播放你选择的歌曲" });
    return executeAiCommand({
      intent: "play_music",
      parameters: { track_id: trackId },
      reply: "播放你选择的歌曲",
    });
  }

  /** 应用退出时释放资源 */
  public cleanup(): void {
    if (this.cleanupDone) return;
    this.cleanupDone = true;
    this.stopKeyhook();
    asrService.shutdown();
    if (this.maxRecordTimer) {
      clearTimeout(this.maxRecordTimer);
      this.maxRecordTimer = null;
    }
    this.isRecording = false;
    this.collector = null;
    aiLog.info("AI 服务已清理");
  }

  /** 初始化（挂接退出清理 + 按设置启动语音系统 + 预热 ASR Worker） */
  public init(): void {
    app.once("will-quit", () => this.cleanup());
    void this.syncVoiceSystem();
    asrService.warmup();
    aiLog.info("AI 服务已初始化");
  }

  // ==================== 语音链路 ====================

  /** 依据当前设置同步按键钩子（启用/禁用/换键/换模式） */
  private async syncVoiceSystem(): Promise<void> {
    const settings = getAiSettings();
    const target = {
      enabled: settings.enabled,
      key: settings.shortcutKey,
      mode: settings.triggerMode,
    };
    // 配置未变化则跳过
    if (
      this.voiceConfig &&
      this.voiceConfig.enabled === target.enabled &&
      this.voiceConfig.key === target.key &&
      this.voiceConfig.mode === target.mode
    ) {
      return;
    }
    this.stopKeyhook();
    this.voiceConfig = target;

    if (!target.enabled) {
      this.emitStatus({ state: "idle", message: "AI 助手已关闭" });
      return;
    }

    try {
      if (target.mode === "push") {
        this.keyhook = await startPushKeyhook(
          target.key,
          () => this.startVoiceSession(),
          () => void this.stopVoiceSession(),
        );
      } else {
        this.keyhook = startToggleKeyhook(target.key, () => {
          if (this.isRecording) {
            void this.stopVoiceSession();
          } else {
            this.startVoiceSession();
          }
        });
      }
      this.emitStatus({ state: "idle", message: `AI 助手已就绪（${target.key}）` });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      aiLog.error("语音按键钩子启动失败:", message);
      // 按住模式失败时自动降级为切换模式
      if (target.mode === "push") {
        try {
          this.keyhook = startToggleKeyhook(target.key, () => {
            if (this.isRecording) {
              void this.stopVoiceSession();
            } else {
              this.startVoiceSession();
            }
          });
          this.emitStatus({
            state: "error",
            message: `按键钩子不可用，已降级为点击切换模式：${message}`,
            error: message,
          });
          return;
        } catch (e2) {
          this.emitStatus({
            state: "error",
            message: `快捷键注册失败：${e2 instanceof Error ? e2.message : String(e2)}`,
          });
          return;
        }
      }
      this.emitStatus({ state: "error", message: `快捷键注册失败：${message}` });
    }
  }

  /** 停止按键钩子 */
  private stopKeyhook(): void {
    if (this.keyhook) {
      this.keyhook.stop();
      this.keyhook = null;
    }
  }

  /** 开始录音会话 */
  private startVoiceSession(): void {
    if (this.busy || this.isRecording) return;
    const settings = getAiSettings();
    this.collector = new AudioBufferCollector();
    this.isRecording = true;
    this.emitStatus({ state: "recording", message: "正在录音，请说话" });
    const mainWin = mainWindow.getWin();
    if (mainWin && !mainWin.isDestroyed()) {
      // 录音时让音乐让路（避免外放音乐混入麦克风导致识别复读/串音）
      if (settings.duckPlayback) {
        mainWin.webContents.send(AI_IPC_CHANNELS.DUCK_START);
      }
      mainWin.webContents.send(AI_IPC_CHANNELS.MIC_START);
    }
    // 最长录音保护
    this.maxRecordTimer = setTimeout(
      () => void this.stopVoiceSession(),
      Math.max(3000, settings.maxRecordMs),
    );
  }

  /** 结束录音并进入识别/理解/执行管线 */
  private async stopVoiceSession(): Promise<void> {
    if (!this.isRecording) return;
    this.isRecording = false;
    const trace = new PerfTrace(); // 从松开 F8 的时刻开始计时
    if (this.maxRecordTimer) {
      clearTimeout(this.maxRecordTimer);
      this.maxRecordTimer = null;
    }
    const mainWin = mainWindow.getWin();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send(AI_IPC_CHANNELS.MIC_STOP);
      // 恢复之前被静音的播放
      if (getAiSettings().duckPlayback) {
        mainWin.webContents.send(AI_IPC_CHANNELS.DUCK_END);
      }
    }
    // 等待渲染层尾部分片到达
    await new Promise((resolve) => setTimeout(resolve, 200));
    trace.done("tailwait");

    const collector = this.collector;
    this.collector = null;
    if (!collector || !collector.isValid) {
      this.emitStatus({ state: "completed", message: "未检测到有效语音" });
      return;
    }

    try {
      this.emitStatus({ state: "recognizing", message: "正在识别语音" });
      const tracks = await this.getLibraryTracks();
      const wav = collector.toWav();
      if (!wav) {
        this.emitStatus({
          state: "completed",
          message: "未检测到有效语音",
          error: collector.lastFinalizeDiag || undefined,
        });
        aiLog.warn("音频缓冲无有效语音:", collector.lastFinalizeDiag || "未知原因");
        return;
      }
      trace.done("prep");
      const result = await asrService.transcribe(wav, collector.durationMs, buildWhisperPrompt(tracks));
      trace.done(`asr(${result.provider}${result.language ? ":" + result.language : ""})`);
      const text = dedupeRepeats(result.text.trim());
      if (!text) {
        this.emitStatus({ state: "completed", message: "未能识别出内容" });
        return;
      }
      // 复用文本管线（thinking → executing → completed）
      await this.handleRecognizedText(text, trace);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      aiLog.error("语音识别失败:", message);
      this.emitStatus({ state: "error", error: message, message });
      this.pushHistory("", null, message, false);
    }
  }

  /** 接收渲染层麦克风分片 */
  public addMicChunk(data: unknown): void {
    if (!this.isRecording || !this.collector) return;
    if (!ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) return;
    this.collector.addChunk(data as ArrayBuffer | Uint8Array);
  }

  /**
   * 开发/性能测试：注入 WAV 走完整识别管线（Worker → 快速通道/LLM → 分发）
   * 音频只进内存，不落盘；与 F8 录音链路共用同一套处理代码
   * @param wavB64 完整 WAV 文件的 base64（16k/16bit/单声道）
   */
  public async debugInjectWav(wavB64: string): Promise<AiExecuteResult> {
    if (this.busy) {
      return { success: false, message: "上一条指令仍在处理中" };
    }
    const wavFile = Buffer.from(wavB64, "base64");
    // 解析 RIFF 找 data 块（SAPI WAV 的 fmt 块为 18 字节，data 不固定在 44 偏移）
    let dataOff = -1;
    try {
      let off = 12;
      while (off + 8 <= wavFile.length) {
        const id = wavFile.toString("ascii", off, off + 4);
        const size = wavFile.readUInt32LE(off + 4);
        if (id === "data") {
          dataOff = off + 8;
          break;
        }
        off += 8 + size + (size % 2);
      }
    } catch {
      /* 走下方统一报错 */
    }
    if (dataOff < 0) {
      return { success: false, message: "注入失败：无法解析 WAV data 块" };
    }
    const trace = new PerfTrace();
    const collector = new AudioBufferCollector();
    collector.addChunk(wavFile.subarray(dataOff));
    const wav = collector.toWav();
    if (!wav) {
      aiLog.warn("(dev-inject) 无有效语音:", collector.lastFinalizeDiag);
      return { success: false, message: `注入音频无有效语音（${collector.lastFinalizeDiag}）` };
    }
    trace.done("prep");
    try {
      this.emitStatus({ state: "recognizing", message: "正在识别语音" });
      const tracks = await this.getLibraryTracks();
      const result = await asrService.transcribe(wav, collector.durationMs, buildWhisperPrompt(tracks));
      trace.done(`asr(${result.provider}${result.language ? ":" + result.language : ""})`);
      const text = dedupeRepeats(result.text.trim());
      if (!text) {
        return { success: true, message: "未能识别出内容" };
      }
      // busy 由 handleRecognizedText 自行管理（含 finally 释放）
      return await this.handleRecognizedText(text, trace);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      aiLog.error("(dev-inject) 识别失败:", message);
      return { success: false, message };
    }
  }
}

/** 全局 AI 服务单例 */
export const aiService = new AiService();
