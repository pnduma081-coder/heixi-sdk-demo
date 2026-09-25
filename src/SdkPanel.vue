<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { onlineSdkUrl } from "../shared/sdk-release.ts";
import type { DemoConfig, User } from "../shared/types.ts";
import Icon from "./AppIcon.vue";
import { delayedFeedback } from "./delayed-feedback.ts";
import PagePlaceholder from "./PagePlaceholder.vue";
import { createSdkOptions, loadSdk } from "./sdk.ts";
import {
  SdkWorkspace,
  sdkFailureMessage,
  type WorkspaceState,
} from "./sdk-workspace.ts";

const props = defineProps<{
  user: User;
  config: DemoConfig;
  page: string;
  title: string;
  resourceId?: string;
}>();
const emit = defineEmits<{ refresh: []; recharge: [] }>();
const container = ref<HTMLElement>();
const state = ref<WorkspaceState>({ status: "loading" });
const httpsEntry = computed(() =>
  props.config.hostOrigin.startsWith("https://") &&
  props.config.hostOrigin !== location.origin
    ? `${props.config.hostOrigin}${location.pathname}${location.search}${location.hash}`
    : "",
);
const failure = ref(""),
  slowNavigation = ref(false);
const hasPage = computed(
  () =>
    state.value.status === "ready" ||
    state.value.status === "navigating" ||
    state.value.retainPage === true,
);
const navigationFeedback = delayedFeedback((value) => {
  slowNavigation.value = value;
});
watch(
  () => state.value.status === "navigating",
  (value) => navigationFeedback.set(value),
);
const actorId = props.user.id;
let mounted = false;
const workspace = new SdkWorkspace(
  async (target, signal) => {
    failure.value = "";
    if (!props.config.sdkReady)
      throw new Error("创作组件尚未配置，请检查接入设置。");
    if (!props.config.apiReady)
      throw new Error("尚未配置平台 API Key，请先完成接入设置。");
    if (
      location.protocol !== "https:" ||
      location.origin !== props.config.hostOrigin
    )
      throw Object.assign(new Error("SDK 页面来源与配置不一致"), {
        code: "HOST_ORIGIN_MISMATCH",
      });
    await loadSdk(onlineSdkUrl);
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    if (!container.value || !window.BlackRhinoSDK || signal.aborted)
      throw new DOMException("已取消", "AbortError");
    const openSdk = window.BlackRhinoSDK.init(
      createSdkOptions(actorId, {
        onRefresh: () => emit("refresh"),
        onRecharge: () => emit("recharge"),
        onError: (error) => {
          if (!signal.aborted && hasPage.value) workspace.fail(error);
        },
      }),
    );
    const startup = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      startup.abort();
    }, 45000);
    const credits = Math.max(0, props.user.credits),
      displayName = props.user.name;
    try {
      // 【SDK 对接点 1】打开创作页面：页面、余额和用户资料由宿主提供，之后用 update() 同步。
      const instance = await openSdk({
        container: container.value,
        ...target,
        credits,
        context: { demoUserId: actorId, example: "sdk-demo" },
        profile: { displayName },
        // 本示例显式打开顶部栏，方便验收充值、余额和用户资料交互。
        showHeader: true,
        signal: AbortSignal.any([signal, startup.signal]),
      });
      // openSdk 已等待 ready；不再因重复 host-state 请求延迟显示整个页面。
      // 初始化期间余额可能变化，后台补齐最新状态，不阻塞首次显示。
      if (
        credits !== Math.max(0, props.user.credits) ||
        displayName !== props.user.name
      )
        void instance
          .update({
            credits: Math.max(0, props.user.credits),
            profile: { displayName: props.user.name },
          })
          .catch(() => {
            if (!signal.aborted)
              failure.value = "算力信息暂未更新，请稍后重试。";
          });
      return instance;
    } catch (error) {
      if (timedOut)
        throw Object.assign(new Error("Page startup timed out"), {
          code: "TIMEOUT",
        });
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  },
  (value) => {
    state.value = value;
    failure.value =
      value.status === "error" ? sdkFailureMessage(value.error) : "";
  },
);
function show() {
  return workspace.show({
    page: props.page,
    ...(props.resourceId ? { resourceId: props.resourceId } : {}),
  });
}
onMounted(async () => {
  mounted = true;
  await nextTick();
  if (mounted) void show();
});
watch([() => props.page, () => props.resourceId], () => {
  if (mounted) void show();
});
watch([() => props.user.credits, () => props.user.name], () => {
  void workspace
    .update({
      credits: Math.max(0, props.user.credits),
      profile: { displayName: props.user.name },
    })
    .catch(() => {
      if (mounted) failure.value = "算力信息暂未更新，请稍后重试。";
    });
});
onBeforeUnmount(() => {
  mounted = false;
  navigationFeedback.dispose();
  workspace.dispose();
});
</script>

<template>
  <div class="sdk-workspace" :aria-label="`${title}创作工作区`" :aria-busy="state.status === 'loading' || state.status === 'navigating'">
    <div ref="container" class="sdk-mount" :class="{ 'sdk-mount--hidden': !hasPage }"></div>
    <PagePlaceholder v-if="state.status === 'loading'" />
    <div v-if="slowNavigation && state.status === 'navigating'" class="sdk-page-notice" role="status">正在切换页面…</div>
    <div v-if="state.status === 'ready' && failure" class="sdk-sync-warning" role="status">{{ failure }}</div>
    <div v-if="state.status === 'error' && hasPage" class="sdk-page-notice sdk-page-notice--error" role="alert"><span>{{ failure }}</span><button @click="workspace.retry()">重试</button></div>
    <div v-else-if="state.status === 'error'" class="workspace-state" role="alert">
      <span class="state-symbol"><Icon name="warning" /></span><h2>{{ title }}暂时无法打开</h2><p>{{ failure }}</p>
      <a v-if="httpsEntry" class="button primary" :href="httpsEntry" rel="noreferrer">打开 HTTPS 创作页面</a>
      <button v-else class="primary" @click="workspace.retry()"><Icon name="refresh" />重试</button>
    </div>
  </div>
</template>
