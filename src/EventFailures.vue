<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { SessionState } from "../shared/types.ts";
import { api, message } from "./api.ts";

const props = defineProps<{
  failures: SessionState["eventFailures"];
  userId: string;
  issue?: string;
}>();
const emit = defineEmits<{ refresh: [] }>();
const busy = ref(false),
  error = ref("");
let lifetime = new AbortController();
watch(
  () => props.userId,
  () => {
    lifetime.abort();
    lifetime = new AbortController();
    busy.value = false;
    error.value = "";
  },
);
onBeforeUnmount(() => lifetime.abort());
async function retry() {
  if (busy.value) return;
  const controller = lifetime;
  busy.value = true;
  error.value = "";
  try {
    await api("/api/events/retry", {
      body: {},
      userId: props.userId,
      signal: controller.signal,
    });
    if (!controller.signal.aborted) emit("refresh");
  } catch (cause) {
    if (!controller.signal.aborted) {
      error.value = message(cause);
      emit("refresh"); // Local replay can succeed even when fetching new events fails.
    }
  } finally {
    if (!controller.signal.aborted) busy.value = false;
  }
}
</script>

<template>
  <details v-if="failures?.length || issue" class="surface">
    <summary>事件处理诊断（最多显示 20 条）</summary>
    <table><thead><tr><th>事件 / 受理号</th><th>原因</th><th>累计失败次数</th><th>重试状态</th></tr></thead><tbody><tr v-for="item in failures" :key="item.eventKey"><td>{{ item.submissionNo || item.eventKey }}</td><td>{{ item.reason }}</td><td>{{ item.attempts }}</td><td>{{ item.paused ? '已暂停自动重试' : item.nextAttemptAt ? new Date(item.nextAttemptAt).toLocaleString() : '等待处理' }}</td></tr></tbody></table>
    <p class="hint">原文与累计失败次数保留，暂停不代表处理成功。排查原因后，可重新处理当前用户的待处理及暂停事件；不会重新提交生成任务。</p>
    <button :disabled="busy" @click="retry">{{ busy ? '正在重试…' : '重试待处理及暂停事件' }}</button>
    <p v-if="error" class="error">{{ error }}</p>
  </details>
</template>
