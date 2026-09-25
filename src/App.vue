<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import type { DemoConfig, SessionState } from "../shared/types.ts";
import Icon from "./AppIcon.vue";
import { api, message } from "./api.ts";
import {
  accountPages,
  apiTestPage,
  menu,
  tools,
  usePage,
} from "./navigation.ts";
import PagePlaceholder from "./PagePlaceholder.vue";
import { SessionRefresh } from "./session-refresh.ts";

const config = ref<DemoConfig>(),
  session = ref<SessionState>(),
  error = ref("");
const busy = ref(false),
  switching = ref(false),
  topupOpen = ref(false),
  amount = ref(1000),
  mobileMenu = ref(false);
const page = usePage(),
  route = useRoute();
const subtools = computed(() =>
  tools.filter((tool) => tool.group === page.value.group),
);
let generation = 0,
  topupId = crypto.randomUUID();
const lifetime = new AbortController();
const sessionRefresh = new SessionRefresh(async () => {
  const version = generation;
  const state = await api<SessionState>("/api/session", {
    signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
  });
  if (version !== generation || lifetime.signal.aborted) return;
  session.value = state;
});
function refresh() {
  return sessionRefresh.refresh();
}
function requestRefresh() {
  void refresh().catch((cause) => {
    if (!lifetime.signal.aborted) error.value = message(cause);
  });
}
async function initialize() {
  config.value = await api<DemoConfig>("/api/config", {
    signal: lifetime.signal,
  });
  await refresh();
}
async function run(work: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  try {
    await work();
  } catch (cause) {
    if (!lifetime.signal.aborted) error.value = message(cause);
  } finally {
    busy.value = false;
  }
}
async function switchUser(id: string) {
  if (id === session.value?.user.id) return;
  await run(async () => {
    switching.value = true;
    topupOpen.value = false;
    generation++;
    try {
      await api("/api/session", {
        body: { userId: id },
        signal: lifetime.signal,
      });
      topupId = crypto.randomUUID();
      await refresh();
    } finally {
      switching.value = false;
    }
  });
}
function chooseUser(event: Event) {
  void switchUser((event.target as HTMLSelectElement).value);
}
async function createUser(name: string) {
  await run(async () => {
    await api("/api/users", {
      body: { name },
      userId: session.value?.user.id,
      signal: lifetime.signal,
    });
    await refresh();
  });
}
function openTopup() {
  topupId = crypto.randomUUID();
  topupOpen.value = true;
}
function newTopupRequest() {
  topupId = crypto.randomUUID();
}
async function topup() {
  await run(async () => {
    await api("/api/credits", {
      body: { amount: amount.value, requestId: topupId },
      userId: session.value?.user.id,
      signal: lifetime.signal,
    });
    topupId = crypto.randomUUID();
    topupOpen.value = false;
    await refresh();
  });
}
function handleEscape(event: KeyboardEvent) {
  if (event.key === "Escape") {
    topupOpen.value = false;
    mobileMenu.value = false;
  }
}
watch(
  () => route.fullPath,
  () => {
    mobileMenu.value = false;
    error.value = "";
    document.title = `${page.value.title} · 黑犀创作平台`;
    // 进入本地数据页时读取一次，后台完成的结果也可通过手动刷新查看。
    if (
      session.value &&
      config.value &&
      !switching.value &&
      !page.value.sdkPage
    )
      requestRefresh();
  },
);
onMounted(async () => {
  document.addEventListener("keydown", handleEscape);
  document.title = `${page.value.title} · 黑犀创作平台`;
  await run(initialize);
});
onBeforeUnmount(() => {
  sessionRefresh.stop();
  lifetime.abort();
  document.removeEventListener("keydown", handleEscape);
});
</script>

<template>
  <div class="platform-shell">
    <button v-if="mobileMenu" class="sidebar-scrim" aria-label="关闭导航" @click="mobileMenu = false"></button>
    <aside class="platform-sidebar" :class="{ 'platform-sidebar--open': mobileMenu }" aria-label="平台导航">
      <RouterLink class="brand" to="/"><span class="brand-mark">犀</span><span>黑犀创作<span class="brand-subtitle">CREATIVE STUDIO</span></span></RouterLink>
      <div class="nav-label">创作工作台</div>
      <nav class="business-nav" aria-label="创作菜单"><RouterLink v-for="item in menu" :key="item.group" :to="item.path" :class="{ active: page.group === item.group }" :aria-current="page.group === item.group ? 'page' : undefined"><Icon :name="item.icon" /><span>{{ item.title }}</span><Icon v-if="item.group === 'apparel' || item.group === 'video'" class="menu-chevron" name="chevron" /></RouterLink><RouterLink :to="apiTestPage.path" :class="{ active: page.section === apiTestPage.section }"><Icon :name="apiTestPage.icon" /><span>{{ apiTestPage.title }}</span></RouterLink></nav>
      <div class="nav-label account-label">我的空间</div>
      <nav class="account-nav" aria-label="账户菜单"><RouterLink v-for="item in accountPages" :key="item.path" :to="item.path" :class="{ active: page.section === item.section }"><Icon :name="item.icon" /><span>{{ item.title }}</span></RouterLink></nav>
      <div class="sidebar-foot"><span class="status-dot"></span>本地创作平台</div>
    </aside>
    <div class="platform-body">
      <header class="platform-topbar"><div class="page-breadcrumb"><button class="icon-button mobile-menu-toggle" aria-label="展开导航" @click="mobileMenu = !mobileMenu"><Icon name="menu" /></button><span>{{ page.sdkPage || page.section === 'api-test' ? '创作工作台' : '我的空间' }}</span><Icon name="chevron" /><strong>{{ page.title }}</strong></div><div v-if="session" class="account-actions"><button class="icon-button" aria-label="刷新账户数据" title="刷新账户数据" :disabled="busy || switching" @click="run(refresh)"><Icon name="refresh" /></button><button class="credit-balance" @click="openTopup"><Icon name="wallet" /><strong>{{ session.user.credits.toLocaleString() }}</strong><span>算力</span><span class="recharge-label">充值</span></button><span class="topbar-divider"></span><span class="avatar">{{ session.user.name.slice(-1) }}</span><select :value="session.user.id" :disabled="busy" aria-label="当前用户" @change="chooseUser"><option v-for="user in session.users" :key="user.id" :value="user.id">{{ user.name }}</option></select></div></header>
      <div v-if="error" class="app-alert" role="alert"><Icon name="warning" /><span>{{ error }}</span><button class="icon-button" aria-label="关闭提示" @click="error = ''"><Icon name="close" /></button></div>
      <main class="platform-main" :class="{ 'platform-main--creation': page.sdkPage }">
        <div v-if="page.sdkPage && subtools.length > 1" class="tool-tabs" :aria-label="`${page.title}功能导航`"><RouterLink v-for="tool in subtools" :key="tool.page" :to="tool.path" :class="{ active: page.sdkPage === tool.page }">{{ tool.title }}</RouterLink></div>
        <template v-if="!session || !config || switching"><div v-if="error" class="workspace-state" role="alert"><p>暂时无法进入工作台，请重试。</p><button @click="run(initialize)">重试</button></div><PagePlaceholder v-else :label="switching ? '正在切换账户…' : '正在进入工作台…'" /></template>
        <RouterView v-else v-slot="{ Component }">
          <component v-if="page.sdkPage" :is="Component" :key="`sdk-${session.user.id}`" :user="session.user" :config="config" :page="page.sdkPage" :title="page.title" :resource-id="page.resourceId" @refresh="requestRefresh" @recharge="openTopup" />
          <component v-else-if="page.section === 'api-test'" :is="Component" :key="`api-test-${session.user.id}`" :session="session" :ready="config.apiReady" @refresh="requestRefresh" />
          <div v-else-if="page.section === 'api'" class="management-page"><div class="page-heading"><div><h1>API 调试</h1><p>用于开发联调的接口示例与请求记录。</p></div></div><component :is="Component" :key="session.user.id" :user="session.user" :ready="config.apiReady" :requests="session.requests" @refresh="requestRefresh" /></div>
          <component v-else :is="Component" :key="`${page.section}-${session.user.id}`" :section="page.section" :session="session" :config="config" :busy="busy" @switch-user="switchUser" @add-user="createUser" @recharge="openTopup" @refresh="requestRefresh" />
        </RouterView>
      </main>
    </div>
    <Teleport to="body"><div v-if="topupOpen && session" class="modal-backdrop" @click.self="topupOpen = false"><form class="modal" role="dialog" aria-modal="true" aria-labelledby="topup-title" @submit.prevent="topup"><div class="modal-heading"><h2 id="topup-title">增加测试算力</h2><button type="button" class="icon-button" aria-label="关闭充值" @click="topupOpen = false"><Icon name="close" /></button></div><p>{{ session.user.name }} · 当前可用 {{ session.user.credits.toLocaleString() }} 算力</p><label class="field-label" for="topup-amount">充值数量</label><input id="topup-amount" v-model.number="amount" type="number" min="1" step="1" required @change="newTopupRequest" /><p class="hint">增加本地账户余额，用于测试生成前的算力校验。</p><p v-if="error" class="error" role="alert">{{ error }}</p><button class="primary full-width" :disabled="busy">{{ busy ? '正在处理…' : '确认充值' }}</button></form></div></Teleport>
  </div>
</template>
