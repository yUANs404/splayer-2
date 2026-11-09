"""SPlayer AI 语音助手 — Qwen3-ASR 常驻 Worker（阶段 4）

独立 Python 进程：模型只加载一次，GPU 常驻；Electron 主进程通过
stdin/stdout 行式 JSON 通信，音频以 WAV(base64) 传入，识别结果结构化返回。
全程本地执行，不落盘、不上传。

协议（每行一个 JSON，stderr 只写日志）：
  → {"event":"ready","load_ms":int,"warmup_ms":int,"device":str}   启动完成
  → {"event":"error","stage":"load","message":str}                  加载失败（致命，进程退出码 1）
  ← {"id":int,"type":"transcribe","wav_b64":str,"language":str|null}
  → {"id":int,"ok":true,"text":str,"language":str,"inference_ms":int}
  → {"id":int,"ok":false,"error":str}
  ← {"type":"ping"}                    → {"event":"pong"}
  ← {"type":"shutdown"}                → {"event":"bye"} 后退出

用法：
  python asr_worker.py --model <模型目录> [--device cuda:0] [--max-new-tokens 128]
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import sys
import time
import wave
from typing import Any

sys.stdout.reconfigure(encoding="utf-8", newline="\n")
sys.stderr.reconfigure(encoding="utf-8")

# Windows 下工作线程/异常日志统一走 stderr，stdout 只保留协议消息
def log(msg: str) -> None:
    print(f"[asr-worker] {msg}", file=sys.stderr, flush=True)


def emit(obj: dict[str, Any]) -> None:
    """写一行协议 JSON 并立即刷新（主进程靠行读取）"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def decode_wav(b64_data: str):
    """WAV bytes → (samples: float32 mono, sample_rate)；失败抛 ValueError"""
    import numpy as np

    raw = base64.b64decode(b64_data)
    with wave.open(io.BytesIO(raw), "rb") as wf:
        sr = wf.getframerate()
        channels = wf.getnchannels()
        width = wf.getsampwidth()
        frames = wf.readframes(wf.getnframes())
    if width != 2:
        raise ValueError(f"仅支持 16bit PCM，收到 sampwidth={width}")
    samples = np.frombuffer(frames, dtype=np.int16)
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1).astype(np.int16)
    return samples, sr


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="Qwen3-ASR 模型目录")
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--max-new-tokens", type=int, default=128)
    parser.add_argument("--max-batch", type=int, default=4)
    args = parser.parse_args()

    # ---------- 加载（只发生一次） ----------
    t0 = time.perf_counter()
    try:
        import torch
        from qwen_asr import Qwen3ASRModel

        device = args.device if torch.cuda.is_available() else "cpu"
        if device == "cpu":
            log("CUDA 不可用，回退 CPU 推理（延迟会显著上升）")
        model = Qwen3ASRModel.from_pretrained(
            args.model,
            dtype=torch.bfloat16 if device.startswith("cuda") else torch.float32,
            device_map=device,
            max_inference_batch_size=args.max_batch,
            max_new_tokens=args.max_new_tokens,
        )
        load_ms = int((time.perf_counter() - t0) * 1000)
    except Exception as e:  # 致命：无法服务
        emit({"event": "error", "stage": "load", "message": f"{type(e).__name__}: {e}"})
        sys.exit(1)

    # ---------- 预热：一条 0.2s 静音，触发 CUDA 内核编译 ----------
    import numpy as np

    warmup_ms = 0
    try:
        tw = time.perf_counter()
        silence = np.zeros(3200, dtype=np.int16)
        model.transcribe(audio=(silence, 16000), language="Chinese")
        warmup_ms = int((time.perf_counter() - tw) * 1000)
    except Exception as e:
        log(f"预热失败（不致命）: {e}")

    vram_mb = None
    try:
        if torch.cuda.is_available():
            vram_mb = round(torch.cuda.memory_reserved() / 1024 / 1024, 1)
    except Exception:
        pass
    emit({"event": "ready", "load_ms": load_ms, "warmup_ms": warmup_ms,
          "device": device, "reserved_vram_mb": vram_mb})
    log(f"ready model={args.model} device={device} load={load_ms}ms warmup={warmup_ms}ms vram={vram_mb}MB")

    # ---------- 请求循环 ----------
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            emit({"id": None, "ok": False, "error": f"协议错误：不是合法 JSON（{e}）"})
            continue

        rtype = req.get("type")
        if rtype == "ping":
            emit({"event": "pong"})
            continue
        if rtype == "shutdown":
            emit({"event": "bye"})
            sys.exit(0)

        rid = req.get("id")
        if rtype != "transcribe":
            emit({"id": rid, "ok": False, "error": f"未知请求类型 {rtype}"})
            continue
        try:
            samples, sr = decode_wav(req.get("wav_b64", ""))
            if samples.size == 0:
                emit({"id": rid, "ok": False, "error": "空音频"})
                continue
            language = req.get("language") or None  # null = 自动语种检测
            t = time.perf_counter()
            out = model.transcribe(audio=(samples, sr), language=language)
            infer_ms = int((time.perf_counter() - t) * 1000)
            r = out[0]
            text = (r.text or "").strip()
            emit({
                "id": rid,
                "ok": True,
                "text": text,
                "language": getattr(r, "language", None),
                "inference_ms": infer_ms,
            })
        except Exception as e:
            log(f"transcribe 失败: {type(e).__name__}: {e}")
            emit({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"})

    log("stdin 已关闭，退出")


if __name__ == "__main__":
    main()
