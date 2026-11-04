import type { JsonObject, MerchantAccount } from "../shared/types.ts";
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
  // 此接口属于 AK/SK 对应商户，不传用户身份、请求体或任何查询参数。
  async account(): Promise<MerchantAccount> {
    const value = await this.send(
      new URL("/api/v1/open/account", this.apiOrigin),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new AppError(502, "黑犀商户账户返回了非预期响应");
    const data = value as JsonObject;
    if (
      !Number.isSafeInteger(data.credit) ||
      Number(data.credit) < 0 ||
      typeof data.membershipActive !== "boolean" ||
      ![
        null,
        "TRIAL",
        "STANDARD",
        "PROFESSIONAL",
        "ADVANCED",
        "FLAGSHIP",
      ].includes(data.membershipLevel as MerchantAccount["membershipLevel"]) ||
      !(
        data.membershipName === null || typeof data.membershipName === "string"
      ) ||
      !(
        data.membershipExpireTime === null ||
        (typeof data.membershipExpireTime === "string" &&
          Number.isFinite(Date.parse(data.membershipExpireTime)))
      )
    )
      throw new AppError(502, "黑犀商户账户返回了非预期响应");
    return {
      credit: data.credit as number,
      membershipActive: data.membershipActive,
      membershipLevel:
        data.membershipLevel as MerchantAccount["membershipLevel"],
      membershipName: data.membershipName,
      membershipExpireTime: data.membershipExpireTime,
    };
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
    if (path === "/open/account")
      throw new AppError(400, "商户账户须使用无用户参数的 account() 查询");
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
    return this.send(url, { headers, body, timeoutMs: options.timeoutMs });
  }
  private async send(
    url: URL,
    options: {
      headers?: Record<string, string>;
      body?: string | FormData;
      timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    const { body } = options;
    const headers = options.headers ?? {
      ...merchantHeaders(this.key, this.auth),
      Accept: "application/json",
    };
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
        url.pathname === "/api/v1/open/account"
          ? "商户账户查询无响应，请稍后重新查询"
          : "黑犀 API 无响应；生成结果可能未确定，请先用原请求号查状态，再恢复原请求",
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
              : response.status === 404 && envelope.code === 47001
                ? "AI 模型暂不可用，请重新查询已启用模型；旧报价不能绕过模型停用限制"
                : "黑犀 API 调用失败",
        details,
        // A timeout/rate-limit or contradictory/malformed envelope is not proof
        // that the platform did not accept the operation.
        [400, 401, 403, 404, 409, 422].includes(response.status) &&
          Number.isSafeInteger(envelope.code) &&
          Number(envelope.code) > 0
          ? "UPSTREAM_REJECTED"
          : undefined,
      );
    }
    return envelope.data;
  }
}
