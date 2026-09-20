import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { hostOrigin, sdkApiOrigin } from "../server/config.ts";
import { createHandler } from "../server/http.ts";
import { MerchantClient } from "../server/merchant.ts";
import { Operations } from "../server/operations.ts";
import { ResultService } from "../server/results.ts";
import { Store } from "../server/store.ts";
import { approveGeneration } from "../src/sdk-approval.ts";

test("SDK approval callback maps only explicit business refusals, uses authoritative balance and keeps approval semantics", async (t) => {
  const store = new Store(":memory:");
  let mode = "quote",
    approvals = 0;
  const requests: string[] = [];
  let request = {
    quoteId: randomUUID(),
    clientRequestId: randomUUID(),
    estimatedCredits: 0,
  };
  const client = new MerchantClient(
    "https://fixture.invalid",
    "fixture-key",
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (mode === "network") throw new Error("private network error");
      if (mode === "unknown")
        return Response.json(
          {
            code: 40900,
            message: "本地用户算力不足，请先增加测试算力",
            businessCode: "INSUFFICIENT_CREDITS",
            stack: "private upstream stack",
          },
          { status: 409 },
        );
      if (path.endsWith("/approve")) {
        approvals++;
        assert.equal(JSON.parse(String(init?.body)).estimatedCredits, 50);
        return Response.json({
          code: 0,
          data: { approvalId: request.quoteId },
        });
      }
      return Response.json({
        code: 0,
        data: {
          clientRequestId:
            mode === "mismatch" ? "different-request" : request.clientRequestId,
          quoteId: request.quoteId,
          externalUserId: "demo-user-a",
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          saleItems: [{ itemId: randomUUID(), credits: 50 }],
          estimatedCredits: 50,
        },
      });
    },
  );
  const resultService = new ResultService(store, client, {
    save: async () => {
      throw new Error("No media access allowed");
    },
  });
  const handler = createHandler(
    {
      apiOrigin: client.apiOrigin,
      apiKey: client.key,
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
    client,
    new Operations(client, store),
    resultService,
  );
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const token = store.newSession("demo-a");
  const originalFetch = globalThis.fetch;
  const responses: unknown[] = [];
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.equal(input, "/api/sdk/approve");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-demo-user"), "demo-a");
      headers.set("origin", hostOrigin);
      headers.set("cookie", `demo_session=${token}`);
      const response = await originalFetch(origin + input, {
        ...init,
        headers,
      });
      responses.push(await response.clone().json());
      return response;
    },
  );
  const generate = () =>
    approveGeneration("demo-a", request, new AbortController().signal);
  try {
    assert.deepEqual(await generate(), {
      approved: false,
      message: "算力不足，请充值",
    });
    assert.equal(
      (responses[0] as { businessCode: string }).businessCode,
      "INSUFFICIENT_CREDITS",
    );
    assert.equal(approvals, 0);
    assert.equal(requests.length, 1); // 只取权威报价，没有批准/生成提交。
    assert.equal(store.results("demo-a").length, 0);
    assert.equal(store.ledger("demo-a").length, 0);

    // 使用原请求重试；充值后不再返回不足，也不在批准时扣款。
    store.addCredit("demo-a", 100, randomUUID());
    assert.deepEqual(await generate(), { approvalId: request.quoteId });
    assert.deepEqual(await generate(), { approvalId: request.quoteId });
    assert.equal(approvals, 1);
    assert.equal(store.user("demo-a").credits, 100);

    request = { ...request, quoteId: randomUUID() };
    assert.deepEqual(await generate(), {
      approved: false,
      message: "请求已变化，请重新发起生成",
    });
    request = { ...request, clientRequestId: randomUUID() };
    mode = "mismatch";
    assert.deepEqual(await generate(), {
      approved: false,
      message: "报价已变化，请重新发起生成",
    });
    for (const failure of ["network", "unknown"]) {
      mode = failure;
      request = { ...request, clientRequestId: randomUUID() };
      await assert.rejects(generate, { message: "生成失败，请稍后重试" });
    }
    assert.equal(approvals, 1);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      () => approveGeneration("demo-a", request, cancelled.signal),
      { name: "AbortError" },
    );
  } finally {
    fetchMock.mock.restore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test("SDK refusal does not trust plain 409 text, unknown codes, wrong statuses or internal details", async (t) => {
  const originalFetch = globalThis.fetch;
  let response: Response;
  t.mock.method(globalThis, "fetch", async () => response.clone());
  try {
    for (const value of [
      { status: 409, body: { error: "算力不足，请充值" } },
      {
        status: 409,
        body: { error: "private error", businessCode: "UNKNOWN" },
      },
      {
        status: 500,
        body: { error: "private error", businessCode: "INSUFFICIENT_CREDITS" },
      },
      {
        status: 409,
        body: { error: "private error", businessCode: "toString" },
      },
    ]) {
      response = Response.json(value.body, { status: value.status });
      await assert.rejects(
        () => approveGeneration("demo-a", {}, new AbortController().signal),
        { message: "生成失败，请稍后重试" },
      );
    }
    response = Response.json(
      {
        error: "private stack",
        details: { internal: "must-not-leak" },
        businessCode: "INSUFFICIENT_CREDITS",
      },
      { status: 409 },
    );
    assert.deepEqual(
      await approveGeneration("demo-a", {}, new AbortController().signal),
      { approved: false, message: "算力不足，请充值" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
