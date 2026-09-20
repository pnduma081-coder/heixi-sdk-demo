<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onlineSdkUrl, sdkDocs } from "../shared/sdk-release.ts";
import type {
  ConnectionReport,
  DemoConfig,
  SessionState,
  StoredResult,
} from "../shared/types.ts";
import Icon from "./AppIcon.vue";
import { api, message, pretty } from "./api.ts";
import { loadSdk } from "./sdk.ts";

const props = defineProps<{
  section: string;
  session: SessionState;
  config: DemoConfig;
  busy: boolean;
}>();
const emit = defineEmits<{
  switchUser: [id: string];
  addUser: [name: string];
  recharge: [];
  refresh: [];
}>();
const name = ref(""),
  search = ref(""),
  filter = ref("all"),
  selected = ref<StoredResult>();
const checking = ref(false),
  connection = ref<ConnectionReport>(),
  connectionError = ref("");
const connectionLifetime = new AbortController();
const docs = sdkDocs();
const sdkAddress = onlineSdkUrl;
const sdkLoading = ref(false),
  sdkLoaded = ref(false),
  sdkLoadError = ref("");
async function checkSdkFile() {
  sdkLoading.value = true;
  sdkLoadError.value = "";
  try {
    await loadSdk(sdkAddress);
    sdkLoaded.value = true;
  } catch (error) {
    sdkLoadError.value =
      error instanceof Error ? error.message : "SDK 加载失败";
  } finally {
    sdkLoading.value = false;
  }
}
async function diagnose() {
  if (checking.value) return;
  checking.value = true;
  connection.value = undefined;
  connectionError.value = "";
  try {
    connection.value = await api<ConnectionReport>("/api/connection/check", {
      body: {},
      userId: props.session.user.id,
      signal: connectionLifetime.signal,
    });
  } catch (error) {
    if (!connectionLifetime.signal.aborted)
      connectionError.value = message(error);
  } finally {
    checking.value = false;
  }
}
const users = computed(() =>
  props.session.users.filter((user) =>
    `${user.name} ${user.externalUserId}`
      .toLowerCase()
      .includes(search.value.toLowerCase()),
  ),
);
const works = computed(() =>
  props.session.results.filter(
    (work) =>
      filter.value === "all" ||
      (filter.value === "text"
        ? !work.files.length
        : work.files.some((file) => file.contentType.startsWith(filter.value))),
  ),
);
const types: Record<string, string> = {
  TOPUP: "测试充值",
  SALE_DEBIT: "生成消费（商户售价）",
  SALE_REFUND: "生成退款（原售价）",
  "credits.debited": "历史生成扣费",
  "credits.refunded": "历史生成退款",
  "credits.license_debited": "模板解锁",
};
const status: Record<string, string> = {
  SUCCEEDED: "已完成",
  PARTIAL: "部分完成",
  FAILED: "生成失败",
  APPLIED: "已应用",
};
function textOf(work: StoredResult) {
  const items =
    work.source === "APPLY" ? work.payload.items : work.payload.tasks;
  if (!Array.isArray(items)) return "已保存的创作内容";
  return (
    items
      .map((task) =>
        task && typeof task === "object" && typeof task.text === "string"
          ? task.text
          : "",
      )
      .filter(Boolean)
      .join("\n") || "已保存的创作内容"
  );
}
watch(
  () => props.session.users.length,
  (count, previous) => {
    if (count > previous) name.value = "";
  },
);
function closeOnEscape(event: KeyboardEvent) {
  if (event.key === "Escape") selected.value = undefined;
}
onMounted(() => document.addEventListener("keydown", closeOnEscape));
onBeforeUnmount(() => {
  connectionLifetime.abort();
  document.removeEventListener("keydown", closeOnEscape);
});
</script>

<template>
  <div class="management-page">
    <template v-if="section === 'users'">
      <div class="page-heading"><div><h1>用户管理</h1><p>选择本地用户，体验各自独立的创作记录与算力账户。</p></div><span class="count-badge">{{ session.users.length }} 位用户</span></div>
      <div class="surface"><div class="toolbar"><input v-model="search" placeholder="搜索用户名称" aria-label="搜索用户" /><form class="actions" @submit.prevent="emit('addUser', name)"><input v-model="name" placeholder="新用户名称" aria-label="新用户名称" maxlength="80" /><button class="primary" :disabled="busy || !name.trim()">新增用户</button></form></div>
        <table><thead><tr><th>用户</th><th>用户标识</th><th>可用算力</th><th>状态</th><th></th></tr></thead><tbody><tr v-for="user in users" :key="user.id"><td><span class="user-cell"><span class="avatar">{{ user.name.slice(-1) }}</span>{{ user.name }}</span></td><td class="muted mono">{{ user.externalUserId }}</td><td>{{ user.credits.toLocaleString() }}</td><td><span class="pill" :class="{ 'pill--green': user.id === session.user.id }">{{ user.id === session.user.id ? '当前账户' : '可切换' }}</span></td><td><button :disabled="busy || user.id === session.user.id" @click="emit('switchUser', user.id)">切换用户</button></td></tr></tbody></table><p v-if="!users.length" class="empty-caption">没有找到对应用户</p>
      </div>
    </template>
    <template v-else-if="section === 'credits'">
      <div class="page-heading"><div><h1>算力账户</h1><p>查看当前账户的充值、消费与退款记录。</p></div><button @click="emit('refresh')"><Icon name="refresh" />刷新记录</button></div>
      <div class="balance-banner"><div><span>当前可用算力</span><strong>{{ session.user.credits.toLocaleString() }}<small>算力</small></strong><p>{{ session.user.name }} · 本地测试账户</p></div><button class="primary" @click="emit('recharge')">增加测试算力</button></div>
      <p v-if="session.pendingSales?.length" class="hint" role="status">有 {{ session.pendingSales.length }} 条售价结算等待原报价或原扣费关联；关联完成前不改变用户余额。</p>
      <div class="surface"><h2>算力明细</h2><table><thead><tr><th>时间</th><th>业务类型</th><th>变动算力</th><th>余额</th></tr></thead><tbody><tr v-for="item in session.ledger" :key="item.id"><td>{{ new Date(item.createdAt).toLocaleString() }}</td><td>{{ types[item.kind] || item.kind }}</td><td :class="item.delta > 0 ? 'positive' : 'negative'">{{ item.delta > 0 ? '+' : '' }}{{ item.delta }}</td><td>{{ item.balance }}</td></tr></tbody></table><p v-if="!session.ledger.length" class="empty-caption">暂无算力记录，可以先增加测试算力开始创作。</p></div>
      <details class="surface"><summary>平台成本记录（AI 成本不计入用户余额）</summary><p class="hint">AI 生成按确认时的商户售价结算。模板解锁保留原扣费规则，暂未接入自定义售价。</p><table><thead><tr><th>时间</th><th>平台业务</th><th>成本变动</th></tr></thead><tbody><tr v-for="item in session.platformCosts || []" :key="item.eventId"><td>{{ new Date(item.createdAt).toLocaleString() }}</td><td>{{ item.kind }}</td><td>{{ item.delta }}</td></tr></tbody></table><p v-if="!session.platformCosts?.length" class="empty-caption">暂无平台成本记录</p></details>
    </template>
    <template v-else-if="section === 'works'">
      <div class="page-heading"><div><h1>我的作品</h1><p>已保存到当前平台的创作结果，按用户独立管理。</p></div><button @click="emit('refresh')"><Icon name="refresh" />刷新作品</button></div>
      <div class="tabs"><button v-for="[id, title] in [['all', '全部作品'], ['image', '图片'], ['video', '视频'], ['text', '文本']]" :key="id" :class="{ active: filter === id }" @click="filter = id">{{ title }}</button></div>
      <div v-if="works.length" class="works-grid"><article v-for="work in works" :key="work.id" class="work-card"><button class="work-preview" @click="selected = work"><img v-if="work.files[0]?.contentType.startsWith('image/')" :src="`/files/${work.files[0].id}`" alt="作品预览" /><span v-else-if="work.files[0]?.contentType.startsWith('video/')" class="video-preview"><Icon name="video" />视频作品</span><span v-else class="text-preview">{{ textOf(work) }}</span></button><div class="work-info"><strong>{{ work.source === 'APPLY' ? '已应用作品' : '生成作品' }}</strong><span class="pill">{{ status[work.status] || work.status }}</span><small>{{ new Date(work.createdAt).toLocaleString() }}</small><button @click="selected = work">查看作品 <Icon name="arrow" /></button></div></article></div>
      <div v-else class="empty-state"><span class="state-symbol"><Icon name="folder" /></span><h2>开始你的第一份创作</h2><p>生成并保存后，作品会出现在这里。</p><RouterLink class="button primary" to="/create/main-image">去创作 <Icon name="arrow" /></RouterLink></div>
      <Teleport to="body"><div v-if="selected" class="modal-backdrop" @click.self="selected = undefined"><section class="modal work-modal" role="dialog" aria-modal="true" aria-labelledby="work-title"><div class="modal-heading"><h2 id="work-title">作品详情</h2><button class="icon-button" aria-label="关闭作品详情" @click="selected = undefined"><Icon name="close" /></button></div><div v-for="file in selected.files" :key="file.id" class="work-file"><img v-if="file.contentType.startsWith('image/')" :src="`/files/${file.id}`" :alt="file.name" /><video v-else :src="`/files/${file.id}`" controls preload="metadata"><track kind="captions" /></video><a :href="`/files/${file.id}`" target="_blank" rel="noreferrer">打开文件 · {{ Math.ceil(file.bytes / 1024) }} KiB</a></div><p class="text-content" v-if="!selected.files.length">{{ textOf(selected) }}</p><details><summary>记录详情</summary><pre>{{ pretty(selected.payload) }}</pre></details></section></div></Teleport>
    </template>
    <template v-else>
      <div class="page-heading"><div><h1>平台接入</h1><p>查看本平台与黑犀创作服务的连接配置。</p></div><button class="primary" :disabled="checking" @click="diagnose">{{ checking ? '正在检测…' : '检测接入' }}</button></div>
      <p v-if="connectionError" class="error" role="alert">{{ connectionError }}</p>
      <section v-if="connection" class="surface connection-report" aria-label="接入检测结果" aria-live="polite"><h2>接入检测结果</h2><p class="hint">后端 API：{{ connection.apiOrigin }} · SDK 来源：{{ connection.parentOrigin }}</p><article v-for="check in connection.checks" :key="check.name"><h3><span class="pill" :class="{ 'pill--green': check.status === 'passed' }">{{ check.status === 'passed' ? '通过' : '未通过' }}</span> {{ check.name }}</h3><p>{{ check.message }}</p><details v-if="check.details"><summary>平台错误与 traceId</summary><pre>{{ pretty(check.details) }}</pre></details></article></section>
      <div class="integration-grid">
        <div class="surface">
          <h2>接入状态</h2>
          <div class="setting-row"><span>接入环境</span><span>正式 SDK 0.3.0</span></div>
          <div class="setting-row"><span>商户 API Key</span><span class="pill" :class="{ 'pill--green': config.apiReady }">{{ config.apiReady ? '已配置，待检测' : '待配置' }}</span></div>
          <div class="setting-row"><span>SDK 组件</span><span class="pill" :class="{ 'pill--green': sdkLoaded }">{{ sdkLoaded ? '本页已加载' : 'CDN 地址已配置，待浏览器加载' }}</span></div>
          <p class="hint">API Key 在本项目 .env.local 中填写，保存后由用户重启本项目。回调验签配置仅由服务端获取。</p>
          <p class="hint">固定加载正式 0.3.0 产物，加载失败不会回退到本地 SDK。嵌入页面由平台授权响应确定。</p>
          <p v-for="issue in config.configurationIssues" :key="issue" class="hint">{{ issue }}</p>
          <button :disabled="sdkLoading || !config.sdkReady" @click="checkSdkFile">{{ sdkLoading ? '正在加载组件…' : '检测 SDK 文件加载' }}</button>
          <p v-if="sdkLoadError" class="error" role="alert">{{ sdkLoadError }}</p>
          <p v-if="sdkLoaded" class="hint">脚本已加载；签名、嵌入握手与功能授权仍需实际打开 SDK 验证。</p>
        </div>
        <div class="surface"><h2>连接地址</h2><dl>
          <dt>后端 API origin</dt><dd><code>{{ config.apiOrigin || config.sdkApiOrigin }}</code></dd>
          <dt>SDK 使用的 API origin</dt><dd><code>{{ config.sdkApiOrigin }}</code></dd>
          <dt>SDK 资源</dt><dd><code>{{ sdkAddress }}</code></dd>
          <dt>宿主页 / SDK 允许来源</dt><dd><code>{{ config.hostOrigin }}</code></dd>
          <dt>算力变动回调</dt><dd><code>{{ config.callbackOrigin || config.hostOrigin }}/webhooks/credits</code></dd>
          <dt>生成结果回调</dt><dd><code>{{ config.callbackOrigin || config.hostOrigin }}/webhooks/generation</code></dd>
        </dl></div>
      </div>
      <div class="surface integration-help"><h2>连接前检查</h2><ol>
        <li>当前环境的商户已启用，所属站点有效，并获得对应创作功能授权。</li>
        <li>在黑犀平台保存实际 HTTPS 宿主页 origin 与两个回调地址。回调域名不等于宿主页入口。</li>
        <li>通过上方 HTTPS 宿主页打开 SDK；页面代理与回调使用不同域名，本机继续使用 HTTP 回源。</li>
        <li>检测不会发起生成或充值；真实线上生成会消耗商户余额，由用户明确执行。</li>
      </ol><div class="actions"><a class="button" :href="docs.sdkDocsUrl" target="_blank" rel="noreferrer">SDK 文档</a><a class="button" :href="docs.apiDocsUrl" target="_blank" rel="noreferrer">API 文档</a></div></div>
    </template>
  </div>
</template>
