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
test("historical API quote retries reuse its saved price and never switch to direct generation", async () => {
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
        assert.fail("historical recovery must not create a quote");
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
    store.db
      .prepare("INSERT INTO api_request_modes VALUES(?,?,?)")
      .run(user.id, body.clientRequestId, "quote");
    store.startRequest(user.id, body.clientRequestId, "design", body);
    store.sales.freeze(user, q);
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
      { quoteReads: 0, submits: 2, approvals: 2 },
    );
    assert.equal(
      store.ledger(user.id).filter((row) => row.kind === "SALE_DEBIT").length,
      1,
    );
  } finally {
    store.close();
  }
});

test("all new API generation operations submit directly with zero user balance and never create quotes", async () => {
  for (const [operation, path] of [
    ["design", "/open/design-jobs"],
    ["apparel", "/open/apparel-workflows"],
    ["video", "/open/video-workflows"],
  ]) {
    const store = new Store(":memory:");
    const user = store.user("demo-a"),
      id = randomUUID(),
      calls: string[] = [];
    try {
      const api = new MerchantClient(
        "https://fixture.invalid",
        "fixture-key",
        async (url, options) => {
          const pathname = new URL(String(url)).pathname;
          const body = JSON.parse(String(options?.body));
          calls.push(pathname);
          assert.equal(pathname, `/api/v1${path}`);
          assert.equal(body.externalUserId, user.externalUserId);
          assert.equal(body.clientRequestId, id);
          return Response.json({
            code: 0,
            data: { submission: { submissionNo: "GSfixture" } },
          });
        },
        { version: "0.4.0", accessKey: `ak-${"a".repeat(32)}` },
      );
      await new Operations(api, store).call(user, operation, {
        clientRequestId: id,
      });
      assert.equal(calls.length, 1);
      assert.equal(store.user(user.id).credits, 0);
      assert.equal(store.sales.quote(user.id, id), undefined);
      assert.equal(
        store.db
          .prepare("SELECT COUNT(*) AS count FROM sale_request_intents")
          .get()?.count,
        0,
      );
    } finally {
      store.close();
    }
  }
});

test("ambiguous legacy requests cannot resubmit, completed responses remain readable and old SDK approvals require snapshots", async () => {
  const store = new Store(":memory:");
  const user = store.user("demo-b");
  const api = new MerchantClient(
    "https://fixture.invalid",
    "fixture-key",
    async () => assert.fail("must not send a new generation"),
  );
  try {
    const ops = new Operations(api, store);
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
    const unfinished = { clientRequestId: randomUUID() };
    store.db
      .prepare("INSERT INTO sale_request_intents VALUES(?,?)")
      .run(user.id, unfinished.clientRequestId);
    store.startRequest(
      user.id,
      unfinished.clientRequestId,
      "design",
      unfinished,
    );
    await assert.rejects(
      () => ops.call(user, "design", unfinished),
      /旧报价请求缺少冻结快照/,
    );
    const sdkId = randomUUID(),
      sdkQuote = randomUUID(),
      sdkBody = { quoteId: sdkQuote, clientRequestId: sdkId };
    store.startRequest(user.id, sdkId, "sdkApproval", sdkBody);
    store.finishRequest(user.id, sdkId, { approvalId: sdkQuote }, "APPROVED");
    await assert.rejects(() => ops.approve(user, sdkBody), /旧批准缺少/);
    assert.equal(store.user(user.id).credits, 0);
  } finally {
    store.close();
  }
});
