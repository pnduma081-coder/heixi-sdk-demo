<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type {
  JsonObject,
  RequestRecord,
  SessionState,
} from "../shared/types.ts";
import { api, message } from "./api.ts";
import {
  asObject,
  mainImageRequest,
  submissionNumber,
  testRequests,
  testResults,
} from "./api-test.ts";
import { GenerationPoller } from "./generation-poller.ts";

const props = defineProps<{
  session: SessionState;
  ready: boolean;
}>();
const emit = defineEmits<{ refresh: [] }>();
const actorId = props.session.user.id;
const lifetime = new AbortController();
const model = ref<JsonObject>(),
  modelName = computed(() => String(model.value?.modelName || ""));
const asset = ref<{ assetId: string; name: string }>();
const preview = ref(""),
  prompt = ref(""),
  error = ref("");
const busy = ref(false),
  loadingModel = ref(false),
  submitted = ref(false);
const originalRequest = ref<JsonObject>(),
  activeId = ref(""),
  submissionNo = ref("");
const finalStatus = ref<JsonObject>(),
  statusError = ref("");
const pollPaused = ref(false);
const requests = computed(() => testRequests(props.session.requests));
const results = computed(() =>
  testResults(props.session.results, props.session.requests, actorId),
);
const saved = computed(() =>
  results.value.find((item) => item.payload.clientRequestId === activeId.value),
);
const statusText = computed(() => {
  if (saved.value)
    return saved.value.files.length
      ? "结果图片已保存"
      : "已保存终态，本次未生成可保存图片";
  if (finalStatus.value?.terminal === true)
    return "平台已结束生成，后台继续同步和保存结果，可手动刷新查看";
  if (submissionNo.value) return "已受理，正在生成；结果保存后显示";
  if (busy.value && originalRequest.value) return "正在提交生成请求，请稍候";
  if (originalRequest.value)
    return submitted.value
      ? "提交已返回，正在确认受理状态"
      : "提交结果未确定，请用原请求重试";
  return "上传一张商品图片，描述需要的主图效果";
});
const canSubmit = computed(
  () =>
    props.ready &&
    !busy.value &&
    !loadingModel.value &&
    !submitted.value &&
    Boolean(
      originalRequest.value ||
        (model.value && asset.value && prompt.value.trim()),
    ),
);
const call = (operation: string, params: JsonObject) =>
  api<unknown>("/api/call", {
    body: { operation, params },
    userId: actorId,
    signal: lifetime.signal,
  });
async function loadModel() {
  loadingModel.value = true;
  error.value = "";
  try {
    const list = await call("models", {
      capability: "main_image",
      configKey: "main_image",
      feature: "MAIN_IMAGE",
    });
    if (!Array.isArray(list) || !list.length)
      throw new Error("暂无可用主图模型，请检查功能授权");
    model.value = asObject(
      list.find((item) => asObject(item).isDefault === true) || list[0],
    );
  } catch (cause) {
    if (!lifetime.signal.aborted) error.value = message(cause);
  } finally {
    loadingModel.value = false;
  }
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  busy.value = true;
  error.value = "";
  try {
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 19 * 1024 * 1024
    )
      throw new Error("请选择 19 MiB 以内的 PNG、JPG 或 WebP 图片");
    const form = new FormData();
    form.set("file", file);
    const result = await api<{ assetId: string }>("/api/materials/image", {
      form,
      userId: actorId,
      signal: lifetime.signal,
    });
    if (lifetime.signal.aborted) return;
    if (!result.assetId) throw new Error("上传未返回素材，请重新上传");
    if (preview.value) URL.revokeObjectURL(preview.value);
    asset.value = { assetId: result.assetId, name: file.name };
    preview.value = URL.createObjectURL(file);
  } catch (cause) {
    if (!lifetime.signal.aborted) error.value = message(cause);
  } finally {
    busy.value = false;
    input.value = "";
  }
}
async function submit() {
  if (!canSubmit.value) return;
  busy.value = true;
  error.value = "";
  try {
    if (!originalRequest.value) {
      if (!model.value || !asset.value) return;
      originalRequest.value = mainImageRequest(
        model.value,
        asset.value,
        prompt.value,
        crypto.randomUUID(),
      );
    }
    activeId.value = String(originalRequest.value.clientRequestId);
    const result = await call("design", originalRequest.value);
    if (lifetime.signal.aborted) return;
    submissionNo.value = submissionNumber(result);
    if (!submissionNo.value)
      throw new Error("未取得受理号，请保留原请求重试确认");
    submitted.value = true;
    startPolling();
  } catch (cause) {
    if (!lifetime.signal.aborted) error.value = message(cause);
  } finally {
    busy.value = false;
    if (!lifetime.signal.aborted) emit("refresh");
  }
}
const statusPoller = new GenerationPoller<JsonObject>({
  read: async (no, signal) =>
    asObject(
      await api("/api/call", {
        body: { operation: "generation", params: { submissionNo: no } },
        userId: actorId,
        signal: AbortSignal.any([lifetime.signal, signal]),
      }),
    ),
  apply: (result) => {
    finalStatus.value = result;
    statusError.value = "";
    const complete = result.terminal === true || Boolean(saved.value);
    if (complete) emit("refresh");
    return complete;
  },
  error: (cause) => {
    statusError.value = message(cause);
  },
  state: (state) => {
    pollPaused.value = state === "paused";
  },
  hidden: () => document.hidden,
});
function readStatus() {
  return statusPoller.refresh(submissionNo.value);
}
function visibilityChanged() {
  statusPoller.visibilityChanged();
}
function restore(item: RequestRecord) {
  stopPolling();
  originalRequest.value = item.body;
  activeId.value = item.id;
  prompt.value = String(asObject(item.body.spec).productDescription || "");
  const ids = item.body.sourceAssetIds;
  asset.value =
    Array.isArray(ids) && typeof ids[0] === "string"
      ? {
          assetId: ids[0],
          name: String(
            asObject(item.body.context).fileName || "已上传商品图片",
          ),
        }
      : undefined;
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = "";
  finalStatus.value = undefined;
  error.value = "";
  submissionNo.value = submissionNumber(item.response);
  submitted.value = Boolean(submissionNo.value);
  statusError.value = "";
  startPolling();
}
function newTest() {
  stopPolling();
  originalRequest.value = undefined;
  activeId.value = "";
  submissionNo.value = "";
  finalStatus.value = undefined;
  submitted.value = false;
  error.value = "";
  statusError.value = "";
  pollPaused.value = false;
}
async function retryEvents() {
  try {
    await api("/api/events/retry", {
      body: {},
      userId: actorId,
      signal: lifetime.signal,
    });
    if (!lifetime.signal.aborted) emit("refresh");
  } catch (cause) {
    if (!lifetime.signal.aborted) statusError.value = message(cause);
  }
}
function stopPolling() {
  statusPoller.stop();
}
function startPolling() {
  statusPoller.start(submissionNo.value);
}
onMounted(() => {
  document.addEventListener("visibilitychange", visibilityChanged);
  if (requests.value[0]) restore(requests.value[0]);
  if (props.ready) void loadModel();
});
onBeforeUnmount(() => {
  lifetime.abort();
  statusPoller.dispose();
  document.removeEventListener("visibilitychange", visibilityChanged);
  if (preview.value) URL.revokeObjectURL(preview.value);
});
</script>

<template>
  <div class="management-page api-test-page">
    <div class="page-heading"><div><h1>API 测试</h1><p>上传商品图片并填写需求，通过 API 生成一张爆款首图。</p></div><span class="pill">{{ session.user.name }}</span></div>
    <p class="hint">由商户后端直接调用生成接口，实际消耗由黑犀商户账户结算。</p>
    <p v-if="!ready" class="error">请先在接入设置中完成 API 配置。</p>
    <div class="api-test-layout">
      <form class="surface api-test-form" @submit.prevent="submit">
        <h2>生成主图</h2>
        <label class="field-label" for="api-test-image">商品图片（单张）</label>
        <input id="api-test-image" type="file" accept="image/png,image/jpeg,image/webp" :disabled="busy || Boolean(originalRequest) || !ready" @change="upload" />
        <img v-if="preview" class="api-test-source" :src="preview" alt="已上传的商品图片" />
        <p v-if="asset" class="hint" role="status">已上传：{{ asset.name }}</p>
        <label class="field-label" for="api-test-prompt">对话 / 生成需求</label>
        <textarea id="api-test-prompt" v-model="prompt" placeholder="例如：保留商品外观，生成白色背景的电商主图，光影自然，不添加文字。" maxlength="2000" :disabled="busy || Boolean(originalRequest)" required></textarea>
        <p class="hint">{{ loadingModel ? '正在加载模型…' : modelName ? `模型：${modelName} · 生成 1 张` : '尚未加载模型' }}</p>
        <div class="actions"><button class="primary" :disabled="!canSubmit">{{ busy ? '正在处理…' : submitted ? '已提交' : originalRequest ? '使用原请求重试' : '提交生成' }}</button><button v-if="originalRequest" type="button" :disabled="busy" @click="newTest">新建测试</button><button v-else-if="!model && ready" type="button" :disabled="loadingModel" @click="loadModel">重新加载模型</button></div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
      </form>
      <section class="surface api-test-results" aria-label="API 测试结果">
        <div class="page-heading"><h2>生成结果</h2><button type="button" @click="readStatus">刷新状态</button></div>
        <p role="status">{{ statusText }}</p>
        <p v-if="submissionNo" class="hint">受理号：{{ submissionNo }}</p>
        <p class="hint">服务器轮询事件或收到可选回调后保存图片，刷新页面后仍会保留。</p>
        <p v-if="finalStatus?.credits" class="hint">商户实际消费：{{ asObject(finalStatus.credits).charged }} · 退款：{{ asObject(finalStatus.credits).refunded }} · 净消费：{{ asObject(finalStatus.credits).net }}（不是用户售价）</p>
        <p v-if="session.eventSyncError" class="error">{{ session.eventSyncError }} <button type="button" @click="retryEvents">重试待处理事件</button></p>
        <p v-if="pollPaused" class="hint">自动状态查询已暂停（达到时限或连续失败），后台事件同步仍在运行。<button type="button" @click="startPolling">继续查询</button></p>
        <p v-if="statusError" class="error" role="alert">{{ statusError }}</p>
        <p v-if="!saved && session.generationFailure?.submissionNo === submissionNo" class="error" role="alert">最近一次结果未保存：{{ session.generationFailure.reason }}（{{ new Date(session.generationFailure.at).toLocaleString() }}）。请保留原请求，等待服务端重试同步。</p>
        <div v-if="!results.length" class="empty-caption">暂无已保存结果</div>
        <article v-for="result in results" :key="result.id" class="api-test-result">
          <div class="actions"><strong>{{ result.files.length ? '已保存' : '已保存终态' }}</strong><span class="pill">{{ result.status }}</span></div>
          <p class="hint">{{ new Date(result.createdAt).toLocaleString() }} · {{ result.submissionNo }}</p>
          <template v-for="file in result.files" :key="file.id"><a v-if="file.contentType.startsWith('image/')" :href="`/files/${file.id}`" target="_blank" rel="noreferrer"><img :src="`/files/${file.id}`" alt="API 生成并保存的主图" /></a><p class="hint">本地文件 · {{ Math.ceil(file.bytes / 1024) }} KiB</p></template>
          <p v-if="!result.files.length">本次没有可展示的图片，请查看生成状态后再试。</p>
        </article>
      </section>
    </div>
    <section v-if="requests.length" class="surface api-test-history"><h2>测试请求</h2><table><thead><tr><th>时间</th><th>请求号</th><th>提交状态</th><th></th></tr></thead><tbody><tr v-for="request in requests" :key="request.id"><td>{{ new Date(request.createdAt).toLocaleString() }}</td><td class="mono">{{ request.id }}</td><td>{{ request.status === 'ACCEPTED' ? '已受理' : '待确认' }}</td><td><button :disabled="busy" @click="restore(request)">查看 / 恢复请求</button></td></tr></tbody></table></section>
  </div>
</template>
