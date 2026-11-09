<template>
  <div class="ai-panel">
    <!-- 状态区 -->
    <n-flex align="center" justify="space-between" class="head">
      <n-flex align="center" :size="8">
        <n-tag :type="stateTagType" size="small" round>{{ stateLabel }}</n-tag>
        <n-text v-if="aiStore.settings.enabled" :depth="3" class="hint">
          按住 {{ aiStore.settings.shortcutKey }} 说话，松开自动执行
        </n-text>
      </n-flex>
      <n-switch
        :value="aiStore.settings.enabled"
        :round="false"
        size="small"
        @update:value="(v: boolean) => aiStore.updateSettings({ enabled: v })"
      />
    </n-flex>

    <!-- 识别与结果 -->
    <div class="live">
      <div v-if="aiStore.recognizedText" class="block">
        <n-text :depth="3" class="label">识别内容</n-text>
        <n-text class="content">{{ aiStore.recognizedText }}</n-text>
      </div>
      <div v-if="aiStore.resultMessage" class="block">
        <n-text :depth="3" class="label">执行结果</n-text>
        <n-text :type="isError ? 'error' : 'default'" class="content">
          {{ aiStore.resultMessage }}
        </n-text>
      </div>
      <n-empty
        v-if="!aiStore.recognizedText && !aiStore.resultMessage"
        description="按住快捷键说出你的指令，例如「播放周杰伦的晴天」"
        :show-icon="false"
        class="empty"
      />
      <n-text v-if="!aiStore.settings.enabled" :depth="3" class="disabled-tip">
        AI 助手未启用，打开右上角开关后按快捷键说话
      </n-text>
    </div>

    <!-- 歧义确认 -->
    <div v-if="aiStore.status?.state === 'confirm' && aiStore.status.candidates?.length" class="confirm">
      <n-text :depth="3" class="label">{{ aiStore.status.message || "请选择你要听的版本" }}</n-text>
      <n-flex vertical :size="6" class="confirm-list">
        <n-button
          v-for="c in aiStore.status.candidates"
          :key="c.id"
          secondary
          size="small"
          @click="playCandidate(c.id)"
        >
          {{ c.title }} - {{ c.artist }}
        </n-button>
      </n-flex>
    </div>

    <!-- 历史 -->
    <div v-if="aiStore.history.length" class="history">
      <n-flex align="center" justify="space-between" class="history-head">
        <n-text :depth="3" class="label">最近指令</n-text>
        <n-button quaternary size="tiny" @click="aiStore.clearHistory()">清空</n-button>
      </n-flex>
      <n-scrollbar style="max-height: 180px">
        <div v-for="item in aiStore.history" :key="item.id" class="history-item">
          <n-text :depth="item.success ? 1 : 3" :type="item.success ? undefined : 'error'">
            {{ item.text || item.result }}
          </n-text>
          <n-text :depth="3" class="time">{{ formatTime(item.time) }}</n-text>
        </div>
      </n-scrollbar>
    </div>

    <!-- 底部入口 -->
    <n-flex justify="end" class="foot">
      <n-button quaternary size="small" @click="openAiSettings">AI 设置</n-button>
    </n-flex>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAiStore } from "@/stores";
import { openSetting } from "@/utils/modal";
import dayjs from "dayjs";

const aiStore = useAiStore();

const stateMap: Record<string, { label: string; type: "default" | "info" | "success" | "warning" | "error" }> = {
  idle: { label: "待命", type: "default" },
  recording: { label: "录音中", type: "warning" },
  processing: { label: "处理中", type: "info" },
  recognizing: { label: "识别中", type: "info" },
  thinking: { label: "思考中", type: "info" },
  executing: { label: "执行中", type: "info" },
  completed: { label: "完成", type: "success" },
  error: { label: "出错", type: "error" },
};

const stateLabel = computed(() => stateMap[aiStore.state]?.label ?? "待命");
const stateTagType = computed(() => stateMap[aiStore.state]?.type ?? "default");
const isError = computed(() => aiStore.state === "error");

const formatTime = (time: number) => dayjs(time).format("HH:mm:ss");

const playCandidate = (trackId: string) => {
  void window.ai.playTrack(trackId);
};

const openAiSettings = () => {
  openSetting("ai");
};
</script>

<style lang="scss" scoped>
.ai-panel {
  width: 100%;
}
.head {
  margin-bottom: 12px;
}
.hint {
  font-size: 12px;
}
.live {
  min-height: 120px;
  padding: 12px;
  border-radius: 8px;
  background: var(--n-color-embedded, rgba(128, 128, 128, 0.08));
  .block {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 10px;
    .content {
      font-size: 14px;
      line-height: 1.5;
    }
  }
  .label {
    font-size: 12px;
  }
  .empty {
    margin: 12px 0;
  }
  .disabled-tip {
    font-size: 12px;
  }
}
.confirm {
  margin-top: 12px;
  .label {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
  }
}
.history {
  margin-top: 12px;
  .history-head {
    margin-bottom: 4px;
  }
  .history-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 0;
    font-size: 13px;
    .time {
      flex-shrink: 0;
      font-size: 11px;
    }
  }
}
.foot {
  margin-top: 12px;
}
</style>
