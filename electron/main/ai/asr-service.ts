/**
 * ASR 服务层（阶段 4）
 * 管理 Qwen3-ASR Python Worker 的生命周期（常驻 + 崩溃自动重启），
 * 统一暴露 transcribe(wav) → ASRResult；Worker 不可用时自动回退 whisper-cli。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { app } from "electron";
import { aiLog } from "../logger";
import { recognizeWav } from "./whisper-service";
import { getAiSettings } from "./ai-config";
import type { ASRResult, AiSettings } from "@shared";

/** Worker 连续失败进入熔断的次数（之后只走 whisper，避免反复重启拖慢请求） */
const MAX_CONSECUTIVE_FAILURES = 2;
/** 连续多少次"未 ready 即退出"后停止自动重启（避免崩溃风暴；改设置或新请求可再触发） */
const MAX_SPAWN_FAIL_STREAK = 3;
/** 熔断冷却：这段时间后允许再次尝试启动 Worker */
const BREAKER_COOLDOWN_MS = 60_000;

interface PendingRequest {
  resolve: (r: ASRResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Worker 运行状态（设置页展示用） */
export interface AsrWorkerStatus {
  running: boolean;
  ready: boolean;
  /** 进程级信息 */
  loadMs?: number;
  reservedVramMb?: number;
  restarts: number;
  lastError?: string;
  breakerOpen: boolean;
}

/** Qwen3-ASR 常驻 Worker 管理器 */
class AsrService {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private reqSeq = 0;
  private pending = new Map<number, PendingRequest>();
  private starting: Promise<void> | null = null;
  private restarts = 0;
  private consecutiveFailures = 0;
  private breakerOpenedAt = 0;
  private lastError: string | undefined;
  private loadMs: number | undefined;
  private reservedVramMb: number | undefined;
  /** 本次 spawn 后是否成功 ready 过（用于区分"崩溃"与"起不来"） */
  private wasReadyThisRun = false;
  /** 连续 spawn 失败次数（达到上限后停止自动重启） */
  private spawnFailStreak = 0;
  /** 启动时记录的配置，变化时自动重启 */
  private configSig: string | null = null;

  /** Worker 脚本路径（随应用分发：打包态 resources/ai/，开发态 仓库 ai/） */
  private workerScriptPath(): string {
    // 打包态：extraResources 落在 resources/ai/asr-worker/（asar 之外 Python 才能读）
    const candidates = [
      join(process.resourcesPath, "ai", "asr-worker", "asr_worker.py"),
      join(app.getAppPath(), "ai", "asr-worker", "asr_worker.py"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return candidates[1];
  }

  /** 当前配置是否具备启动条件 */
  private isConfigured(s: AiSettings): boolean {
    return Boolean(
      s.asrPythonPath &&
        existsSync(s.asrPythonPath) &&
        s.asrModelPath &&
        existsSync(s.asrModelPath),
    );
  }

  /** Worker 是否可用（未熔断且配置齐备） */
  isUsable(s: AiSettings): boolean {
    if (s.asrProvider !== "qwen3") return false;
    if (Date.now() - this.breakerOpenedAt < BREAKER_COOLDOWN_MS) return false;
    return this.isConfigured(s);
  }

  /** 设置页查询状态 */
  getStatus(): AsrWorkerStatus {
    const now = Date.now();
    return {
      running: Boolean(this.proc),
      ready: this.ready,
      loadMs: this.loadMs,
      reservedVramMb: this.reservedVramMb,
      restarts: this.restarts,
      lastError: this.lastError,
      breakerOpen: now - this.breakerOpenedAt < BREAKER_COOLDOWN_MS,
    };
  }

  /** 启动 Worker（幂等；配置变化时自动重启；显式调用会解除启动失败熔断） */
  async ensureStarted(fromAutoRestart = false): Promise<void> {
    const s = getAiSettings();
    if (s.asrProvider !== "qwen3" || !this.isConfigured(s)) {
      return; // 未配置时静默返回，调用方走 whisper 回退
    }
    if (!fromAutoRestart) {
      this.spawnFailStreak = 0;
    }
    const sig = `${s.asrPythonPath}|${s.asrModelPath}`;
    if (this.proc && this.configSig === sig) {
      return this.starting ?? Promise.resolve();
    }
    // 配置变化：重启
    if (this.proc) this.killWorker("配置变更");
    this.configSig = sig;
    this.starting = this.startWorker().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** 应用启动时后台预热（不抛错，失败只记日志） */
  warmup(): void {
    void this.ensureStarted().catch((e) => {
      aiLog.warn("ASR Worker 预热失败（将回退 whisper）:", e instanceof Error ? e.message : e);
    });
  }

  private startWorker(): Promise<void> {
    const s = getAiSettings();
    return new Promise<void>((resolve, reject) => {
      aiLog.info("启动 Qwen3-ASR Worker…");
      const child = spawn(
        s.asrPythonPath,
        [this.workerScriptPath(), "--model", s.asrModelPath, "--device", "cuda:0"],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      ) as ChildProcessWithoutNullStreams;
      this.proc = child;
      this.ready = false;
      this.wasReadyThisRun = false;

      // stderr 是日志通道（Python 侧所有日志写 stderr）
      const errTail: string[] = [];
      createInterface({ input: child.stderr }).on("line", (line) => {
        if (line.trim()) {
          errTail.push(line);
          if (errTail.length > 30) errTail.shift();
          aiLog.info(`(asr-worker)`, line.trim());
        }
      });

      // stdout 是协议通道（行式 JSON）
      const rl = createInterface({ input: child.stdout });
      const onLine = (line: string) => {
        if (!line.trim()) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return; // 非协议输出，忽略
        }
        if (msg.event === "ready") {
          this.ready = true;
          this.wasReadyThisRun = true;
          this.spawnFailStreak = 0;
          this.consecutiveFailures = 0;
          this.loadMs = msg.load_ms as number | undefined;
          this.reservedVramMb = msg.reserved_vram_mb as number | undefined;
          aiLog.info(
            `ASR Worker 就绪: load=${msg.load_ms}ms warmup=${msg.warmup_ms}ms vram=${msg.reserved_vram_mb}MB`,
          );
          rl.removeListener("line", onLine);
          rl.on("line", (l) => this.handleLine(l));
          resolve();
          return;
        }
        if (msg.event === "error" && msg.stage === "load") {
          const message = String(msg.message ?? "worker 加载失败");
          this.lastError = message;
          rl.removeListener("line", onLine);
          rl.close();
          reject(new Error(message));
          return;
        }
        // ready 之前的其他消息（不该出现）直接交 handleLine
        this.handleLine(line);
      };
      rl.on("line", onLine);

      child.on("error", (e) => {
        this.lastError = e.message;
        reject(new Error(`Python 启动失败: ${e.message}`));
      });
      child.on("close", (code) => this.onWorkerExit(code, errTail));
    });
  }

  /** Worker 进程退出：清理挂起请求并按需重启 */
  private onWorkerExit(code: number | null, errTail: string[]): void {
    const hadProc = this.proc !== null;
    this.proc = null;
    this.ready = false;
    if (!hadProc) return;
    aiLog.warn(`ASR Worker 退出（code=${code}）`);
    if (errTail.length) {
      this.lastError = errTail[errTail.length - 1];
    }
    // 失败的所有挂起请求
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("ASR Worker 进程已退出"));
    }
    this.pending.clear();
    // 非主动关闭时自动重启（冷却间隔，避免崩溃风暴）
    const s = getAiSettings();
    if (!this.wasReadyThisRun) {
      this.spawnFailStreak += 1;
      if (this.spawnFailStreak >= MAX_SPAWN_FAIL_STREAK) {
        aiLog.warn(`ASR Worker 连续 ${this.spawnFailStreak} 次启动失败，停止自动重启（更新设置或发起识别可再触发）`);
        this.lastError = this.lastError ?? "Worker 反复启动失败";
        return;
      }
    } else {
      this.spawnFailStreak = 0;
    }
    if (s.asrProvider === "qwen3" && this.isConfigured(s) && code !== 0) {
      this.restarts += 1;
      setTimeout(() => {
        if (!this.proc) {
          aiLog.info("ASR Worker 自动重启…");
          void this.ensureStarted(true).catch((e) =>
            aiLog.warn("ASR Worker 重启失败:", e instanceof Error ? e.message : e),
          );
        }
      }, 3000);
    }
  }

  /** 处理一行协议消息（ready 之后） */
  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg.id as number | null | undefined;
    if (id === null || id === undefined) return; // 事件类（pong/bye）暂无消费方
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (msg.ok === true) {
      pending.resolve({
        text: String(msg.text ?? "").trim(),
        language: msg.language as string | undefined,
        durationMs: 0, // 由调用方（AiService）用录音时长填充
        inferenceMs: Number(msg.inference_ms ?? 0),
        provider: "qwen3",
      });
    } else {
      pending.reject(new Error(String(msg.error ?? "worker 返回失败")));
    }
  }

  private killWorker(reason: string): void {
    if (!this.proc) return;
    aiLog.info(`关闭 ASR Worker（${reason}）`);
    try {
      this.proc.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
    } catch {
      /* 进程可能已死 */
    }
    const child = this.proc;
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill();
    }, 2000);
    this.proc = null;
    this.ready = false;
  }

  /**
   * 统一识别入口：qwen3 Worker 优先，失败/未配置回退 whisper-cli
   * @param wav 预处理后的完整 WAV
   * @param durationMs 有效录音时长（毫秒，用于 ASRResult）
   * @param whisperPrompt whisper 回退时的曲库提示词（qwen3 不需要）
   */
  async transcribe(wav: Buffer, durationMs: number, whisperPrompt = ""): Promise<ASRResult> {
    const s = getAiSettings();
    // 1) qwen3 路径
    if (this.isUsable(s)) {
      try {
        await this.ensureStarted();
        if (this.proc && this.ready) {
          const result = await this.transcribeViaWorker(wav, s.asrTimeoutMs);
          result.durationMs = durationMs;
          return result;
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.lastError = message;
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.breakerOpenedAt = Date.now();
          aiLog.warn(`ASR Worker 连续失败 ${this.consecutiveFailures} 次，熔断 ${BREAKER_COOLDOWN_MS / 1000}s 后重试`);
        }
        aiLog.warn("Qwen3-ASR 识别失败，回退 whisper:", message);
      }
    }
    // 2) whisper 回退（唯一兜底；未配置则报错）
    return this.transcribeViaWhisper(wav, durationMs, s, whisperPrompt);
  }

  /** 通过 Worker 协议识别 */
  private transcribeViaWorker(wav: Buffer, timeoutMs: number): Promise<ASRResult> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error("Worker 未运行"));
    const id = ++this.reqSeq;
    const payload = JSON.stringify({
      id,
      type: "transcribe",
      wav_b64: wav.toString("base64"),
      language: null, // 自动语种检测（zh/en/ko/ja…）
    });
    return new Promise<ASRResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 超时视为进程卡死：杀掉让自动重启接管
        aiLog.warn(`ASR Worker 识别超时（${timeoutMs}ms），重启进程`);
        try {
          proc.kill();
        } catch {
          /* noop */
        }
        reject(new Error("ASR 识别超时"));
      }, Math.max(3000, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(payload + "\n");
    });
  }

  /** whisper-cli 回退（沿用现有实现，输出统一格式） */
  private async transcribeViaWhisper(wav: Buffer, durationMs: number, s: AiSettings, prompt = ""): Promise<ASRResult> {
    if (!s.whisperExePath || !s.whisperModelPath) {
      throw new Error(
        this.lastError
          ? `Qwen3-ASR 与 whisper 均不可用（worker: ${this.lastError}）`
          : "未配置任何语音识别引擎（qwen3 或 whisper）",
      );
    }
    const t = Date.now();
    const text = await recognizeWav(wav, s, prompt);
    return {
      text,
      language: undefined,
      durationMs,
      inferenceMs: Date.now() - t,
      provider: "whisper",
    };
  }

  /** 应用退出时关闭 Worker */
  shutdown(): void {
    this.killWorker("应用退出");
  }
}

/** 全局单例 */
export const asrService = new AsrService();
