import type { SettingConfig } from "@/types/settings";
import { useAiStore } from "@/stores";
import { computed, h } from "vue";
import { NTag } from "naive-ui";

/**
 * AI 语音助手设置
 * 设置真身保存在主进程 userData/ai/config.json，此处通过 aiStore 镜像读写
 */
export const useAiSettings = (): SettingConfig => {
  const aiStore = useAiStore();

  /** 模型连接状态描述 */
  const connectionDesc = computed(() => aiStore.settings.enabled ? "AI 助手已启用" : "AI 助手未启用");

  const stateTag = () =>
    h(
      NTag,
      {
        size: "small",
        round: true,
        type:
          aiStore.state === "error"
            ? "error"
            : aiStore.state === "recording"
              ? "warning"
              : aiStore.state === "completed"
                ? "success"
                : "info",
      },
      { default: () => aiStore.state },
    );

  /** ASR Worker 状态标签（进入设置页时刷新一次） */
  const asrStatusTag = () => {
    void aiStore.refreshAsrStatus();
    const s = aiStore.asrStatus;
    if (!s) {
      return h(NTag, { size: "small", round: true, type: "info" }, { default: () => "未查询" });
    }
    const [type, text] = s.ready
      ? (["success", `就绪（加载 ${Math.round((s.loadMs ?? 0) / 1000)}s · 显存 ${Math.round(s.reservedVramMb ?? 0)}MB）`] as const)
      : s.breakerOpen
        ? (["error", `故障熔断：${s.lastError ?? "重复启动失败"}`] as const)
        : s.running
          ? (["warning", "启动中…"] as const)
          : (["default", "未运行（说出第一句话时启动）"] as const);
    return h(NTag, { size: "small", round: true, type }, { default: () => text });
  };

  return {
    groups: [
      {
        title: "基础设置",
        items: [
          {
            key: "aiEnabled",
            label: "启用 AI 语音助手",
            description: "关闭后不占用麦克风、快捷键与模型资源，播放器功能不受影响",
            type: "switch",
            value: computed({
              get: () => aiStore.settings.enabled,
              set: (v) => aiStore.updateSettings({ enabled: v }),
            }),
          },
          {
            key: "aiTriggerMode",
            label: "触发方式",
            description: "按住说话（推荐）：按住快捷键录音，松开自动识别；点击切换：单击开始，再击结束",
            type: "select",
            options: [
              { label: "按住说话", value: "push" },
              { label: "点击切换", value: "toggle" },
            ],
            value: computed({
              get: () => aiStore.settings.triggerMode,
              set: (v) => aiStore.updateSettings({ triggerMode: v }),
            }),
            condition: () => aiStore.settings.enabled,
          },
          {
            key: "aiShortcutKey",
            label: "语音快捷键",
            description: "全局快捷键，在其他应用前台时也可使用",
            type: "select",
            options: [
              { label: "F8", value: "F8" },
              { label: "F9", value: "F9" },
              { label: "F10", value: "F10" },
            ],
            value: computed({
              get: () => aiStore.settings.shortcutKey,
              set: (v) => aiStore.updateSettings({ shortcutKey: v }),
            }),
            condition: () => aiStore.settings.enabled,
          },
          {
            key: "aiDuckPlayback",
            label: "录音时自动暂停播放",
            description: "按住快捷键说话时自动暂停音乐，说完自动续播，避免外放音乐干扰识别",
            type: "switch",
            value: computed({
              get: () => aiStore.settings.duckPlayback,
              set: (v) => aiStore.updateSettings({ duckPlayback: v }),
            }),
            condition: () => aiStore.settings.enabled,
          },
          {
            key: "aiState",
            label: "当前状态",
            type: "custom",
            component: h("div", { style: "padding: 4px 0" }, [stateTag()]),
            condition: () => aiStore.settings.enabled,
          },
        ],
      },
      {
        title: "语音识别引擎",
        items: [
          {
            key: "aiAsrProvider",
            label: "识别引擎",
            description:
              "Qwen3-ASR（推荐）：本地 Python 常驻 Worker，多语种自动检测，热态识别约 0.4 秒；whisper-cli：备用引擎，两者都配置时 Qwen3 失败会自动回退 whisper",
            type: "select",
            options: [
              { label: "Qwen3-ASR（推荐）", value: "qwen3" },
              { label: "whisper-cli（备用）", value: "whisper" },
            ],
            value: computed({
              get: () => aiStore.settings.asrProvider,
              set: (v) => aiStore.updateSettings({ asrProvider: v as "qwen3" | "whisper" }),
            }),
          },
          {
            key: "aiAsrPython",
            label: "Python 解释器路径",
            description:
              "Qwen3-ASR Worker 专用虚拟环境的 python.exe（需已安装 qwen-asr 与 CUDA 版 torch）；模型仅加载一次，常驻显存约 1.8GB",
            type: "text-input",
            value: computed({
              get: () => aiStore.settings.asrPythonPath,
              set: (v) => aiStore.updateSettings({ asrPythonPath: String(v ?? "") }),
            }),
            condition: () => aiStore.settings.asrProvider === "qwen3",
          },
          {
            key: "aiAsrModel",
            label: "Qwen3-ASR 模型目录",
            description:
              "包含 model.safetensors 的模型文件夹（Qwen3-ASR-0.6B，约 1.8GB）。路径请避免中文，部分推理库无法读取非 ASCII 路径",
            type: "text-input",
            value: computed({
              get: () => aiStore.settings.asrModelPath,
              set: (v) => aiStore.updateSettings({ asrModelPath: String(v ?? "") }),
            }),
            condition: () => aiStore.settings.asrProvider === "qwen3",
          },
          {
            key: "aiAsrStatus",
            label: "Worker 状态",
            type: "custom",
            component: h("div", { style: "padding: 4px 0" }, [asrStatusTag()]),
            condition: () => aiStore.settings.asrProvider === "qwen3",
          },
          {
            key: "aiWhisperExe",
            label: "whisper-cli 程序路径（回退引擎）",
            description:
              "whisper.cpp 的 whisper-cli.exe 完整路径（其同目录需包含 whisper.dll 等依赖）",
            type: "text-input",
            value: computed({
              get: () => aiStore.settings.whisperExePath,
              set: (v) => aiStore.updateSettings({ whisperExePath: String(v ?? "") }),
            }),
          },
          {
            key: "aiWhisperModel",
            label: "whisper 模型路径（回退引擎）",
            description:
              "ggml 模型文件路径。推荐 large-v3-turbo（约 1.6GB，中文最准，配合 CUDA 版 whisper-cli 速度极佳）；small（约 465MB）为速度优先备选",
            type: "text-input",
            value: computed({
              get: () => aiStore.settings.whisperModelPath,
              set: (v) => aiStore.updateSettings({ whisperModelPath: String(v ?? "") }),
            }),
          },
          {
            key: "aiWhisperLanguage",
            label: "whisper 识别语言",
            description: "仅 whisper 引擎使用；Qwen3-ASR 自动检测 30 种语言",
            type: "select",
            options: [
              { label: "中文", value: "zh" },
              { label: "英语", value: "en" },
              { label: "自动", value: "auto" },
            ],
            value: computed({
              get: () => aiStore.settings.whisperLanguage,
              set: (v) => aiStore.updateSettings({ whisperLanguage: v }),
            }),
          },
          {
            key: "aiMaxRecordMs",
            label: "最长录音时长（毫秒）",
            description: "超过该时长自动结束录音并开始识别",
            type: "input-number",
            min: 3000,
            max: 60000,
            step: 1000,
            value: computed({
              get: () => aiStore.settings.maxRecordMs,
              set: (v) => aiStore.updateSettings({ maxRecordMs: Number(v) || 15000 }),
            }),
          },
        ],
      },
      {
        title: "模型设置",
        items: [
          {
            key: "aiOllamaBaseUrl",
            label: "Ollama 服务地址",
            description: "本地 Ollama 接口地址，默认 http://127.0.0.1:11434",
            type: "text-input",
            value: computed({
              get: () => aiStore.settings.ollamaBaseUrl,
              set: (v) => aiStore.updateSettings({ ollamaBaseUrl: String(v ?? "") }),
            }),
          },
          {
            key: "aiOllamaModel",
            label: "指令理解模型",
            description: "Ollama 模型名，如 qwen2.5:7b（需支持 JSON 输出）",
            type: "text-input",
            value: computed({
              get: () => aiStore.settings.ollamaModel,
              set: (v) => aiStore.updateSettings({ ollamaModel: String(v ?? "") }),
            }),
          },
          {
            key: "aiOllamaTimeout",
            label: "模型超时（毫秒）",
            type: "input-number",
            min: 5000,
            max: 300000,
            step: 5000,
            value: computed({
              get: () => aiStore.settings.ollamaTimeoutMs,
              set: (v) => aiStore.updateSettings({ ollamaTimeoutMs: Number(v) || 60000 }),
            }),
          },
          {
            key: "aiTemperature",
            label: "温度参数",
            description: "越低输出越稳定，指令解析建议 0.1",
            type: "slider",
            min: 0,
            max: 1,
            step: 0.05,
            value: computed({
              get: () => aiStore.settings.ollamaTemperature,
              set: (v) => aiStore.updateSettings({ ollamaTemperature: Number(v) }),
            }),
          },
          {
            key: "aiTestConnection",
            label: "连接测试",
            description: connectionDesc.value,
            type: "button",
            buttonLabel: "测试 Ollama 连接",
            action: async () => {
              const result = await aiStore.testOllama();
              if (result.ok) {
                window.$message.success(
                  `连接成功：Ollama ${result.version ?? ""}，可用模型 ${(result.models ?? []).join("、") || "无"}`,
                  { duration: 5000 },
                );
              } else {
                window.$message.error(`连接失败：${result.error ?? "未知错误"}`);
              }
            },
          },
        ],
      },
      {
        title: "指令设置",
        items: [
          {
            key: "aiAutoPlayBestMatch",
            label: "多匹配时自动播放最匹配项",
            description: "关闭后，同名歌曲存在多个版本时会提示手动确认",
            type: "switch",
            value: computed({
              get: () => aiStore.settings.autoPlayBestMatch,
              set: (v) => aiStore.updateSettings({ autoPlayBestMatch: v }),
            }),
          },
        ],
      },
      {
        title: "隐私设置",
        items: [
          {
            key: "aiSaveHistory",
            label: "记录指令历史",
            description: "在本地记录 AI 指令与执行结果；原始录音永不保存",
            type: "switch",
            value: computed({
              get: () => aiStore.settings.saveHistory,
              set: (v) => aiStore.updateSettings({ saveHistory: v }),
            }),
          },
          {
            key: "aiSaveRecognizedText",
            label: "历史中保存识别文本",
            type: "switch",
            value: computed({
              get: () => aiStore.settings.saveRecognizedText,
              set: (v) => aiStore.updateSettings({ saveRecognizedText: v }),
            }),
            condition: () => aiStore.settings.saveHistory,
          },
          {
            key: "aiClearHistory",
            label: "清理历史数据",
            description: "清空本地保存的 AI 指令历史",
            type: "button",
            buttonLabel: "清空历史",
            action: async () => {
              await aiStore.clearHistory();
              window.$message.success("AI 历史已清空");
            },
          },
        ],
      },
    ],
  };
};
