<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  JsonObject,
  RequestRecord,
  SessionState,
  StoredResult,
} from "../shared/types.ts";
import { api, message } from "./api.ts";
import {
  asObject,
  mainImageChoices,
  mainImageCredits,
  mainImageParameters,
  mainImageRequest,
  submissionNumber,
  testRequests,
  testResults,
} from "./api-test.ts";
import EventFailures from "./EventFailures.vue";
import { GenerationPoller } from "./generation-poller.ts";
import { imageCapability, imageOptions } from "./model-options.ts";
import { requestStatusLabel } from "./request-status.ts";
import { ResultWatcher } from "./result-watcher.ts";

const props = defineProps<{
  session: SessionState;
  ready: boolean;
}>();
const emit = defineEmits<{ refresh: [] }>();
const actorId = props.session.user.id;
const lifetime = new AbortController();
const models = ref<JsonObject[]>([]),
  selectedModelId = ref("");
const model = computed(() =>
  models.value.find((item) => item.id === selectedModelId.value),
);
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
const selection = ref<JsonObject>({});
const choices = computed(() =>
  mainImageChoices(model.value || {}, selection.value.resolution),
);
const parametersError = ref("");
const parametersLocked = computed(
  () =>
    !props.ready ||
    busy.value ||
    loadingModel.value ||
    !model.value ||
    Boolean(originalRequest.value),
);
function normalizeSelection() {
  if (originalRequest.value || !model.value) return;
  parametersError.value = "";
  try {
    const count = Number(selection.value.outputCount) || 1;
    selection.value = {
      ...imageOptions(imageCapability(model.value), selection.value),
      outputCount: Math.min(
        Math.max(Math.floor(count), 1),
        choices.value.counts.length,
      ),
    };
  } catch (cause) {
    selection.value = {};
    parametersError.value = message(cause);
  }
}
watch([model, originalRequest], normalizeSelection);
const estimate = computed(() => {
  if (!model.value) return undefined;
  try {
    const params =
      originalRequest.value ||
      mainImageParameters(model.value, selection.value);
    return {
      credits: mainImageCredits(model.value, params),
      parameters: [params.resolution, params.ratio, `${params.outputCount} 张`]
        .filter(Boolean)
        .join(" · "),
    };
  } catch {
    return undefined;
  }
});
const finalStatus = ref<JsonObject>(),
  statusError = ref("");
const pollPaused = ref(false);
const localResult = ref<StoredResult>();
const savingState = ref("idle");
const resultWatcher = new ResultWatcher({
  userId: actorId,
  saved: (result) => {
    localResult.value = result;
    emit("refresh");
  },
  state: (state) => {
    savingState.value = state;
  },
  error: (cause) => {
    statusError.value = message(cause);
  },
});
const requests = computed(() => testRequests(props.session.requests));
const results = computed(() =>
  testResults(
    localResult.value
      ? [
          localResult.value,
          ...props.session.results.filter(
            (item) => item.id !== localResult.value?.id,
          ),
        ]
      : props.session.results,
    props.session.requests,
    actorId,
  ),
);
const saved = computed(() =>
  localResult.value?.payload.clientRequestId === activeId.value
    ? localResult.value
    : results.value.find(
        (item) => item.payload.clientRequestId === activeId.value,
      ),
);
const statusText = computed(() => {
  if (saved.value)
    return saved.value.files.length
      ? "结果图片已保存"
      : "已保存终态，本次未生成可保存图片";
  if (finalStatus.value?.terminal === true)
    return savingState.value === "paused"
      ? "平台已结束生成，结果仍在后台保存；自动检查已暂停，可手动刷新"
      : "平台已结束生成，正在等待本地保存结果";
  if (submissionNo.value) return "已受理，正在生成；结果保存后显示";
  if (busy.value && originalRequest.value) return "正在提交生成请求，请稍候";
  const requestStatus = requests.value.find(
    (item) => item.id === activeId.value,
  )?.status;
  if (requestStatus === "NOT_SENT") return "请求未发送，请修正参数后开始新测试";
  if (requestStatus === "REJECTED") return "平台已拒绝本次请求，请检查错误原因";
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
        (model.value &&
          !parametersError.value &&
          asset.value &&
          prompt.value.trim()),
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
    if (lifetime.signal.aborted) return;
    models.value = Array.isArray(list)
      ? list
          .map(asObject)
          .filter((item) => typeof item.id === "string" && item.id.length > 0)
      : [];
    if (!models.value.length)
      throw new Error("暂无可用主图模型，请检查功能授权");
    if (!originalRequest.value) selectAvailableModel();
  } catch (cause) {
    if (!lifetime.signal.aborted) error.value = message(cause);
  } finally {
    loadingModel.value = false;
  }
}
function selectAvailableModel() {
  if (model.value) return;
  selectedModelId.value = String(
    (models.value.find((item) => item.isDefault === true) || models.value[0])
      ?.id || "",
  );
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
        selection.value,
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
    if (result.terminal === true && !saved.value)
      resultWatcher.start(submissionNo.value);
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
  if (savingState.value === "paused") resultWatcher.stop();
  return statusPoller.refresh(submissionNo.value);
}
function visibilityChanged() {
  statusPoller.visibilityChanged();
  resultWatcher.visibilityChanged();
}
function restore(item: RequestRecord) {
  stopPolling();
  originalRequest.value = item.body;
  selectedModelId.value = String(item.body.modelId || "");
  selection.value = {
    ...(item.body.resolution ? { resolution: item.body.resolution } : {}),
    ...(item.body.ratio ? { ratio: item.body.ratio } : {}),
    outputCount: item.body.outputCount,
  };
  parametersError.value = "";
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
  selectAvailableModel();
  activeId.value = "";
  submissionNo.value = "";
  finalStatus.value = undefined;
  submitted.value = false;
  error.value = "";
  statusError.value = "";
  pollPaused.value = false;
}
function stopPolling() {
  resultWatcher.stop();
  localResult.value = undefined;
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
  resultWatcher.dispose();
  document.removeEventListener("visibilitychange", visibilityChanged);
  if (preview.value) URL.revokeObjectURL(preview.value);
});
</script>

<template>
  <div class="management-page api-test-page">
    <div class="page-heading"><div><h1>API 测试</h1><p>上传商品图片，选择模型和生成参数，通过 API 测试主图生成。</p></div><span class="pill">{{ session.user.name }}</span></div>
    <p class="hint">由商户后端直接调用生成接口，实际消耗由黑犀商户账户结算。</p>
    <p v-if="!ready" class="error">请先在接入设置中完成 API 配置。</p>
    <div class="api-test-layout">
      <form class="surface api-test-form" @submit.prevent="submit">
        <h2>生成主图</h2>
        <label class="field-label" for="api-test-model">生图模型</label>
        <select id="api-test-model" v-model="selectedModelId" :disabled="!ready || busy || loadingModel || Boolean(originalRequest) || !models.length" required>
          <option v-if="!selectedModelId" value="" disabled>{{ loadingModel ? '正在加载模型…' : '暂无可用模型' }}</option>
          <option v-if="selectedModelId && !model" :value="selectedModelId" disabled>{{ selectedModelId }}（原请求模型，当前列表不可用）</option>
          <option v-for="item in models" :key="String(item.id)" :value="String(item.id)">{{ item.modelName || item.id }}{{ item.isDefault === true ? '（默认）' : '' }}</option>
        </select>
        <p class="hint">{{ originalRequest ? '当前请求的模型和参数已固定；修改参数请点击“新建测试”。' : '分辨率、比例和张数按所选模型提供的能力联动。' }}</p>
        <div class="api-test-options">
          <div><label class="field-label" for="api-test-resolution">分辨率</label><select id="api-test-resolution" v-model="selection.resolution" :disabled="parametersLocked || !choices.resolutions.length" @change="normalizeSelection"><option v-if="!choices.resolutions.length && !selection.resolution" :value="undefined">模型默认</option><option v-if="originalRequest && selection.resolution && !choices.resolutions.includes(String(selection.resolution))" :value="selection.resolution">{{ selection.resolution }}（原请求）</option><option v-for="value in choices.resolutions" :key="value" :value="value">{{ value }}</option></select></div>
          <div><label class="field-label" for="api-test-ratio">图片比例</label><select id="api-test-ratio" v-model="selection.ratio" :disabled="parametersLocked || !choices.ratios.length"><option v-if="originalRequest && selection.ratio && !choices.ratios.includes(String(selection.ratio))" :value="selection.ratio">{{ selection.ratio }}（原请求）</option><option v-for="value in choices.ratios" :key="value" :value="value">{{ value }}</option></select></div>
          <div><label class="field-label" for="api-test-count">生成张数</label><select id="api-test-count" v-model="selection.outputCount" :disabled="parametersLocked"><option v-if="originalRequest && !choices.counts.includes(Number(selection.outputCount))" :value="selection.outputCount">{{ selection.outputCount }} 张（原请求）</option><option v-for="count in choices.counts" :key="count" :value="count">{{ count }} 张</option></select></div>
        </div>
        <p v-if="parametersError" class="error" role="alert">{{ parametersError }}</p>
        <div class="api-test-estimate" role="status" aria-live="polite">
          <strong>{{ originalRequest ? '当前目录预估' : '预计消耗' }}：{{ loadingModel ? '正在加载…' : estimate?.credits !== undefined ? `${estimate.credits} 算力` : '暂无法估算' }}</strong>
          <p v-if="estimate" class="hint">{{ estimate.parameters }}</p>
          <p class="hint">{{ !loadingModel && estimate?.credits === undefined ? '当前模型目录未提供可匹配的价格。' : '按当前模型目录单价 × 生成张数估算。' }}实际扣费以平台返回的商户消费为准。</p>
        </div>
        <label class="field-label" for="api-test-image">商品图片（单张）</label>
        <input id="api-test-image" type="file" accept="image/png,image/jpeg,image/webp" :disabled="busy || Boolean(originalRequest) || !ready" @change="upload" />
        <img v-if="preview" class="api-test-source" :src="preview" alt="已上传的商品图片" />
        <p v-if="asset" class="hint" role="status">已上传：{{ asset.name }}</p>
        <label class="field-label" for="api-test-prompt">对话 / 生成需求</label>
        <textarea id="api-test-prompt" v-model="prompt" placeholder="例如：保留商品外观，生成白色背景的电商主图，光影自然，不添加文字。" maxlength="2000" :disabled="busy || Boolean(originalRequest)" required></textarea>
        <div class="actions"><button class="primary" :disabled="!canSubmit">{{ busy ? '正在处理…' : submitted ? '已提交' : originalRequest ? '使用原请求重试' : '提交生成' }}</button><button v-if="originalRequest" type="button" :disabled="busy" @click="newTest">新建测试</button><button v-else-if="!model && ready" type="button" :disabled="loadingModel" @click="loadModel">重新加载模型</button></div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
      </form>
      <section class="surface api-test-results" aria-label="API 测试结果">
        <div class="page-heading"><h2>生成结果</h2><button type="button" @click="readStatus">刷新状态</button></div>
        <p role="status">{{ statusText }}</p>
        <p v-if="submissionNo" class="hint">受理号：{{ submissionNo }}</p>
        <p class="hint">服务器轮询事件或收到可选回调后保存图片，刷新页面后仍会保留。</p>
        <p v-if="finalStatus?.credits" class="hint">商户实际消费：{{ asObject(finalStatus.credits).charged }} · 退款：{{ asObject(finalStatus.credits).refunded }} · 净消费：{{ asObject(finalStatus.credits).net }}（不是用户售价）</p>
        <p v-if="session.eventSyncError" class="error">{{ session.eventSyncError }}</p>
        <EventFailures :failures="session.eventFailures" :user-id="session.user.id" :issue="session.eventSyncError" @refresh="emit('refresh')" />
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
    <section v-if="requests.length" class="surface api-test-history"><h2>测试请求</h2><table><thead><tr><th>时间</th><th>请求号</th><th>提交状态</th><th></th></tr></thead><tbody><tr v-for="request in requests" :key="request.id"><td>{{ new Date(request.createdAt).toLocaleString() }}</td><td class="mono">{{ request.id }}</td><td>{{ requestStatusLabel(request.status) }}</td><td><button :disabled="busy" @click="restore(request)">查看 / 恢复请求</button></td></tr></tbody></table></section>
  </div>
</template>
