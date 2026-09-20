import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import {
  httpsHostOrigin as hostOrigin,
  sdkApiOrigin,
} from "../server/config.ts";
import { resultSaveError } from "../server/errors.ts";
import { createHandler } from "../server/http.ts";
import { MerchantClient } from "../server/merchant.ts";
import { Operations } from "../server/operations.ts";
import { ResultService } from "../server/results.ts";
import { Store } from "../server/store.ts";

test("isolated HTTP: session, CSRF, user switch, API owner and malformed upload boundaries", async () => {
  const store = new Store(":memory:");
  const api = new MerchantClient(
    "https://fixture.example",
    "test-key",
    async () => {
      throw new Error("HTTP boundary test must not call an upstream");
    },
  );
  const results = new ResultService(store, api, {
    async save() {
      throw new Error("No downloads allowed");
    },
  });
  const handler = createHandler(
    {
      apiOrigin: "https://fixture.example",
      apiKey: "test-key",
      dataDir: "/not-used",
      public: {
        apiReady: true,
        callbacksReady: false,
        sdkReady: true,
        missing: [],
        hostOrigin,
        sdkApiOrigin,
      },
    },
    store,
    api,
    new Operations(api, store),
    results,
  );
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${origin}/api/session`),
      state = await session.json();
    const cookie = session.headers.get("set-cookie")?.split(";")[0] || "";
    assert.equal(state.user.id, "demo-a");
    assert(cookie.startsWith("demo_session="));
    const post = (
      path: string,
      body: unknown,
      csrf = hostOrigin,
      user = "demo-a",
    ) =>
      fetch(origin + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${cookie}; black_rhino_login=irrelevant-browser-cookie`,
          authorization: "Bearer irrelevant-browser-login-token",
          origin: csrf,
          "x-demo-user": user,
        },
        body: JSON.stringify(body),
      });
    assert.equal(
      (
        await post(
          "/api/credits",
          { amount: 100, requestId: randomUUID() },
          "https://foreign.example",
        )
      ).status,
      403,
    );
    assert.equal(
      (await post("/api/credits", { amount: 100, requestId: randomUUID() }))
        .status,
      200,
    );
    assert.equal(store.user("demo-a").credits, 100);
    assert.equal(
      (await post("/api/sdk/apply", { deliveryId: randomUUID() })).status,
      404,
    );
    const diagnosticPaths: string[] = [];
    api.key = `sk-${"d".repeat(43)}`;
    api.transport = async (input, options) => {
      const url = new URL(String(input));
      diagnosticPaths.push(url.pathname);
      assert.equal(
        new Headers(options?.headers).get("Authorization"),
        `Bearer ${api.key}`,
      );
      assert.equal(new Headers(options?.headers).get("Cookie"), null);
      assert.equal(new Headers(options?.headers).get("Origin"), null);
      if (url.pathname === "/api/v1/open/history") {
        assert.equal(
          url.searchParams.get("externalUserId"),
          store.user("demo-a").externalUserId,
        );
        return Response.json({ code: 0, data: { items: ["private-history"] } });
      }
      assert.equal(url.pathname, "/api/v1/open/sdk/signature");
      assert.deepEqual(JSON.parse(String(options?.body)), {
        parentOrigin: hostOrigin,
        externalUserId: store.user("demo-a").externalUserId,
      });
      return Response.json(
        {
          code: 40100,
          message: "未登录或登录已过期",
          traceId: "isolated-diagnostic-trace",
        },
        { status: 401 },
      );
    };
    assert.equal(
      (await post("/api/connection/check", {}, "https://foreign.example"))
        .status,
      403,
    );
    assert.equal(diagnosticPaths.length, 0);
    const diagnosticResponse = await post("/api/connection/check", {
      externalUserId: "foreign",
    });
    assert.equal(diagnosticResponse.status, 200);
    const diagnostic = await diagnosticResponse.json();
    assert.deepEqual(
      diagnostic.checks.map((item: { status: string }) => item.status),
      ["passed", "failed"],
    );
    assert.equal(
      diagnostic.checks[1].details.traceId,
      "isolated-diagnostic-trace",
    );
    assert(!JSON.stringify(diagnostic).includes("private-history"));
    assert(!JSON.stringify(diagnostic).includes(api.key));
    const sdkResponse = await post("/api/sdk/signature", {
      parentOrigin: hostOrigin,
    });
    assert.equal(sdkResponse.status, 401);
    const sdkFailure = await sdkResponse.json();
    assert.match(sdkFailure.error, /SDK 启动授权未通过/);
    assert.equal(
      sdkFailure.details.signatureError.traceId,
      "isolated-diagnostic-trace",
    );
    assert.deepEqual(diagnosticPaths.slice(2), [
      "/api/v1/open/sdk/signature",
      "/api/v1/open/history",
    ]);
    assert.equal(
      (
        await post("/api/call", {
          operation: "models",
          params: { externalUserId: "foreign" },
        })
      ).status,
      400,
    );
    const switched = await post("/api/session", { userId: "demo-b" });
    assert.equal(switched.status, 200);
    // 模拟另一标签页已发出、切换后才到达的余额轮询，仍携带原会话 Cookie。
    const delayedPoll = await fetch(`${origin}/api/session`, {
      headers: { cookie },
    });
    assert.equal(
      delayedPoll.headers.get("set-cookie"),
      null,
      "旧轮询不能重新创建 A 的 Cookie，覆盖刚选择的 B",
    );
    assert.equal((await delayedPoll.json()).user.id, "demo-b");
    assert.equal((await post("/api/connection/check", {})).status, 409);
    assert.equal(diagnosticPaths.length, 4);
    assert.equal(
      (await post("/api/credits", { amount: 100, requestId: randomUUID() }))
        .status,
      409,
    );
    assert.equal(store.user("demo-b").credits, 0);
    const multipart = new FormData();
    multipart.set(
      "file",
      new File(["fixture"], "test.png", { type: "image/png" }),
    );
    multipart.set("externalUserId", "foreign");
    assert.equal(
      (
        await fetch(`${origin}/api/materials/image`, {
          method: "POST",
          headers: { cookie, origin: hostOrigin },
          body: multipart,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${origin}/webhooks/credits`, {
          method: "POST",
          body: "{}",
        })
      ).status,
      401,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test("signed generation callbacks persist their payload without querying results and only ACK durable saves", async () => {
  const store = new Store(":memory:");
  const keyId = randomUUID(),
    secret = `whsec_${"x".repeat(43)}`;
  let keyReads = 0,
    downloads = 0,
    failSave = true;
  const api = new MerchantClient(
    "https://fixture.invalid",
    "fixture-key",
    async (input) => {
      assert.equal(
        new URL(String(input)).pathname,
        "/api/v1/open/webhooks/generation/signing-key",
      );
      keyReads++;
      return Response.json({ code: 0, data: { keyId, secret } });
    },
  );
  const results = new ResultService(store, api, {
    async save(url) {
      downloads++;
      assert.equal(url, "https://fixture.invalid/platform-saved.png");
      if (failSave) throw resultSaveError(409, "结果文件不可用或类型不符");
      return {
        id: "fixture-file",
        name: "image",
        bytes: 1,
        contentType: "image/png",
      };
    },
  });
  const handler = createHandler(
    {
      apiOrigin: "https://fixture.invalid",
      apiKey: "fixture-key",
      dataDir: "/not-used",
      public: {
        apiReady: true,
        callbacksReady: true,
        sdkReady: true,
        missing: [],
        hostOrigin,
        sdkApiOrigin,
      },
    },
    store,
    api,
    new Operations(api, store),
    results,
  );
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const callback = {
    eventId: randomUUID(),
    eventVersion: "merchant-events/v1",
    eventType: "generation.finished",
    externalUserId: "demo-user-b",
    occurredAt: new Date().toISOString(),
    data: {
      requestChannel: "API",
      submissionNo: "GSfixture",
      clientRequestId: "fixture-request",
      status: "SUCCEEDED",
      context: { example: "api-test" },
      tasks: [
        {
          role: "OUTPUT",
          status: "SUCCEEDED",
          text: "回调中的文本",
          results: [
            {
              type: "IMAGE",
              available: true,
              url: "https://fixture.invalid/platform-saved.png",
            },
          ],
        },
      ],
    },
  };
  async function post(value: typeof callback, tamper = false) {
    const timestamp = String(Math.floor(Date.now() / 1000)),
      deliveryId = randomUUID(),
      raw = JSON.stringify(value);
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${keyId}.${deliveryId}.${value.eventId}.`)
      .update(raw)
      .digest("hex");
    return fetch(
      `http://127.0.0.1:${typeof address === "object" && address?.port}/webhooks/generation`,
      {
        method: "POST",
        headers: {
          "x-black-rhino-timestamp": timestamp,
          "x-black-rhino-key-id": keyId,
          "x-black-rhino-delivery-id": deliveryId,
          "x-black-rhino-event-id": value.eventId,
          "x-black-rhino-signature": `v1=${signature}`,
          "content-type": "application/json",
        },
        body: raw + (tamper ? " " : ""),
      },
    );
  }
  try {
    assert.equal((await post(callback, true)).status, 401);
    assert.equal(downloads, 0);
    assert.equal(
      (
        await post({
          ...callback,
          data: { ...callback.data, status: "RUNNING" },
        })
      ).status,
      400,
    );
    assert.equal(downloads, 0);
    assert.equal((await post(callback)).status, 409);
    assert.equal(store.results("demo-b").length, 0);
    failSave = false;
    const accepted = await post(callback);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { received: true });
    const duplicate = await post(callback);
    assert.equal(duplicate.status, 200);
    assert.equal(downloads, 2);
    assert.equal(store.results("demo-b").length, 1);
    assert.deepEqual(store.results("demo-b")[0].payload, callback.data);
    assert.equal(store.results("demo-a").length, 0);
    assert.equal(
      (await post({ ...callback, externalUserId: "demo-user-a" })).status,
      409,
    );
    assert.equal(
      (
        await post({
          ...callback,
          data: { ...callback.data, context: { example: "changed" } },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await post({
          ...callback,
          eventId: randomUUID(),
          data: { ...callback.data, status: "FAILED", tasks: [] },
        })
      ).status,
      200,
    );
    assert.equal(downloads, 2);
    assert.equal(keyReads, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
