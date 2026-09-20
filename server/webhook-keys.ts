import type { IncomingHttpHeaders } from "node:http";
import { AppError } from "./errors.ts";
import { verifyWebhook, webhookHeaders } from "./webhook.ts";

type Topic = "credits" | "generation";
export class WebhookKeys {
  private readonly keys = {
    credits: new Map<string, string>(),
    generation: new Map<string, string>(),
  };
  private readonly pending = new Map<string, Promise<string>>();
  private readonly origin: string;
  private readonly apiKey: string;
  private readonly transport: typeof fetch;
  constructor(origin: string, apiKey: string, transport: typeof fetch = fetch) {
    this.origin = origin;
    this.apiKey = apiKey;
    this.transport = transport;
  }

  // 【SDK 对接点 5】按 topic/keyId 用 API Key 自动领取验签密钥，商户无需手工配置 Secret。
  async verify(raw: Buffer, headers: IncomingHttpHeaders, topic: Topic) {
    // 先拒绝过期或畸形头；未知key只能向配置中的平台请求，不能采用回调自带URL。
    const { keyId } = webhookHeaders(raw, headers);
    const secret = await this.get(topic, keyId.toLowerCase());
    return verifyWebhook(raw, headers, new Map([[keyId, secret]]));
  }

  private async get(topic: Topic, keyId: string) {
    if (!this.apiKey) throw new AppError(503, "请配置平台API Key并重启示例");
    const cache = this.keys[topic];
    const cached = cache.get(keyId);
    if (cached) {
      cache.delete(keyId);
      cache.set(keyId, cached);
      return cached;
    }
    const requestId = `${topic}:${keyId}`;
    const pending = this.pending.get(requestId);
    if (pending) return pending;
    if (this.pending.size >= 8)
      throw new AppError(503, "回调验签配置正在获取，请稍后重试");
    const request = this.load(topic, keyId)
      .then((secret) => {
        const oldest = cache.keys().next().value;
        if (cache.size >= 32 && oldest !== undefined) cache.delete(oldest);
        cache.set(keyId, secret);
        return secret;
      })
      .finally(() => this.pending.delete(requestId));
    this.pending.set(requestId, request);
    return request;
  }

  private async load(topic: Topic, keyId: string): Promise<string> {
    try {
      const response = await this.transport(
        new URL(`/api/v1/open/webhooks/${topic}/signing-key`, this.origin),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ keyId }),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error("key request failed");
      const body = (await response.json()) as {
        code?: unknown;
        data?: { keyId?: unknown; secret?: unknown };
      };
      if (
        body?.code !== 0 ||
        body.data?.keyId !== keyId ||
        typeof body.data?.secret !== "string" ||
        !/^whsec_[A-Za-z0-9_-]{43}$/.test(body.data.secret)
      )
        throw new Error("invalid key response");
      return body.data.secret;
    } catch {
      // 凭证领取失败只返回通用状态，不把平台响应、API Key或secret传给浏览器与日志。
      throw new AppError(
        503,
        "无法自动获取回调验签配置，请检查平台API Key和回调配置后重试",
      );
    }
  }
}
