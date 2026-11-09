/** 采集参数：16kHz 单声道 16bit PCM */
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

/** 低于该时长（毫秒）视为无效录音 */
export const MIN_AUDIO_MS = 300;

/** 静音判定阈值（Int16 振幅，约 -48dBFS；远场小信号也能过线） */
const SILENCE_THRESHOLD = 120;

/** 归一化目标峰值（Int16，约 -6dBFS） */
const TARGET_PEAK = 16000;

/** 增益上限（约 +28dB），避免把纯噪声放大成幻觉源 */
const MAX_GAIN = 25;

/** 有效语音最短时长（毫秒）：低于此值视为没有说话 */
const MIN_VOICED_MS = 200;

/** 内存音频缓冲：汇聚渲染层上送的 PCM 分片并组装 WAV */
export class AudioBufferCollector {
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  /** 上次 finalize 失败的诊断信息（供日志排查） */
  lastFinalizeDiag = "";

  /** 追加一块 PCM 分片 */
  addChunk(data: ArrayBuffer | Uint8Array): void {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
    if (buf.length === 0) return;
    this.chunks.push(buf);
    this.totalBytes += buf.length;
  }

  /** 缓冲字节数 */
  get sizeBytes(): number {
    return this.totalBytes;
  }

  /** 估算录音时长（毫秒） */
  get durationMs(): number {
    return (this.totalBytes / (BYTES_PER_SAMPLE * (SAMPLE_RATE / 1000))) | 0;
  }

  /** 是否为有效录音 */
  get isValid(): boolean {
    return this.durationMs >= MIN_AUDIO_MS;
  }

  /**
   * 预处理：裁剪首尾静音 + 峰值归一化（远场小信号增益）
   * 返回处理后的 PCM；若无有效语音返回 null
   */
  private finalizePcm(): Buffer | null {
    const raw = Buffer.concat(this.chunks);
    const samples = raw.length / 2;
    if (samples === 0) return null;

    // 找首尾有效语音位置与全局峰值
    let firstVoiced = -1;
    let lastVoiced = -1;
    let peak = 0;
    let voicedSamples = 0;
    for (let i = 0; i < samples; i++) {
      const amp = Math.abs(raw.readInt16LE(i * 2));
      if (amp > SILENCE_THRESHOLD) {
        if (firstVoiced < 0) firstVoiced = i;
        lastVoiced = i;
        voicedSamples++;
      }
      if (amp > peak) peak = amp;
    }
    // 有效语音占比过低（如整段只有噪声尖峰）视为无效
    if (firstVoiced < 0 || (voicedSamples / samples) * 1000 < MIN_VOICED_MS) {
      this.lastFinalizeDiag = `samples=${samples} peak=${peak} voiced=${Math.round((voicedSamples / samples) * 1000)}ms`;
      return null;
    }

    // 裁剪首尾各留 120ms 缓冲
    const pad = Math.min(1920, SAMPLE_RATE * 0.12);
    const start = Math.max(0, firstVoiced - pad);
    const end = Math.min(samples, lastVoiced + pad);
    const trimmed = raw.subarray(start * 2, end * 2);

    // 峰值归一化：远场小信号放大到目标电平（只放大不衰减）
    const gain = peak > 0 ? Math.min(TARGET_PEAK / peak, MAX_GAIN) : 1;
    if (gain <= 1.01) {
      return trimmed;
    }
    const out = Buffer.alloc(trimmed.length);
    for (let i = 0; i < trimmed.length; i += 2) {
      const scaled = Math.round(trimmed.readInt16LE(i) * gain);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), i);
    }
    return out;
  }

  /** 组装 WAV（16kHz 单声道 16bit），含静音裁剪与增益归一化 */
  toWav(): Buffer | null {
    const pcm = this.finalizePcm();
    if (!pcm) return null;

    const header = Buffer.alloc(44);
    const dataSize = pcm.length;
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // 单声道
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
    header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcm]);
  }

  /** 清空缓冲 */
  reset(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
