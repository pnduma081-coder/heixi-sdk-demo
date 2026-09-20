<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { examples } from "../shared/examples.ts";
import type { JsonObject, RequestRecord, User } from "../shared/types.ts";
import { api, message, pretty } from "./api.ts";

const props = defineProps<{
  user: User;
  ready: boolean;
  requests: RequestRecord[];
}>();
const emit = defineEmits<{ refresh: [] }>();
const operation = ref<string>("models"),
  editor = ref(""),
  response = ref(""),
  error = ref(""),
  busy = ref(false);
const models = ref<JsonObject[]>([]),
  selectedModel = ref(""),
  uploads = ref<Array<{ assetId: string; url: string; name: string }>>([]),
  assetOne = ref(""),
  assetTwo = ref("");
const submissionNo = ref(""),
  polling = ref(false),
  lifetime = new AbortController();
let timer: ReturnType<typeof setTimeout> | undefined;
const asObject = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const first = (value: unknown) => (Array.isArray(value) ? value[0] : undefined);
const call = (id: string, params: JsonObject) =>
  api<unknown>("/api/call", {
    body: { operation: id, params },
    userId: props.user.id,
    signal: lifetime.signal,
  });
function reset() {
  const example = examples.find((item) => item.id === operation.value);
  if (!example) return;
  const params = JSON.parse(JSON.stringify(example.params));
  if (example.method === "POST") params.clientRequestId = crypto.randomUUID();
  if ("submissionNo" in params) params.submissionNo = submissionNo.value;
  editor.value = pretty(params);
}
watch(operation, reset, { immediate: true });
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
async function execute() {
  await run(async () => {
    const id = operation.value,
      params = JSON.parse(editor.value);
    const result = await call(id, params);
    response.value = pretty(result);
    if ((id === "models" || id === "videoModels") && Array.isArray(result)) {
      models.value = result;
      selectedModel.value = String(asObject(result[0]).id || "");
    }
    const submission = asObject(asObject(result).submission);
    if (typeof submission.submissionNo === "string") {
      submissionNo.value = submission.submissionNo;
      startPolling();
    }
    emit("refresh");
  });
}
function freshId() {
  void run(async () => {
    const params = JSON.parse(editor.value);
    params.clientRequestId = crypto.randomUUID();
    editor.value = pretty(params);
  });
}
async function fill() {
  await run(async () => {
    const params = JSON.parse(editor.value);
    if (operation.value === "design" || operation.value === "video") {
      const video = operation.value === "video";
      const query = examples.find(
        (item) => item.id === (video ? "videoModels" : "models"),
      );
      const result = await call(video ? "videoModels" : "models", {
        ...query?.params,
      });
      if (!Array.isArray(result) || !result.length)
        throw new Error("此功能没有可用模型，请检查平台授权");
      models.value = result;
      const model =
        result.find((item) => asObject(item).id === selectedModel.value) ||
        result[0];
      selectedModel.value = String(model.id);
      params.modelId = model.id;
      params.parameterSchemaVersion = model.parameterSchemaVersion;
      const capabilities = asObject(model.capabilities),
        options = asObject(video ? capabilities.video : capabilities.image);
      params.ratio =
        first(video ? options.ratios : options.outputRatios) || params.ratio;
      const resolution = first(
        video ? options.resolutions : options.resolutionOptions,
      );
      if (resolution) params.resolution = resolution;
      if (video) params.duration = String(first(options.durations) || "");
      else {
        params.sourceAssetIds = assetOne.value ? [assetOne.value] : [];
        params.sourceRoles = assetOne.value ? ["PRODUCT_MAIN"] : [];
      }
    } else if (operation.value === "apparel") {
      const config = asObject(
        await call("apparelConfig", { workflowType: "BACKGROUND_REPLACE" }),
      );
      params.configurationVersion = config.configurationVersion;
      params.ratio = first(config.ratios);
      if (first(config.resolutions))
        params.resolution = first(config.resolutions);
      params.materials = [
        { role: "BASE_PERSON", assetId: assetOne.value },
        { role: "BACKGROUND", assetId: assetTwo.value },
      ];
    } else throw new Error("请选择首图、背景替换或文生视频示例");
    editor.value = pretty(params);
  });
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  await run(async () => {
    const form = new FormData();
    form.set("file", file);
    const result = await api<{ assetId: string; url: string }>(
      "/api/materials/image",
      { form, userId: props.user.id, signal: lifetime.signal },
    );
    uploads.value.push({ ...result, name: file.name });
    if (!assetOne.value) assetOne.value = result.assetId;
    else assetTwo.value = result.assetId;
    response.value = pretty(result);
  });
  input.value = "";
}
async function readStatus() {
  if (!submissionNo.value) throw new Error("请填写 GS 受理号");
  const result = asObject(
    await call("generation", { submissionNo: submissionNo.value }),
  );
  response.value = pretty(result);
  emit("refresh");
  if (result.terminal === true) stopPolling();
}
function stopPolling() {
  polling.value = false;
  clearTimeout(timer);
}
function startPolling() {
  stopPolling();
  polling.value = true;
  const tick = async () => {
    try {
      await readStatus();
    } catch (cause) {
      if (!lifetime.signal.aborted) error.value = message(cause);
      stopPolling();
    }
    if (polling.value && !lifetime.signal.aborted)
      timer = setTimeout(tick, 3000);
  };
  timer = setTimeout(tick, 1000);
}
function restore(item: RequestRecord) {
  stopPolling();
  operation.value = item.operation;
  queueMicrotask(() => {
    editor.value = pretty(item.body);
    response.value = pretty(item.response);
  });
}
onBeforeUnmount(() => {
  lifetime.abort();
  stopPolling();
});
</script>

<template>
  <section>
    <div class="toolbar">
      <select v-model="operation" :disabled="busy" aria-label="API 示例"><option v-for="item in examples" :key="item.id" :value="item.id">{{ item.label }} · {{ item.method }}</option></select>
      <button :disabled="busy || !ready" @click="execute">调用 API</button><button :disabled="busy" @click="reset">重置模板</button><button :disabled="busy" @click="freshId">新请求号</button>
    </div>
    <p class="hint">{{ examples.find(item => item.id === operation)?.path }} · 身份由后端注入。超时重试保留原请求号。</p>
    <div class="toolbar">
      <label>上传图片 <input type="file" accept="image/*" :disabled="busy || !ready" @change="upload" /></label>
      <select v-model="assetOne" aria-label="素材一"><option value="">素材一 / 人物或商品</option><option v-for="item in uploads" :key="item.assetId" :value="item.assetId">{{ item.name }}</option></select>
      <select v-model="assetTwo" aria-label="素材二"><option value="">素材二 / 背景</option><option v-for="item in uploads" :key="item.assetId" :value="item.assetId">{{ item.name }}</option></select>
      <select v-if="models.length" v-model="selectedModel" aria-label="模型"><option v-for="model in models" :key="String(model.id)" :value="String(model.id)">{{ model.modelName }}</option></select>
      <button :disabled="busy || !ready" @click="fill">查询并填入模型 / 素材参数</button>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <div class="two-columns"><label>请求 JSON<textarea v-model="editor" spellcheck="false" /></label><div>API 响应<pre class="response">{{ response || '等待调用' }}</pre></div></div>
    <div class="toolbar"><input v-model="submissionNo" placeholder="GS 受理号" aria-label="受理号" /><button :disabled="busy || !ready" @click="run(readStatus)">刷新最终状态</button><button :disabled="!ready" @click="polling ? stopPolling() : startPolling()">{{ polling ? '停止轮询' : '每 3 秒查询' }}</button></div>
    <p class="hint">ACCEPTED / HANDED_OFF 表示受理或任务已创建；terminal=true 才是整次生成终态。结果文件在回调保存后出现在“我的作品”。</p>
    <h3>已保存的生成请求</h3>
    <table><thead><tr><th>请求号</th><th>操作</th><th>提交状态</th><th></th></tr></thead><tbody><tr v-for="item in requests.filter(item => item.operation !== 'sdkApproval')" :key="item.id"><td>{{ item.id }}</td><td>{{ item.operation }}</td><td>{{ item.status }}</td><td><button :disabled="busy" @click="restore(item)">恢复原请求</button></td></tr></tbody></table>
  </section>
</template>
