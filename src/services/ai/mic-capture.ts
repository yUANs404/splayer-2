/**
 * 渲染层麦克风采集服务
 * 仅在主进程下发 MIC_START 后工作；窗口隐藏在托盘时渲染进程仍存活，可后台采集
 */

const SAMPLE_RATE = 16000;

let audioCtx: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let processor: ScriptProcessorNode | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;

/** Float32 [-1,1] 转 Int16 PCM */
const floatToInt16 = (input: Float32Array): Int16Array => {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
};

/** 是否正在采集 */
export const isMicCapturing = (): boolean => audioCtx !== null;

/** 开始采集并上送分片 */
export const startMicCapture = async (): Promise<void> => {
  if (audioCtx) return;
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const pcm = floatToInt16(input);
    // Int16Array 一定持有普通 ArrayBuffer，此处收窄类型
    window.ai?.sendMicChunk(pcm.buffer as ArrayBuffer);
  };
  sourceNode.connect(processor);
  // ScriptProcessor 需要连接输出才会运行；输出静音避免回声
  const silent = audioCtx.createGain();
  silent.gain.value = 0;
  processor.connect(silent);
  silent.connect(audioCtx.destination);
};

/** 停止采集并释放全部资源 */
export const stopMicCapture = (): void => {
  try {
    if (processor) {
      processor.onaudioprocess = null;
      processor.disconnect();
    }
    sourceNode?.disconnect();
    mediaStream?.getTracks().forEach((t) => t.stop());
    audioCtx?.close().catch(() => undefined);
  } catch {
    // 释放失败不阻塞
  } finally {
    processor = null;
    sourceNode = null;
    mediaStream = null;
    audioCtx = null;
  }
};
