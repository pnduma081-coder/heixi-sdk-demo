import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MerchantClient } from "../server/merchant.ts";
import { Operations } from "../server/operations.ts";
import { Store } from "../server/store.ts";

function priced(userId: string, requestId: string, credits = 35) {
  return {
    quoteId: randomUUID(),
    externalUserId: userId,
    clientRequestId: requestId,
    estimatedCredits: credits,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    saleItems: [{ itemId: randomUUID(), credits }],
  };
}
test("API freezes sale before approve/submit and timeout after debit restores original quote without repricing", async () => {
  const store = new Store(":memory:");
  const user = store.user("demo-b"),
    body = { clientRequestId: randomUUID(), prompt: "fixture" };
  const q = priced(user.externalUserId, body.clientRequestId);
  let quoteReads = 0,
    submits = 0,
    approvals = 0;
  const api = new MerchantClient(
    "https://fixture.invalid",
    "fixture-key",
    async (input, options) => {
      const path = new URL(String(input)).pathname,
        params = JSON.parse(String(options?.body));
      assert.equal(params.externalUserId, user.externalUserId);
      if (path === "/api/v1/open/generation-quotes") {
        quoteReads++;
        assert.equal(params.path, "/open/design-jobs");
        assert.deepEqual(params.input, body);
        return Response.json({ code: 0, data: q });
      }
      assert.equal(
        store.sales.quote(user.id, body.clientRequestId)?.estimatedCredits,
        35,
      );
      if (path.endsWith("/approve")) {
        approvals++;
        assert.equal(params.estimatedCredits, 35);
        return Response.json({ code: 0, data: { approvalId: q.quoteId } });
      }
      assert.equal(path, `/api/v1/open/generation-quotes/${q.quoteId}/submit`);
      if (++submits === 1) {
        store.sales.receive({
          eventId: randomUUID(),
          eventVersion: "merchant-events/v1",
          eventType: "credits.sale_debited",
          externalUserId: user.externalUserId,
          occurredAt: new Date().toISOString(),
          data: {
            settlementId: `sale:${q.saleItems[0].itemId}:debit`,
            quoteId: q.quoteId,
            clientRequestId: body.clientRequestId,
            itemId: q.saleItems[0].itemId,
            taskNo: "AIfixture",
            amount: 35,
          },
        });
        throw new Error("accepted but response lost");
      }
      return Response.json({
        code: 0,
        data: { submission: { submissionNo: "GSfixture" } },
      });
    },
  );
  try {
    store.addCredit(user.id, 35, randomUUID());
    const ops = new Operations(api, store);
    await assert.rejects(
      () => ops.call(user, "design", body),
      /结果可能未确定/,
    );
    assert.equal(store.user(user.id).credits, 0);
    await ops.call(user, "design", body);
    await ops.call(user, "design", body);
    assert.deepEqual(
      { quoteReads, submits, approvals },
      { quoteReads: 1, submits: 2, approvals: 2 },
    );
    assert.equal(
      store.ledger(user.id).filter((row) => row.kind === "SALE_DEBIT").length,
      1,
    );
  } finally {
    store.close();
  }
});

test("all API generation operations use the quote chain and zero sale can be confirmed with zero balance", async () => {
  for (const [operation, path] of [
    ["design", "/open/design-jobs"],
    ["apparel", "/open/apparel-workflows"],
    ["video", "/open/video-workflows"],
  ]) {
    const store = new Store(":memory:");
    const user = store.user("demo-a"),
      q = priced(user.externalUserId, randomUUID(), 0),
      calls: string[] = [];
    try {
      const api = new MerchantClient(
        "https://fixture.invalid",
        "fixture-key",
        async (url, options) => {
          const pathname = new URL(String(url)).pathname,
            body = JSON.parse(String(options?.body));
          calls.push(pathname);
          if (pathname.endsWith("/generation-quotes")) {
            assert.equal(body.path, path);
            return Response.json({ code: 0, data: q });
          }
          if (pathname.endsWith("/approve")) {
            assert.equal(body.estimatedCredits, 0);
            return Response.json({ code: 0, data: { approvalId: q.quoteId } });
          }
          assert(pathname.endsWith("/submit"));
          return Response.json({
            code: 0,
            data: { submission: { submissionNo: "GSfixture" } },
          });
        },
      );
      await new Operations(api, store).call(user, operation, {
        clientRequestId: q.clientRequestId,
      });
      assert.equal(calls.length, 3);
      assert.equal(store.user(user.id).credits, 0);
    } finally {
      store.close();
    }
  }
});

test("missing pricing support, insufficient sale balance and legacy uncertain requests never fall back to direct generation", async () => {
  const store = new Store(":memory:");
  const user = store.user("demo-b");
  let mode = "missing",
    calls = 0;
  const api = new MerchantClient(
    "https://fixture.invalid",
    "fixture-key",
    async (input, options) => {
      calls++;
      assert.equal(
        new URL(String(input)).pathname,
        "/api/v1/open/generation-quotes",
      );
      if (mode === "missing")
        return Response.json(
          { code: 404, message: "missing" },
          { status: 404 },
        );
      const body = JSON.parse(String(options?.body)),
        q = priced(user.externalUserId, body.input.clientRequestId);
      return Response.json({
        code: 0,
        data: mode === "incomplete" ? { ...q, saleItems: undefined } : q,
      });
    },
  );
  try {
    const ops = new Operations(api, store);
    await assert.rejects(
      () => ops.call(user, "design", { clientRequestId: randomUUID() }),
      /尚未提供/,
    );
    mode = "incomplete";
    await assert.rejects(
      () => ops.call(user, "design", { clientRequestId: randomUUID() }),
      /完整的商户售价/,
    );
    mode = "insufficient";
    await assert.rejects(
      () => ops.call(user, "design", { clientRequestId: randomUUID() }),
      /算力不足/,
    );
    const legacy = { clientRequestId: randomUUID() };
    store.startRequest(user.id, legacy.clientRequestId, "design", legacy);
    await assert.rejects(() => ops.call(user, "design", legacy), /旧请求缺少/);
    store.finishRequest(
      user.id,
      legacy.clientRequestId,
      { submission: { submissionNo: "GSlegacy" } },
      "ACCEPTED",
    );
    assert.deepEqual(await ops.call(user, "design", legacy), {
      submission: { submissionNo: "GSlegacy" },
    });
    const sdkId = randomUUID(),
      sdkQuote = randomUUID(),
      sdkBody = { quoteId: sdkQuote, clientRequestId: sdkId };
    store.startRequest(user.id, sdkId, "sdkApproval", sdkBody);
    store.finishRequest(user.id, sdkId, { approvalId: sdkQuote }, "APPROVED");
    await assert.rejects(() => ops.approve(user, sdkBody), /旧批准缺少/);
    assert.equal(calls, 3);
    assert.equal(store.user(user.id).credits, 0);
  } finally {
    store.close();
  }
});
