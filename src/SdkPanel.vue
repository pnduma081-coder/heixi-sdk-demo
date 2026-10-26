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
import { createSdkOptions, loadSdk, localSdkTrace } from "./sdk.ts";
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
let stopTrace = () => {};
function observeLocalStartup() {
  if (props.config.sdkMode !== "f065-local") return;
  const receive = (event: MessageEvent) => {
    const frame = container.value?.querySelector("iframe");
    if (
      event.source !== frame?.contentWindow ||
      event.origin !== props.config.sdkApiOrigin ||
      event.data?.channel !== "black-rhino-sdk"
    )
      return;
    if (
      ["hello", "initialize", "fatal", "navigation"].includes(event.data.method)
    )
      localSdkTrace(`frame-${event.data.method}-${event.data.kind}`);
  };
  const resources = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const url = new URL(entry.name);
      if (
        url.origin === props.config.sdkApiOrigin &&
        url.pathname === "/api/v1/sdk/client/launch"
      )
        localSdkTrace("launch-response");
    }
  });
  resources.observe({ type: "resource", buffered: false });
  const frames = new MutationObserver(() => {
    const frame = container.value?.querySelector("iframe");
    if (frame && !frame.dataset.f065Observed) {
      frame.dataset.f065Observed = "true";
      localSdkTrace("iframe-created");
      frame.addEventListener("load", () => localSdkTrace("iframe-load"), {
        once: true,
      });
    }
  });
  if (container.value) frames.observe(container.value, { childList: true });
  window.addEventListener("message", receive);
  stopTrace = () => {
    window.removeEventListener("message", receive);
    resources.disconnect();
    frames.disconnect();
  };
}
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
    if (props.config.sdkMode === "f065-local") localSdkTrace("load-sdk-start");
    await loadSdk(
      props.config.sdkScriptUrl ?? onlineSdkUrl,
      props.config.sdkMode,
    );
    if (props.config.sdkMode === "f065-local")
      localSdkTrace("load-sdk-complete");
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    if (!container.value || !window.BlackRhinoSDK || signal.aborted)
      throw new DOMException("已取消", "AbortError");
    const openSdk = window.BlackRhinoSDK.init(
      createSdkOptions(actorId, {
        localReadOnly: props.config.sdkMode === "f065-local",
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
    const displayName = props.user.name;
    try {
      // 【SDK 对接点 1】本示例不提供用户钱包；credits 为协议必填显示值，0 有效。
      const instance = await openSdk({
        container: container.value,
        ...target,
        credits: 0,
        context: { demoUserId: actorId, example: "sdk-demo" },
        profile: { displayName },
        // 不把演示余额展示成真实商户余额，也不提供虚假的充值入口。
        showHeader: false,
        signal: AbortSignal.any([signal, startup.signal]),
      });
      // openSdk 已等待 ready；不再因重复 host-state 请求延迟显示整个页面。
      // 初始化期间用户资料可能变化，补齐资料，不阻塞首屏。
      if (displayName !== props.user.name)
        void instance
          .update({
            profile: { displayName: props.user.name },
          })
          .catch(() => {
            if (!signal.aborted)
              failure.value = "用户资料暂未更新，请稍后重试。";
          });
      if (props.config.sdkMode === "f065-local") localSdkTrace("ready");
      return instance;
    } catch (error) {
      if (props.config.sdkMode === "f065-local")
        localSdkTrace(timedOut ? "startup-timeout" : "startup-failed");
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
  if (mounted) {
    observeLocalStartup();
    void show();
  }
});
watch([() => props.page, () => props.resourceId], () => {
  if (mounted) void show();
});
watch(
  () => props.user.name,
  () => {
    void workspace
      .update({
        profile: { displayName: props.user.name },
      })
      .catch(() => {
        if (mounted) failure.value = "用户资料暂未更新，请稍后重试。";
      });
  },
);
onBeforeUnmount(() => {
  mounted = false;
  stopTrace();
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
