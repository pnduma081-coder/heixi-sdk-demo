<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { delayedFeedback } from "./delayed-feedback.ts";

defineProps<{ label?: string }>();
const visible = ref(false);
const feedback = delayedFeedback((value) => {
  visible.value = value;
});
feedback.set(true);
onBeforeUnmount(() => feedback.dispose());
</script>

<template>
  <div class="page-placeholder" aria-busy="true">
    <div class="placeholder-shapes" aria-hidden="true"><span></span><span></span><span></span></div>
    <p v-if="visible" role="status">{{ label || '正在打开页面…' }}</p>
  </div>
</template>
