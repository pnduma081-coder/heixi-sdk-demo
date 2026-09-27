import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MerchantClient } from "../server/merchant.ts";
import { Operations } from "../server/operations.ts";
import type { SaleQuote } from "../server/sale-ledger.ts";
import { Store } from "../server/store.ts";
import type { MerchantEvent } from "../shared/types.ts";

function quote(store: Store): SaleQuote {
  return {
    quoteId: randomUUID(),
    clientRequestId: randomUUID(),
    externalUserId: store.user("demo-a").externalUserId,
    estimatedCredits: 60,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    saleItems: [{ itemId: randomUUID(), credits: 60 }],
  };
}
function event(q: SaleQuote, refund = false): MerchantEvent {
  const id = q.saleItems[0].itemId;
  return {
    eventId: randomUUID(),
    eventType: refund ? "credits.sale_refunded" : "credits.sale_debited",
    eventVersion: "merchant-events/v1",
    externalUserId: q.externalUserId,
    occurredAt: new Date().toISOString(),
    data: {
      quoteId: q.quoteId,
      clientRequestId: q.clientRequestId,
      itemId: id,
      amount: 60,
      taskNo: "AI-audit",
      settlementId: `sale:${id}:${refund ? "refund" : "debit"}`,
      ...(refund ? { originalDebitId: `sale:${id}:debit` } : {}),
    },
  };
}
function client(quotes: SaleQuote[], approve?: () => void) {
  return new MerchantClient(
    "https://fixture.invalid",
    "fixture-key",
    async (input, options) => {
      const path = new URL(String(input)).pathname;
      const q = quotes.find((q) => path.includes(q.quoteId));
      assert(q);
      if (path.endsWith("/approve")) {
        approve?.();
        const body = JSON.parse(String(options?.body));
        assert.equal(body.estimatedCredits, 60);
        return Response.json({ code: 0, data: { approvalId: q.quoteId } });
      }
      return Response.json({ code: 0, data: q });
    },
  );
}

test("new SDK requests approve at zero balance without topups, reservations or trusting browser price", async () => {
  const store = new Store(":memory:");
  try {
    const qa = quote(store),
      qb = quote(store);
    let calls = 0;
    const ops = new Operations(
      client([qa, qb], () => calls++),
      store,
    );
    await Promise.all(
      [qa, qb].map((q) =>
        ops.approve(store.user("demo-a"), {
          quoteId: q.quoteId,
          clientRequestId: q.clientRequestId,
          estimatedCredits: 99999,
        }),
      ),
    );
    await ops.approve(store.user("demo-a"), qa);
    assert.equal(calls, 2);
    assert.equal(store.user("demo-a").credits, 0);
    assert.equal(store.sales.held("demo-a"), 0);
    assert.equal(store.ledger("demo-a").length, 0);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM sale_reservations").get()?.n,
      0,
    );
    assert.equal(
      store.sales.approvalPolicy("demo-a", qa.clientRequestId),
      "AUDIT_ONLY",
    );
  } finally {
    store.close();
  }
});

test("audit settlements handle refunds before debit, quote arrival, duplicates and restart without changing balance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhino-audit-"));
  const path = join(dir, "test.sqlite");
  let store = new Store(path);
  try {
    const q = quote(store);
    const debit = event(q),
      refund = event(q, true);
    store.sales.receive(refund);
    store.sales.receive(debit);
    assert.equal(store.sales.pending("demo-a").length, 2);
    await new Operations(client([q]), store).approve(store.user("demo-a"), q);
    store.sales.receive(debit);
    store.sales.receive({ ...debit, eventId: randomUUID() });
    assert.equal(store.sales.pending("demo-a").length, 0);
    assert.equal(store.sales.records("demo-a").length, 2);
    assert(store.sales.records("demo-a").every((r) => r.status === "RECORDED"));
    assert.equal(store.user("demo-a").credits, 0);
    assert.equal(store.ledger("demo-a").length, 0);
    store.close();
    store = new Store(path);
    assert.equal(
      store.sales.approvalPolicy("demo-a", q.clientRequestId),
      "AUDIT_ONLY",
    );
    assert.equal(store.sales.held("demo-a"), 0);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM sale_reservations").get()?.n,
      0,
    );
    await new Operations(
      client([q], () => assert.fail("replay must be cached")),
      store,
    ).approve(store.user("demo-a"), q);
    assert.deepEqual(store.sales.records("demo-b"), []);
    assert.throws(
      () => store.sales.freeze(store.user("demo-a"), q),
      /记账方式不能改变/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upgrade retains old quotes, balances and unknown reservations while isolating new requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhino-policy-upgrade-"));
  const path = join(dir, "test.sqlite");
  let store = new Store(path);
  try {
    store.addCredit("demo-a", 100, randomUUID());
    const old = quote(store);
    const body = { quoteId: old.quoteId, clientRequestId: old.clientRequestId };
    store.startRequest("demo-a", old.clientRequestId, "sdkApproval", body);
    await store.sales.withReservation(store.user("demo-a"), old, async () => ({
      approvalId: old.quoteId,
    }));
    store.finishRequest(
      "demo-a",
      old.clientRequestId,
      { approvalId: old.quoteId },
      "APPROVED",
    );
    const before = store.ledger("demo-a");
    store.db.exec(
      "DROP TABLE sale_quote_policies; DROP TABLE sdk_approval_policies;",
    );
    store.close();
    store = new Store(path);
    assert.deepEqual(store.ledger("demo-a"), before);
    assert.equal(store.sales.held("demo-a"), 60);
    assert.equal(
      store.sales.approvalPolicy("demo-a", old.clientRequestId),
      "LEGACY_BALANCE",
    );
    const fresh = quote(store);
    await new Operations(client([fresh]), store).approve(
      store.user("demo-a"),
      fresh,
    );
    assert.equal(store.sales.held("demo-a"), 60);
    store.sales.receive(event(fresh));
    assert.equal(store.user("demo-a").credits, 100);
    store.sales.receive(event(old));
    assert.equal(store.user("demo-a").credits, 40);
    assert.equal(store.sales.held("demo-a"), 0);
    assert.equal(
      store.sales.records("demo-a").filter((r) => r.status === "APPLIED")
        .length,
      1,
    );
    store.sales.receive(event(old, true));
    assert.equal(store.user("demo-a").credits, 100);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lost new approval response keeps audit policy across restart and never creates a wallet hold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhino-audit-retry-"));
  const path = join(dir, "test.sqlite");
  let store = new Store(path);
  try {
    const q = quote(store);
    await assert.rejects(() =>
      new Operations(
        client([q], () => {
          throw Error("lost response");
        }),
        store,
      ).approve(store.user("demo-a"), q),
    );
    store.close();
    store = new Store(path);
    await new Operations(client([q]), store).approve(store.user("demo-a"), q);
    assert.equal(store.sales.held("demo-a"), 0);
    assert.equal(
      store.sales.approvalPolicy("demo-a", q.clientRequestId),
      "AUDIT_ONLY",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
