import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { aiLog } from "../logger";
import { getAiCacheDir } from "./ai-config";
import { dedupeRepeats } from "./song-recall";
import type { AiSettings } from "@shared";

/** 识别超时（毫秒） */
const RECOGNIZE_TIMEOUT_MS = 120_000;

/** 清理 whisper 输出中的时间戳、特殊标记与复读循环伪影 */
const cleanWhisperOutput = (raw: string): string =>
  dedupeRepeats(
    raw
      .split(/\r?\n/)
      .map((line) =>
        line
          // 去除 [00:00:00.000 --> 00:00:02.000] 时间戳前缀
          .replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, "")
          // 去除 whisper 特殊标记
          .replace(/<\|[^|]*\|>/g, "")
          .trim(),
      )
      .filter(Boolean)
      .join(" ")
      .trim(),
  );

/**
 * 调用 whisper-cli 识别 WAV 音频（子进程，不阻塞主线程）
 * @param wav 完整 WAV 文件内容
 * @param settings AI 设置（含 whisper 程序与模型路径）
 * @param prompt 初始提示词（曲库歌手词表，提升专有名词识别，可空）
 * @returns 识别文本
 */
export const recognizeWav = async (
  wav: Buffer,
  settings: AiSettings,
  prompt = "",
): Promise<string> => {
  if (!settings.whisperExePath || !existsSync(settings.whisperExePath)) {
    throw new Error("未找到 whisper 程序，请在 AI 设置中配置 whisper-cli 路径");
  }
  if (!settings.whisperModelPath || !existsSync(settings.whisperModelPath)) {
    throw new Error("未找到 whisper 模型文件，请在 AI 设置中配置模型路径");
  }

  const tempWav = join(getAiCacheDir(), `rec-${Date.now()}.wav`);
  await writeFile(tempWav, wav);

  // 以 exe 所在目录为工作目录，模型路径尽量转成相对路径：
  // 实测绝对中文模型路径会触发 ggml 动态后端加载崩溃（0xC0000409），相对路径稳定
  const exeDir = dirname(resolve(settings.whisperExePath));
  let modelArg = resolve(settings.whisperModelPath);
  const relModel = relative(exeDir, modelArg);
  if (relModel && !isAbsolute(relModel)) {
    modelArg = relModel;
  }

  try {
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        settings.whisperExePath,
        [
          "-m",
          modelArg,
          "-l",
          settings.whisperLanguage || "zh",
          "-f",
          tempWav,
          "-np",
          "-nt",
          // 曲库歌手词表作为初始提示，显著提升歌名/歌手名识别
          ...(prompt ? ["--prompt", prompt] : []),
        ],
        { windowsHide: true, cwd: exeDir },
      );

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("语音识别超时"));
      }, RECOGNIZE_TIMEOUT_MS);

      // ⚠️ 必须先攒 Buffer 最后一次性解码：逐块 toString 会把被
      // 分块边界切断的中文（3 字节 UTF-8）变成乱码替换符
      child.stdout.on("data", (d: Buffer) => stdoutChunks.push(d));
      child.stderr.on("data", (d: Buffer) => stderrChunks.push(d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`whisper 程序启动失败: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(Buffer.concat(stdoutChunks).toString("utf-8"));
        } else {
          const stderr = Buffer.concat(stderrChunks).toString("utf-8");
          aiLog.error("whisper 进程退出异常:", code, stderr.slice(0, 400));
          reject(new Error(`whisper 识别失败（退出码 ${code}）`));
        }
      });
    });

    const text = cleanWhisperOutput(result);
    aiLog.info(`whisper 识别完成: ${text.slice(0, 80)}`);
    // 识别成功，临时音频用后即删
    unlink(tempWav).catch(() => undefined);
    return text;
  } catch (e) {
    // 识别失败时保留临时文件用于排查
    aiLog.warn(`whisper 识别失败，保留临时文件: ${tempWav}`);
    throw e;
  }
};
