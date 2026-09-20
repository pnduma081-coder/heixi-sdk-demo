import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type SaleQuote, saleQuote } from "../server/sale-ledger.ts";
import { digest, Store } from "../server/store.ts";
import type { MerchantEvent } from "../shared/types.ts";

function quote(store: Store, prices = [35], userId = "demo-b"): SaleQuote {
  return {
    quoteId: randomUUID(),
    clientRequestId: randomUUID(),
    externalUserId: store.user(userId).externalUserId,
    estimatedCredits: prices.reduce((a, b) => a + b, 0),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    saleItems: prices.map((credits) => ({ itemId: randomUUID(), credits })),
  };
}
function sale(q: SaleQuote, index = 0, refund = false): MerchantEvent {
  const item = q.saleItems[index];
  return {
    eventId: randomUUID(),
    eventVersion: "merchant-events/v1",
    eventType: refund ? "credits.sale_refunded" : "credits.sale_debited",
    externalUserId: q.externalUserId,
    occurredAt: new Date().toISOString(),
    data: {
      settlementId: `sale:${item.itemId}:${refund ? "refund" : "debit"}`,
      quoteId: q.quoteId,
      clientRequestId: q.clientRequestId,
      itemId: item.itemId,
      taskNo: refund ? "AItransferred" : "AIinitial",
      amount: item.credits,
      ...(refund ? { originalDebitId: `sale:${item.itemId}:debit` } : {}),
    },
  };
}
function cost(q: SaleQuote, delta = -20): MerchantEvent {
  return {
    eventId: randomUUID(),
    eventVersion: "merchant-events/v1",
    eventType: delta < 0 ? "credits.debited" : "credits.refunded",
    externalUserId: q.externalUserId,
    occurredAt: new Date().toISOString(),
    data: {
      ledgerId: randomUUID(),
      clientRequestId: q.clientRequestId,
      taskNo: "AIinitial",
      delta,
    },
  };
}

test("cost20 and sale35 use separate ledgers; duplicate events and business IDs never charge twice", () => {
  const store = new Store(":memory:");
  try {
    const user = store.user("demo-b"),
      q = quote(store);
    store.addCredit(user.id, 100, randomUUID());
    store.sales.freeze(user, q);
    const platform = cost(q);
    store.creditEvent(platform);
    store.creditEvent(platform);
    assert.equal(store.user(user.id).credits, 100);
    assert.equal(store.platformCosts(user.id).length, 1);
    const debit = sale(q);
    store.sales.receive(debit);
    store.sales.receive(debit);
    store.sales.receive({ ...debit, eventId: randomUUID() });
    assert.equal(store.user(user.id).credits, 65);
    assert.equal(store.ledger(user.id).length, 2);
    assert.throws(
      () =>
        store.sales.receive({
          ...debit,
          eventId: randomUUID(),
          data: { ...debit.data, amount: 20 },
        }),
      /内容或身份/,
    );
    assert.throws(
      () =>
        store.sales.receive({
          ...debit,
          eventId: randomUUID(),
          externalUserId: store.user("demo-a").externalUserId,
        }),
      /内容或身份/,
    );
    const refund = sale(q, 0, true);
    store.sales.receive(refund);
    store.sales.receive({ ...refund, eventId: randomUUID() });
    store.creditEvent(cost(q, 20));
    assert.equal(store.user(user.id).credits, 100);
    assert.equal(store.user("demo-a").credits, 0);
    assert.equal(store.ledger(user.id).length, 3);
  } finally {
    store.close();
  }
});

test("zero sale still settles and zero cost does not prevent a nonzero user sale", () => {
  const store = new Store(":memory:");
  try {
    const user = store.user("demo-b");
    store.addCredit(user.id, 100, randomUUID());
    const free = quote(store, [0]);
    store.sales.freeze(user, free);
    store.creditEvent(cost(free));
    store.sales.receive(sale(free));
    store.sales.receive(sale(free, 0, true));
    assert.equal(store.user(user.id).credits, 100);
    assert.deepEqual(
      store
        .ledger(user.id)
        .filter((row) => row.kind.startsWith("SALE_"))
        .map((row) => row.delta),
      [0, 0],
    );
    const paid = quote(store, [40]);
    store.sales.freeze(user, paid);
    store.sales.receive(sale(paid));
    assert.equal(store.user(user.id).credits, 60); // 平台0成本无需伪造成本事件。
  } finally {
    store.close();
  }
});

test("frozen item prices survive price changes and partial task failure refunds exactly the failed item", () => {
  const store = new Store(":memory:");
  try {
    const user = store.user("demo-b"),
      q = quote(store, [30, 70]);
    store.addCredit(user.id, 200, randomUUID());
    store.sales.freeze(user, q);
    assert.throws(
      () =>
        store.sales.freeze(user, {
          ...q,
          estimatedCredits: 110,
          saleItems: [{ ...q.saleItems[0], credits: 40 }, q.saleItems[1]],
        }),
      /冻结不同/,
    );
    store.sales.receive(sale(q, 0));
    store.sales.receive(sale(q, 1));
    assert.equal(store.user(user.id).credits, 100);
    const refund = sale(q, 0, true);
    assert.throws(
      () =>
        store.sales.receive({
          ...refund,
          data: { ...refund.data, amount: 20 },
        }),
      /冻结的商户售价/,
    );
    store.sales.receive(refund);
    assert.equal(store.user(user.id).credits, 130);
    assert.deepEqual(store.sales.quote(user.id, q.clientRequestId), q);
  } finally {
    store.close();
  }
});

test("callbacks before the quote and refund before debit remain durable and reconcile after restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "rhino-sale-"));
  let store = new Store(join(directory, "fixture.sqlite"));
  try {
    const q = quote(store);
    store.addCredit("demo-b", 100, randomUUID());
    const refund = sale(q, 0, true),
      debit = sale(q);
    store.sales.receive(refund);
    store.sales.receive(debit);
    assert.equal(store.user("demo-b").credits, 100);
    assert.equal(store.sales.pending("demo-b").length, 2);
    store.close();
    store = new Store(join(directory, "fixture.sqlite"));
    store.sales.freeze(store.user("demo-b"), q);
    assert.equal(store.user("demo-b").credits, 100);
    assert.equal(store.sales.pending("demo-b").length, 0);
    assert.deepEqual(
      store
        .ledger("demo-b")
        .filter((row) => row.kind.startsWith("SALE_"))
        .map((row) => row.delta),
      [35, -35],
    );
    store.sales.receive(refund);
    store.sales.receive(debit);
    assert.equal(store.ledger("demo-b").length, 3);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refund waits for original debit; transaction failure cannot leave a partial user charge", () => {
  const store = new Store(":memory:");
  try {
    const q = quote(store),
      user = store.user("demo-b");
    store.addCredit(user.id, 100, randomUUID());
    store.sales.freeze(user, q);
    store.sales.receive(sale(q, 0, true));
    assert.equal(store.user(user.id).credits, 100);
    const debit = sale(q);
    store.db.exec(
      "CREATE TRIGGER fail_sale BEFORE INSERT ON ledger BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    );
    assert.throws(() => store.sales.receive(debit), /fixture failure/);
    assert.equal(store.user(user.id).credits, 100);
    assert.equal(store.processed(debit.eventId, user.id), false);
    store.db.exec("DROP TRIGGER fail_sale");
    store.sales.receive(debit);
    assert.equal(store.user(user.id).credits, 100);
    assert.equal(store.sales.pending(user.id).length, 0);
  } finally {
    store.close();
  }
});

test("legacy cost debit stays unchanged, new generation costs are audit-only and template licenses retain original behavior", () => {
  const store = new Store(":memory:");
  try {
    const q = quote(store),
      old = cost(q);
    store.addCredit("demo-b", 1000, randomUUID());
    store.transaction(() => {
      store.changeBalance("demo-b", -20, old.eventType, old.eventId);
      store.db
        .prepare("INSERT INTO events VALUES(?,?,?,?)")
        .run(old.eventId, "demo-b", digest(old), old.occurredAt);
    });
    store.creditEvent(old);
    assert.equal(store.user("demo-b").credits, 980);
    store.creditEvent(cost(q));
    assert.equal(store.user("demo-b").credits, 980);
    store.creditEvent({ ...cost(q), eventType: "credits.license_debited" });
    assert.equal(store.user("demo-b").credits, 960);
    assert.throws(
      () =>
        saleQuote(
          { ...q, saleItems: undefined },
          store.user("demo-b"),
          q.clientRequestId,
        ),
      /完整的商户售价/,
    );
    assert.throws(() => store.creditEvent(sale(q)), /成本事件类型/);
  } finally {
    store.close();
  }
});
