import { aiLog } from "../logger";
import type { AiOllamaStatus } from "@shared";

/** 带超时的 fetch 封装 */
const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/** 测试 Ollama 连接并返回版本与模型列表 */
export const checkOllama = async (
  baseUrl: string,
  timeoutMs = 5000,
): Promise<AiOllamaStatus> => {
  try {
    const res = await fetchWithTimeout(
      `${baseUrl.replace(/\/$/, "")}/api/version`,
      { method: "GET" },
      timeoutMs,
    );
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const version = ((await res.json()) as { version?: string }).version;
    const models = await listOllamaModels(baseUrl, timeoutMs);
    return { ok: true, version, models };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    aiLog.warn("Ollama 连接失败:", message);
    return { ok: false, error: message };
  }
};

/** 获取本地模型列表 */
export const listOllamaModels = async (
  baseUrl: string,
  timeoutMs = 5000,
): Promise<string[]> => {
  const res = await fetchWithTimeout(
    `${baseUrl.replace(/\/$/, "")}/api/tags`,
    { method: "GET" },
    timeoutMs,
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name);
};

/** 聊天请求参数 */
interface ChatOptions {
  baseUrl: string;
  model: string;
  system: string;
  user: string;
  timeoutMs: number;
  temperature: number;
  /** 强制 JSON 输出 */
  jsonMode?: boolean;
  /** 上下文窗口（指令场景 2048 足够，减小 KV 显存占用） */
  numCtx?: number;
  /** 模型保留时长（如 "5m"；不传用 Ollama 默认） */
  keepAlive?: string;
  /** 最大生成 token 数 */
  numPredict?: number;
}

/** 调用 /api/chat 获取模型回复文本（非流式） */
export const chatOllama = async (options: ChatOptions): Promise<string> => {
  const { baseUrl, model, system, user, timeoutMs, temperature, jsonMode = true, numCtx, keepAlive, numPredict } = options;
  const res = await fetchWithTimeout(
    `${baseUrl.replace(/\/$/, "")}/api/chat`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        ...(jsonMode ? { format: "json" } : {}),
        ...(keepAlive ? { keep_alive: keepAlive } : {}),
        options: {
          temperature,
          num_predict: numPredict ?? 256,
          ...(numCtx ? { num_ctx: numCtx } : {}),
        },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    },
    timeoutMs,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? "";
};
