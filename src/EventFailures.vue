<script setup lang="ts">
import type { SessionState } from "../shared/types.ts";

defineProps<{ failures: SessionState["eventFailures"] }>();
</script>

<template>
  <details v-if="failures?.length" class="surface">
    <summary>事件处理诊断（最多显示 20 条）</summary>
    <table><thead><tr><th>事件 / 受理号</th><th>原因</th><th>已失败次数</th><th>最早重试时间</th></tr></thead><tbody><tr v-for="item in failures" :key="item.eventKey"><td>{{ item.submissionNo || item.eventKey }}</td><td>{{ item.reason }}</td><td>{{ item.attempts }}</td><td>{{ new Date(item.nextAttemptAt).toLocaleString() }}</td></tr></tbody></table>
    <p class="hint">原始事件已保存在服务端；后台会继续重试。这里不展示凭据或原始异常内容。</p>
  </details>
</template>
