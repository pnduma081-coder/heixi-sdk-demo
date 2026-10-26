import { localSdkPath, onlineSdkUrl } from "../shared/sdk-release.ts";
import { api } from "./api.ts";
import { localGenerationDecision } from "./f065-local-decision.ts";
import { approveGeneration } from "./sdk-approval.ts";

// SDK 0.4.0 最新合同：宿主签名与批准；生成结果由内嵌页面展示。

export type GenerationDecision =
  | { approvalId: string }
  | { approved: false; message: string };
export type SdkInstance = {
  ready: Promise<unknown>;
  update: (patch: Record<string, unknown>) => Promise<void>;
  navigate: (target: { page: string; resourceId?: string }) => Promise<void>;
  getState: () => unknown;
  refreshSession: () => Promise<void>;
  destroy: () => void;
};
export type SdkOptions = {
  getSignature: (input: {
    parentOrigin: string;
    signal: AbortSignal;
  }) => Promise<string>;
  onBeforeGenerate: (
    request: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<GenerationDecision>;
  onRecharge: () => void;
  onError: (error: { code: string }) => void;
  timeoutMs: number;
};
export type OpenSdk = (input: {
  container: HTMLElement;
  page: string;
  credits: number;
  context: Record<string, unknown>;
  profile: { displayName: string };
  resourceId?: string;
  showHeader: boolean;
  signal: AbortSignal;
}) => Promise<SdkInstance>;
declare global {
  interface Window {
    BlackRhinoSDK?: { init: (options: SdkOptions) => OpenSdk };
  }
}
let loading: Promise<void> | undefined;
let selectedSource: string | undefined;
function loadError(message: string) {
  return Object.assign(new Error(message), { code: "SDK_LOAD_FAILED" });
}
// 【SDK 对接点 1】本地模式仅取本机已校验制品，任何失败均不回退 CDN。
export function loadSdk(source = onlineSdkUrl, mode?: "f065-local") {
  const local = mode === "f065-local";
  if (
    local &&
    !["localhost", "127.0.0.1"].includes(window.location.hostname) &&
    window.location.origin !== "https://rhino-demo.laotangcode.shop"
  )
    return Promise.reject(
      loadError("本地模式仅支持 loopback 或已批准的精确tunnel宿主"),
    );
  if (source !== (local ? localSdkPath : onlineSdkUrl))
    return Promise.reject(loadError("SDK 地址未登记，请检查接入配置"));
  if (selectedSource && selectedSource !== source)
    return Promise.reject(loadError("SDK 环境已切换，请完整刷新页面"));
  if (window.BlackRhinoSDK && selectedSource === source)
    return Promise.resolve();
  if (window.BlackRhinoSDK && !selectedSource)
    return Promise.reject(loadError("页面已存在未知来源 SDK，请完整刷新页面"));
  if (!loading)
    loading = new Promise<void>((resolve, reject) => {
      selectedSource = source;
      const script = document.createElement("script");
      const fail = (message: string) => {
        clearTimeout(timer);
        script.onload = null;
        script.onerror = null;
        script.remove();
        loading = undefined;
        reject(loadError(message));
      };
      const timer = setTimeout(
        () => fail(`SDK 文件加载超时：${source}；请检查网络后重试`),
        15000,
      );
      script.src = source;
      script.referrerPolicy = "no-referrer";
      script.onload = () => {
        clearTimeout(timer);
        if (typeof window.BlackRhinoSDK?.init === "function") resolve();
        else fail(`SDK 文件格式不正确：${source}`);
      };
      script.onerror = () =>
        fail(`SDK 文件加载失败：${source}；不会切换到其他版本或本地产物`);
      document.head.append(script);
    });
  return loading;
}

// 传给 BlackRhinoSDK.init 的宿主回调。签名、批准经商户后端处理，
// 浏览器不持有 API Key；actorId 固定为打开页面时的用户，换号会重建实例。
export function localSdkTrace(stage: string) {
  console.info(
    "[f065-host-timeline]",
    JSON.stringify({
      stage,
      at: new Date().toISOString(),
      elapsedMs: Math.round(performance.now()),
    }),
  );
}

export function createSdkOptions(
  actorId: string,
  handlers: {
    onRefresh: () => void;
    onRecharge: () => void;
    onError: (error: { code: string }) => void;
    localReadOnly?: boolean;
  },
): SdkOptions {
  return {
    // 【SDK 对接点 2】启动签名：后端用 API Key 为当前用户和 parentOrigin 申请。
    getSignature: async ({ parentOrigin, signal }) => {
      if (handlers.localReadOnly) localSdkTrace("signature-start");
      const { signature } = await api<{ signature: string }>(
        "/api/sdk/signature",
        { body: { parentOrigin }, userId: actorId, signal },
      );
      if (handlers.localReadOnly) localSdkTrace("signature-complete");
      return signature;
    },
    // 【SDK 对接点 3】生成前批准：后端核对报价与身份；新请求不以本地余额作为批准门槛。
    onBeforeGenerate: async (request, signal) => {
      if (handlers.localReadOnly)
        return localGenerationDecision(request, signal);
      const decision = await approveGeneration(actorId, request, signal);
      if (!signal.aborted) handlers.onRefresh();
      return decision;
    },
    onRecharge: handlers.onRecharge,
    onError: handlers.onError,
    timeoutMs: 30000,
  };
}
