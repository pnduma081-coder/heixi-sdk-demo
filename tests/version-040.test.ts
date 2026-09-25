import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveConfig } from "../server/config.ts";
import { sdkSignature } from "../server/connection.ts";
import { AppError } from "../server/errors.ts";
import { MerchantClient } from "../server/merchant.ts";
import { merchantHeaders } from "../server/merchant-auth.ts";
import { Operations } from "../server/operations.ts";
import { ResultService } from "../server/results.ts";
import { Store } from "../server/store.ts";
import { WebhookKeys } from "../server/webhook-keys.ts";
import { sdkDocs } from "../shared/sdk-release.ts";
import type { MerchantEvent } from "../shared/types.ts";

const sk = `sk-${"x".repeat(43)}`;
const auth = { version: "0.4.0", accessKey: `ak-${"a".repeat(32)}` } as const;
const success = (data: unknown) => Response.json({ code: 0, data });
function event(type: string, data: Record<string, unknown>): MerchantEvent {
  return {
    eventId: randomUUID(),
    eventVersion: "merchant-events/v1",
    eventType: type,
    externalUserId: "demo-user-a",
    occurredAt: new Date().toISOString(),
    data,
  };
}

test("0.4 auth covers JSON, query and upload; missing/legacy version never silently sends AK", async () => {
  let count = 0;
  const api = new MerchantClient(
    "https://fixture.invalid",
    sk,
    async (_url, options) => {
      const headers = new Headers(options?.headers);
      assert.equal(headers.get("Authorization"), `Bearer ${sk}`);
      assert.equal(headers.get("X-Merchant-Version"), "0.4.0");
      assert.equal(headers.get("X-Merchant-AK"), auth.accessKey);
      assert.equal(options?.redirect, "error");
      count++;
      return success({});
    },
    auth,
  );
  await api.request("/open/models", "demo-user-a");
  await api.request("/open/sdk/signature", "demo-user-a", {
    body: { parentOrigin: "https://host.example" },
  });
  await api.request("/open/materials/images", "demo-user-a", {
    file: new File(["fixture"], "test.png", { type: "image/png" }),
  });
  assert.equal(count, 3);
  assert.deepEqual(merchantHeaders(sk), { Authorization: `Bearer ${sk}` });
  assert.throws(
    () => merchantHeaders(sk, { accessKey: auth.accessKey }),
    /显式/,
  );
  assert.throws(() => merchantHeaders(sk, { version: "0.4.0" }), /AK/);
  assert.throws(
    () => merchantHeaders(sk, { ...auth, version: "0.5.0" as "0.4.0" }),
    /版本/,
  );
  const config = resolveConfig({
    env: { BLACK_RHINO_API_KEY: sk, BLACK_RHINO_ACCESS_KEY: auth.accessKey },
  });
  assert(!("apiGenerationMode" in config));
  assert(!("apiGenerationMode" in config.public));
  assert.equal(config.public.apiReady, true);
  assert(!JSON.stringify(config.public).includes(sk));
  const obsolete = resolveConfig({
    env: { BLACK_RHINO_API_GENERATION_MODE: "quote" },
  });
  assert(
    obsolete.public.configurationIssues?.some((issue) =>
      issue.includes("BLACK_RHINO_API_GENERATION_MODE"),
    ),
  );
  assert(!("apiGenerationMode" in obsolete));
  for (const version of ["0.3.0", "0.4.0"] as const) {
    for (const url of Object.values(sdkDocs(version)))
      assert(url.includes(`/docs/${version}/`));
  }
});

test("0.4 direct generation needs no SDK, quote, approval, callback or local balance; original request survives restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rhino-040-"));
  let store = new Store(join(directory, "test.sqlite"));
  let calls = 0;
  const body = { clientRequestId: randomUUID(), prompt: "synthetic" };
  const api = new MerchantClient(
    "https://fixture.invalid",
    sk,
    async (url, options) => {
      assert.equal(new URL(String(url)).pathname, "/api/v1/open/design-jobs");
      assert.deepEqual(JSON.parse(String(options?.body)), {
        ...body,
        externalUserId: "demo-user-a",
      });
      if (++calls === 1) throw new Error("response lost");
      return success({ submission: { submissionNo: "GSfixture" } });
    },
    auth,
  );
  try {
    await assert.rejects(
      () =>
        new Operations(api, store).call(store.user("demo-a"), "design", body),
      /结果可能未确定/,
    );
    store.close();
    store = new Store(join(directory, "test.sqlite"));
    const ops = new Operations(api, store);
    await ops.call(store.user("demo-a"), "design", body);
    await ops.call(store.user("demo-a"), "design", body);
    assert.equal(calls, 2);
    assert.equal(store.user("demo-a").credits, 0);
    assert.equal(store.sales.quote("demo-a", body.clientRequestId), undefined);
    await assert.rejects(
      () =>
        ops.call(store.user("demo-a"), "design", {
          ...body,
          prompt: "changed",
        }),
      /参数已变化/,
    );
    const legacyId = randomUUID();
    store.startRequest("demo-a", legacyId, "design", {
      clientRequestId: legacyId,
    });
    await assert.rejects(
      () =>
        ops.call(store.user("demo-a"), "design", { clientRequestId: legacyId }),
      /旧请求/,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit 0.4 Open API signature errors preserve 400/403 without extra credential probes (not iframe session behavior)", async () => {
  for (const status of [400, 403]) {
    let calls = 0;
    const api = new MerchantClient(
      "https://fixture.invalid",
      sk,
      async () => {
        calls++;
        return Response.json(
          { code: 40100, message: `private ${sk}`, traceId: "safe-trace" },
          { status },
        );
      },
      auth,
    );
    await assert.rejects(
      () => sdkSignature(api, "demo-user-a", "https://host.example"),
      (error: unknown) => {
        assert(error instanceof AppError);
        assert.equal(error.status, status);
        assert.match(error.message, status === 403 ? /未授权/ : /参数/);
        assert(!JSON.stringify(error).includes(sk));
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("default and explicit 0.3 Open API preserve legacy 401 while explicit 0.4 preserves parameter/permission statuses", async () => {
  for (const version of [undefined, "0.3.0", "0.4.0"] as const) {
    for (const [path, reason, currentStatus] of [
      ["/open/history", "externalUserId is required", 400],
      ["/open/models", "merchant feature is not authorized", 403],
      ["/open/sdk/signature", "SDK origin is not authorized", 403],
    ] as const) {
      const expectedStatus = version === "0.4.0" ? currentStatus : 401;
      const client = new MerchantClient(
        "https://fixture.invalid",
        sk,
        async (_url, options) => {
          const headers = new Headers(options?.headers);
          assert.equal(headers.get("Authorization"), `Bearer ${sk}`);
          assert.equal(
            headers.get("X-Merchant-Version"),
            version === "0.4.0" ? version : null,
          );
          assert.equal(
            headers.get("X-Merchant-AK"),
            version === "0.4.0" ? auth.accessKey : null,
          );
          return Response.json(
            {
              code: expectedStatus * 100,
              message: reason,
              traceId: "compatibility-fixture",
            },
            { status: expectedStatus },
          );
        },
        version === "0.4.0" ? auth : { version },
      );
      await assert.rejects(
        () => client.request(path, "demo-user-a"),
        (error: unknown) => {
          assert(error instanceof AppError);
          assert.equal(error.status, expectedStatus);
          assert.equal(
            (error.details as { code: number }).code,
            expectedStatus * 100,
          );
          assert.equal((error.details as { message: string }).message, reason);
          if (version !== "0.4.0") {
            assert.match(error.message, /旧版 API/);
            assert.doesNotMatch(error.message, /AK\/SK 不匹配/);
          }
          return true;
        },
      );
    }
  }
});

test("0.4 signing key requests carry version and AK but return only verified events", async () => {
  const e = event("credits.debited", { delta: -1 }),
    raw = Buffer.from(JSON.stringify(e));
  const keyId = randomUUID(),
    deliveryId = randomUUID(),
    timestamp = String(Math.floor(Date.now() / 1000)),
    secret = `whsec_${"s".repeat(43)}`;
  const keys = new WebhookKeys(
    "https://fixture.invalid",
    sk,
    async (_url, options) => {
      assert.equal(
        new Headers(options?.headers).get("X-Merchant-Version"),
        "0.4.0",
      );
      assert.equal(
        new Headers(options?.headers).get("X-Merchant-AK"),
        auth.accessKey,
      );
      return success({ keyId, secret });
    },
    auth,
  );
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${keyId}.${deliveryId}.${e.eventId}.`)
    .update(raw)
    .digest("hex");
  assert.deepEqual(
    await keys.verify(
      raw,
      {
        "x-black-rhino-timestamp": timestamp,
        "x-black-rhino-key-id": keyId,
        "x-black-rhino-delivery-id": deliveryId,
        "x-black-rhino-event-id": e.eventId,
        "x-black-rhino-signature": `v1=${signature}`,
      },
      "credits",
    ),
    e,
  );
});

test("no-callback polling persists raw events before advancing, retries failed processing and resumes after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rhino-events-040-"));
  let store = new Store(join(directory, "test.sqlite"));
  const quoteId = randomUUID(),
    itemId = randomUUID(),
    requestId = randomUUID();
  const sale = event("credits.sale_debited", {
    quoteId,
    itemId,
    clientRequestId: requestId,
    taskNo: "AItest",
    amount: 35,
    settlementId: `sale:${itemId}:debit`,
  });
  const cost = event("credits.debited", { delta: -20, ledgerId: randomUUID() });
  const result = event("generation.finished", {
    requestChannel: "API",
    submissionNo: "GSfixture",
    clientRequestId: requestId,
    status: "SUCCEEDED",
    terminal: true,
    tasks: [
      {
        role: "OUTPUT",
        results: [{ type: "image", url: "https://media.example/test.png" }],
      },
    ],
  });
  const refund = event("credits.sale_refunded", {
    ...sale.data,
    settlementId: `sale:${itemId}:refund`,
    originalDebitId: `sale:${itemId}:debit`,
  });
  let saveFails = true,
    requests = 0;
  const api = new MerchantClient(
    "https://fixture.invalid",
    sk,
    async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/api/v1/open/events");
      assert.equal(url.searchParams.get("externalUserId"), "demo-user-a");
      requests++;
      if (!url.searchParams.get("cursor"))
        return success({
          items: [sale, cost, result],
          nextCursor: result.eventId,
          hasMore: true,
        });
      if (url.searchParams.get("cursor") === result.eventId)
        return success({
          items: [refund],
          nextCursor: refund.eventId,
          hasMore: false,
        });
      assert.equal(url.searchParams.get("cursor"), refund.eventId);
      return success({ items: [], nextCursor: refund.eventId, hasMore: false });
    },
    auth,
  );
  const media = {
    save: async () => {
      if (saveFails) throw new Error("synthetic disk failure");
      return {
        id: "a".repeat(64),
        name: "test.png",
        contentType: "image/png",
        bytes: 1,
      };
    },
  };
  try {
    store.addCredit("demo-a", 100, randomUUID());
    store.sales.freeze(store.user("demo-a"), {
      quoteId,
      clientRequestId: requestId,
      externalUserId: "demo-user-a",
      estimatedCredits: 35,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      saleItems: [{ itemId, credits: 35 }],
    });
    let service = new ResultService(store, api, media);
    const firstSync = await service.syncEvents(store.user("demo-a"));
    assert.equal(firstSync.pending, 1);
    assert.match(service.syncIssue("demo-a") || "", /尚未处理成功/);
    assert.equal(store.apiEventCursor("demo-a"), result.eventId);
    assert.equal(store.user("demo-a").credits, 65);
    assert.equal(store.results("demo-a").length, 0);
    saveFails = false;
    service.inbox.retry("demo-a");
    await Promise.all([
      service.syncEvents(store.user("demo-a")),
      service.syncEvents(store.user("demo-a")),
    ]);
    assert.equal(requests, 2);
    assert.equal(store.user("demo-a").credits, 100);
    assert.equal(store.platformCosts("demo-a").length, 1);
    assert.equal(store.results("demo-a").length, 1);
    assert.equal(store.cursor("demo-a"), undefined);
    assert.equal(store.apiEventCursor("demo-a"), refund.eventId);
    await service.generation(result); // webhook after polling shares event idempotency
    store.sales.receive({ ...sale, eventId: randomUUID() }); // settlement idempotency
    assert.equal(store.user("demo-a").credits, 100);
    store.close();
    store = new Store(join(directory, "test.sqlite"));
    service = new ResultService(store, api, media);
    await service.syncEvents(store.user("demo-a"));
    assert.equal(store.results("demo-a").length, 1);
    assert.equal(store.ledger("demo-a").length, 3);
    assert.equal(store.results("demo-b").length, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("historical API quote recovery is preserved and SDK still requires host approval", async () => {
  const store = new Store(":memory:");
  const user = store.user("demo-a"),
    requestId = randomUUID(),
    sdkId = randomUUID();
  const quote = (clientRequestId: string) => ({
    quoteId: randomUUID(),
    externalUserId: user.externalUserId,
    clientRequestId,
    estimatedCredits: 35,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    saleItems: [{ itemId: randomUUID(), credits: 35 }],
  });
  const apiQuote = quote(requestId),
    sdkQuote = quote(sdkId),
    calls: string[] = [];
  let failSubmit = true;
  const api = new MerchantClient(
    "https://fixture.invalid",
    sk,
    async (input) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === "/api/v1/open/generation-quotes") return success(apiQuote);
      if (path === `/api/v1/open/sdk/generation-quotes/${sdkQuote.quoteId}`)
        return success(sdkQuote);
      if (path.endsWith("/approve"))
        return success({ approvalId: randomUUID() });
      assert.equal(
        path,
        `/api/v1/open/generation-quotes/${apiQuote.quoteId}/submit`,
      );
      if (failSubmit) {
        failSubmit = false;
        throw new Error("timeout");
      }
      return success({ submission: { submissionNo: "GSquoted" } });
    },
    auth,
  );
  try {
    const direct = new Operations(api, store);
    await assert.rejects(
      () =>
        direct.approve(user, {
          quoteId: sdkQuote.quoteId,
          clientRequestId: sdkId,
        }),
      /算力不足/,
    );
    assert.equal(
      calls.some((path) => path.endsWith("/approve")),
      false,
    );
    store.addCredit(user.id, 100, randomUUID());
    await direct.approve(user, {
      quoteId: sdkQuote.quoteId,
      clientRequestId: sdkId,
    });
    assert.equal(store.sales.quote(user.id, sdkId)?.estimatedCredits, 35);
    store.db
      .prepare("INSERT INTO api_request_modes VALUES(?,?,?)")
      .run(user.id, requestId, "quote");
    store.startRequest(user.id, requestId, "design", {
      clientRequestId: requestId,
    });
    store.sales.freeze(user, apiQuote);
    await assert.rejects(
      () =>
        new Operations(api, store).call(user, "design", {
          clientRequestId: requestId,
        }),
      /结果可能未确定/,
    );
    await direct.call(user, "design", { clientRequestId: requestId });
    assert.equal(
      calls.filter((path) => path === "/api/v1/open/generation-quotes").length,
      0,
    );
    assert.equal(
      store.sales.quote(user.id, requestId)?.quoteId,
      apiQuote.quoteId,
    );
    assert.equal(store.user(user.id).credits, 100); // approval alone never charges
  } finally {
    store.close();
  }
});

test("foreign events or malformed pagination cannot advance the API cursor", async () => {
  const store = new Store(":memory:");
  try {
    const e = {
      ...event("credits.debited", { delta: -5 }),
      externalUserId: "demo-user-b",
    };
    for (const data of [
      { items: [e], nextCursor: e.eventId, hasMore: false },
      { items: [], nextCursor: randomUUID(), hasMore: true },
    ]) {
      const api = new MerchantClient(
        "https://fixture.invalid",
        sk,
        async () => success(data),
        auth,
      );
      const results = new ResultService(store, api, {
        save: async () => assert.fail("no media"),
      });
      await assert.rejects(() => results.syncEvents(store.user("demo-a")));
      assert.equal(store.apiEventCursor("demo-a"), undefined);
      assert.equal(store.platformCosts("demo-b").length, 0);
    }
  } finally {
    store.close();
  }
});
