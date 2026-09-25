import type { JsonObject } from "../shared/types.ts";
import { AppError, object } from "./errors.ts";
import { type MerchantAuth, merchantHeaders } from "./merchant-auth.ts";

export class MerchantClient {
  apiOrigin: string;
  key: string;
  transport: typeof fetch;
  auth: MerchantAuth;
  constructor(
    origin: string,
    key: string,
    transport: typeof fetch = fetch,
    auth: MerchantAuth = {},
  ) {
    this.apiOrigin = origin;
    this.key = key;
    this.transport = transport;
    this.auth = auth;
  }
  async request(
    path: string,
    userId: string,
    options: {
      body?: JsonObject;
      query?: JsonObject;
      file?: File;
      timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    if (!path.startsWith("/open/") || /[?#\\]/.test(path))
      throw new AppError(400, "接口路径不允许");
    const url = new URL(`/api/v1${path}`, this.apiOrigin);
    const headers: Record<string, string> = {
      ...merchantHeaders(this.key, this.auth),
      Accept: "application/json",
    };
    let body: string | FormData | undefined;
    if (options.file) {
      url.searchParams.set("externalUserId", userId);
      body = new FormData();
      body.set("file", options.file);
    } else if (options.body) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ ...options.body, externalUserId: userId });
    } else {
      for (const [key, value] of Object.entries(options.query || {})) {
        if (
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean"
        )
          throw new AppError(400, "查询参数只能是字符串、数字或布尔值");
        url.searchParams.set(key, String(value));
      }
      url.searchParams.set("externalUserId", userId);
    }
    let response: Response;
    try {
      response = await this.transport(url, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
    } catch {
      throw new AppError(
        502,
        "黑犀 API 无响应；生成结果可能未确定，请先用原请求号查状态，再恢复原请求",
      );
    }
    let envelope: JsonObject;
    try {
      envelope = object(await response.json());
    } catch {
      throw new AppError(502, "黑犀 API 返回了非预期响应");
    }
    if (!response.ok || envelope.code !== 0) {
      const details = Object.fromEntries(
        ["code", "messageKey", "message", "traceId"]
          .filter((k) => ["string", "number"].includes(typeof envelope[k]))
          .map((k) => [
            k,
            typeof envelope[k] === "string"
              ? String(envelope[k]).replaceAll(this.key, "[REDACTED]")
              : envelope[k],
          ]),
      );
      throw new AppError(
        response.ok
          ? envelope.code === 40100
            ? 401
            : envelope.code === 40300
              ? 403
              : 400
          : response.status,
        response.status === 401 || (response.ok && envelope.code === 40100)
          ? this.auth.version === "0.4.0"
            ? "商户凭据失效或 AK/SK 不匹配，请检查接入配置与商户状态"
            : "旧版 API 拒绝请求（401），请结合安全详情检查商户凭证、externalUserId、功能授权或 SDK 来源"
          : response.status === 403 || (response.ok && envelope.code === 40300)
            ? "功能或 SDK 来源未授权，请检查商户功能权限与登记的 HTTPS 来源；无需重新登录"
            : response.status === 400 || response.ok
              ? "请求未被接受，请核对参数或业务条件，并查看安全错误详情与 traceId"
              : "黑犀 API 调用失败",
        details,
      );
    }
    return envelope.data;
  }
}
