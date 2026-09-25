import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { checkConnection, sdkSignature } from "./connection.ts";
import { AppError, BusinessError, object, string, uuid } from "./errors.ts";
import type { MerchantClient } from "./merchant.ts";
import type { Operations } from "./operations.ts";
import type { ResultService } from "./results.ts";
import type { Store } from "./store.ts";
import { WebhookKeys } from "./webhook-keys.ts";

export async function rawBody(req: IncomingMessage, limit = 2 * 1024 * 1024) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new AppError(413, "请求体过大");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export function json(res: ServerResponse, value: unknown, status = 200) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
export function errorResponse(res: ServerResponse, error: unknown) {
  json(
    res,
    {
      error:
        error instanceof AppError
          ? error.message
          : "本地处理失败，请检查启动状态或稍后重试",
      ...(error instanceof BusinessError
        ? { businessCode: error.businessCode }
        : {}),
      ...(error instanceof AppError && error.details
        ? { details: error.details }
        : {}),
    },
    error instanceof AppError ? error.status : 500,
  );
}
export function createHandler(
  config: Config,
  store: Store,
  api: MerchantClient,
  operations: Operations,
  results: ResultService,
) {
  const hostOrigin = config.public.hostOrigin;
  // 页面代理启用时，SDK 宿主页是代理 HTTPS origin；本机回源地址仍可用于管理页面和 API 调试。
  const pageOrigins = [
    ...new Set([hostOrigin, config.listenOrigin || hostOrigin]),
  ];
  const sessionCookieName = "demo_session";
  const webhookKeys = new WebhookKeys(
    config.apiOrigin,
    config.apiKey,
    api.transport,
    api.auth,
  );
  return async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> => {
    const url = new URL(req.url || "/", hostOrigin),
      path = url.pathname;
    const webhook =
      path === "/webhooks/credits" || path === "/webhooks/generation";
    if (
      !path.startsWith("/api/") &&
      !path.startsWith("/files/") &&
      !path.startsWith("/webhooks/")
    )
      return false;
    try {
      if (webhook && req.method === "POST") {
        const topic = path.endsWith("credits") ? "credits" : "generation";
        const event = await webhookKeys.verify(
          await rawBody(req),
          req.headers,
          topic,
        );
        if (
          topic === "credits" &&
          ["credits.sale_debited", "credits.sale_refunded"].includes(
            event.eventType,
          )
        ) {
          store.sales.receive(event);
        } else if (topic === "credits") {
          if (
            ![
              "credits.debited",
              "credits.refunded",
              "credits.license_debited",
            ].includes(event.eventType)
          )
            throw new AppError(400, "算力回调事件类型错误");
          store.creditEvent(event);
        } else await results.generation(event);
        json(res, { received: true });
        return true;
      }
      // 按请求 Host 确定当前页面 origin；Host 已在入口限制为上述地址。
      const pageOrigin =
        pageOrigins.find((item) => new URL(item).host === req.headers.host) ||
        hostOrigin;
      if (req.method !== "GET" && req.headers.origin !== pageOrigin)
        throw new AppError(403, "请求来源不匹配");
      if (path === "/api/config" && req.method === "GET") {
        json(res, config.public);
        return true;
      }
      const token = req.headers.cookie
        ?.split(";")
        .map((item) => item.trim())
        .find((item) => item.startsWith(`${sessionCookieName}=`))
        ?.slice(sessionCookieName.length + 1);
      let user = store.session(token);
      const setSession = (userId: string) =>
        res.setHeader(
          "Set-Cookie",
          `${sessionCookieName}=${store.newSession(userId, token)}; Path=/; HttpOnly;${pageOrigin.startsWith("https:") ? " Secure;" : ""} SameSite=Strict; Max-Age=86400`,
        );
      if (path === "/api/session" && req.method === "GET") {
        if (!user) {
          user = store.users()[0];
          setSession(user.id);
        }
        json(res, {
          user,
          users: store.users(),
          ledger: store.ledger(user.id),
          results: store.results(user.id),
          requests: store.requests(user.id),
          generationFailure: results.generationFailures.get(user.id),
          eventSyncError: results.syncIssue(user.id),
          platformCosts: store.platformCosts(user.id),
          pendingSales: store.sales.pending(user.id),
        });
        return true;
      }
      if (!user) throw new AppError(401, "请刷新页面重新选择本地用户");
      const expectedUser = req.headers["x-demo-user"];
      if (expectedUser !== undefined && expectedUser !== user.id)
        throw new AppError(409, "用户已切换，请重新操作");
      if (req.method === "GET") {
        if (path === "/api/sdk/state")
          json(res, { resultCursor: store.cursor(user.id) || null });
        else if (path.startsWith("/files/")) {
          const id = path.slice(7);
          if (!/^[a-f0-9]{64}$/.test(id)) throw new AppError(404, "文件不存在");
          const file = store.file(user.id, id);
          res.writeHead(200, {
            "Content-Type": file.contentType,
            "Content-Length": file.bytes,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          });
          const stream = createReadStream(join(config.dataDir, "media", id));
          stream.on("error", () => res.destroy());
          stream.pipe(res);
        } else throw new AppError(404, "接口不存在");
        return true;
      }
      if (req.method !== "POST") throw new AppError(405, "请求方法不支持");
      if (path === "/api/materials/image") {
        const bytes = await rawBody(req, 20 * 1024 * 1024);
        const contentType = req.headers["content-type"] || "";
        if (!contentType.startsWith("multipart/form-data;"))
          throw new AppError(400, "需要 multipart 图片上传");
        const form = await new Request(hostOrigin, {
          method: "POST",
          headers: { "Content-Type": contentType },
          body: new Uint8Array(bytes),
        }).formData();
        const file = form.get("file");
        if (
          !(file instanceof File) ||
          [...form.keys()].length !== 1 ||
          !file.type.startsWith("image/")
        )
          throw new AppError(400, "请选择单个图片文件");
        json(
          res,
          await api.request("/open/materials/images", user.externalUserId, {
            file,
          }),
        );
        return true;
      }
      let body: Record<string, unknown>;
      try {
        body = object(JSON.parse((await rawBody(req)).toString("utf8")));
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(400, "JSON 格式错误");
      }
      if (path === "/api/events/sync" || path === "/api/events/retry") {
        if (path === "/api/events/retry") results.inbox.retry(user.id);
        json(res, await results.syncEvents(user));
      } else if (path === "/api/connection/check") {
        json(
          res,
          await checkConnection(
            api,
            user.externalUserId,
            undefined,
            hostOrigin,
          ),
        );
      } else if (path === "/api/session") {
        // 示例用户切换保留会话 Cookie；另一标签页的旧轮询不会因旧 Token
        // 失效而创建默认 A 会话，覆盖用户刚完成的选择。业务请求仍核对 X-Demo-User。
        const selected = store.selectSessionUser(token, string(body.userId));
        json(res, selected);
      } else if (path === "/api/users")
        json(res, store.addUser(string(body.name, 80)));
      else if (path === "/api/credits") {
        if (typeof body.amount !== "number")
          throw new AppError(400, "充值数量必须是数字");
        json(res, store.addCredit(user.id, body.amount, uuid(body.requestId)));
      } else if (path === "/api/sdk/signature") {
        if (body.parentOrigin !== hostOrigin)
          throw new AppError(403, "SDK 来源不匹配");
        const signature = await sdkSignature(
          api,
          user.externalUserId,
          hostOrigin,
        );
        results.syncState.watch(user.id);
        results.onActivity?.(user.id);
        json(res, { signature });
      } else if (path === "/api/sdk/approve") {
        results.onActivity?.(user.id);
        json(res, await operations.approve(user, body));
      } else if (path === "/api/sdk/result") {
        await results.sdk(user, uuid(body.eventId));
        json(res, { received: true });
      } else if (path === "/api/call") {
        if (["design", "apparel", "video"].includes(String(body.operation)))
          results.onActivity?.(user.id);
        json(
          res,
          await operations.call(
            user,
            string(body.operation),
            object(body.params),
          ),
        );
      } else throw new AppError(404, "接口不存在");
    } catch (error) {
      errorResponse(res, error);
    }
    return true;
  };
}
