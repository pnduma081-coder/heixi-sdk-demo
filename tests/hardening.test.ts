import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppError, resultSaveError } from "../server/errors.ts";
import { EventInbox } from "../server/event-inbox.ts";
import { EventPoller } from "../server/event-poller.ts";
import { MerchantClient } from "../server/merchant.ts";
import { Operations } from "../server/operations.ts";
import type { SaleQuote } from "../server/sale-ledger.ts";
import { Store } from "../server/store.ts";
import type { MerchantEvent } from "../shared/types.ts";

function quote(store: Store, prices = [60]): SaleQuote {
  const value = {
    quoteId: randomUUID(),
    clientRequestId: randomUUID(),
    externalUserId: store.user("demo-a").externalUserId,
    estimatedCredits: prices.reduce((a, b) => a + b, 0),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    saleItems: prices.map((credits) => ({ itemId: randomUUID(), credits })),
  };
  // This suite preserves the previous wallet policy for historical requests.
  store.db
    .prepare("INSERT INTO sdk_approval_policies VALUES(?,?,'LEGACY_BALANCE')")
    .run("demo-a", value.clientRequestId);
  return value;
}
function sale(q: SaleQuote, index: number, refund = false): MerchantEvent {
  const item = q.saleItems[index];
  const debit = `sale:${item.itemId}:debit`;
  return {
    eventId: randomUUID(),
    eventVersion: "merchant-events/v1",
    eventType: refund ? "credits.sale_refunded" : "credits.sale_debited",
    externalUserId: q.externalUserId,
    occurredAt: new Date().toISOString(),
    data: {
      quoteId: q.quoteId,
      clientRequestId: q.clientRequestId,
      itemId: item.itemId,
      amount: item.credits,
      taskNo: "AI-test",
      settlementId: refund ? `sale:${item.itemId}:refund` : debit,
      ...(refund ? { originalDebitId: debit } : {}),
    },
  };
}

test("historical SDK approvals reserve atomically across independent store connections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhino-hold-"));
  const path = join(dir, "test.sqlite");
  const a = new Store(path),
    b = new Store(path);
  try {
    a.addCredit("demo-a", 100, randomUUID());
    const qa = quote(a),
      qb = quote(a);
    let approvals = 0;
    const client = new MerchantClient(
      "https://fixture.invalid",
      "fixture-key",
      async (url) => {
        const p = new URL(String(url)).pathname;
        const q = p.includes(qa.quoteId) ? qa : qb;
        if (p.endsWith("/approve")) {
          approvals++;
          return Response.json({ code: 0, data: { approvalId: q.quoteId } });
        }
        return Response.json({ code: 0, data: q });
      },
    );
    const results = await Promise.allSettled([
      new Operations(client, a).approve(a.user("demo-a"), qa),
      new Operations(client, b).approve(b.user("demo-a"), qb),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(approvals, 1);
    assert.equal(a.sales.held("demo-a"), 60);
    assert.equal(a.user("demo-a").credits, 100);
    assert.equal(a.sales.reservations("demo-b").length, 0);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ambiguous approval survives restart, original retry never reserves twice, settlement consumes only its items", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhino-hold-restart-"));
  const path = join(dir, "test.sqlite");
  let store = new Store(path);
  try {
    store.addCredit("demo-a", 100, randomUUID());
    const q = quote(store, [40, 30]);
    let fail = true,
      calls = 0;
    const client = new MerchantClient(
      "https://fixture.invalid",
      "fixture-key",
      async (url) => {
        if (String(url).endsWith("/approve")) {
          calls++;
          if (fail) throw Error("lost reply");
          return Response.json({ code: 0, data: { approvalId: q.quoteId } });
        }
        return Response.json({ code: 0, data: q });
      },
    );
    await assert.rejects(() =>
      new Operations(client, store).approve(store.user("demo-a"), q),
    );
    assert.equal(store.sales.held("demo-a"), 70);
    store.close();
    store = new Store(path);
    assert.equal(store.sales.held("demo-a"), 70);
    fail = false;
    const ops = new Operations(client, store);
    await ops.approve(store.user("demo-a"), q);
    await ops.approve(store.user("demo-a"), q);
    assert.equal(calls, 2);
    assert.equal(store.sales.held("demo-a"), 70);
    const debit = sale(q, 0);
    store.sales.receive(debit);
    store.sales.receive(debit);
    assert.equal(store.user("demo-a").credits, 60);
    assert.equal(store.sales.held("demo-a"), 30);
    store.sales.receive(sale(q, 0, true));
    assert.equal(store.user("demo-a").credits, 100);
    assert.equal(store.sales.held("demo-a"), 30);
    store.sales.receive(sale(q, 1));
    assert.equal(store.user("demo-a").credits, 70);
    assert.equal(store.sales.held("demo-a"), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit first rejection releases its hold; a later rejection cannot erase an uncertain approval", async () => {
  const store = new Store(":memory:");
  try {
    store.addCredit("demo-a", 100, randomUUID());
    const q = quote(store);
    let network = false;
    const client = new MerchantClient(
      "https://fixture.invalid",
      "fixture-key",
      async (url) => {
        if (!String(url).endsWith("/approve"))
          return Response.json({ code: 0, data: q });
        if (network) throw Error("timeout");
        return Response.json(
          { code: 40900, message: "rejected" },
          { status: 409 },
        );
      },
    );
    const ops = new Operations(client, store);
    await assert.rejects(() => ops.approve(store.user("demo-a"), q));
    assert.equal(store.sales.held("demo-a"), 0);
    network = true;
    await assert.rejects(() => ops.approve(store.user("demo-a"), q));
    assert.equal(store.sales.held("demo-a"), 60);
    network = false;
    await assert.rejects(() => ops.approve(store.user("demo-a"), q));
    assert.equal(store.sales.held("demo-a"), 60);
  } finally {
    store.close();
  }
});

test("reservation and quote roll back on insufficient available credit; early refunds remain ordered", async () => {
  const store = new Store(":memory:");
  try {
    const q = quote(store, [50]);
    const user = store.user("demo-a");
    await assert.rejects(() =>
      store.sales.withReservation(user, q, async () =>
        assert.fail("no approval"),
      ),
    );
    assert.equal(store.sales.quote(user.id, q.clientRequestId), undefined);
    store.addCredit(user.id, 50, randomUUID());
    store.sales.receive(sale(q, 0, true));
    await store.sales.withReservation(user, q, async () => ({}));
    assert.equal(store.sales.held(user.id), 50);
    store.sales.receive(sale(q, 0));
    assert.equal(store.sales.held(user.id), 0);
    assert.equal(store.user(user.id).credits, 50);
  } finally {
    store.close();
  }
});

test("event diagnostics persist safe categories, attempts and dates and remain user-scoped", () => {
  const dir = mkdtempSync(join(tmpdir(), "rhino-diagnostic-"));
  const path = join(dir, "test.sqlite");
  let store = new Store(path);
  try {
    let inbox = new EventInbox(store);
    const user = store.user("demo-a");
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    inbox.receive(
      user,
      ids.map((eventId) => ({
        eventId,
        externalUserId: user.externalUserId,
        data: { submissionNo: "GS-example", secret: "sk-private" },
      })),
      ids[2],
    );
    inbox.failed(
      user.id,
      ids[0],
      0,
      1000,
      resultSaveError(502, "secret URL sk-private"),
    );
    inbox.failed(
      user.id,
      ids[1],
      2,
      1000,
      new AppError(409, "secret quote details"),
    );
    inbox.failed(user.id, ids[2], 0, 1000, Error("private filesystem"));
    store.close();
    store = new Store(path);
    inbox = new EventInbox(store);
    const rows = inbox.diagnostics(user.id);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      new Set(rows.map((r) => r.category)),
      new Set(["MEDIA", "CONTRACT", "PROCESSING"]),
    );
    assert(rows.every((r) => r.attempts === 1));
    assert(rows.every((r) => Date.parse(r.nextAttemptAt) > 1000));
    assert(!JSON.stringify(rows).includes("private"));
    assert.deepEqual(inbox.diagnostics("demo-b"), []);
    inbox.complete(user.id, ids[0]);
    assert.equal(inbox.diagnostics(user.id).length, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler discovers periodically, wakes new users, bounds backlog bursts and preserves wake during sync", async () => {
  let now = 0,
    scans = 0;
  const counts = new Map<string, number>();
  const a = { id: "a", name: "a", externalUserId: "a", credits: 0 },
    b = { ...a, id: "b" };
  let poller: EventPoller;
  poller = new EventPoller(
    () => {
      scans++;
      return [a];
    },
    async (user) => {
      counts.set(user.id, (counts.get(user.id) || 0) + 1);
      if (user.id === "a" && counts.get("a") === 1) poller.wake("a");
      return {
        received: 20,
        processed: 20,
        pending: 0,
        hasMore: user.id === "a",
      };
    },
    () => now,
    () => false,
    (id) => (id === "a" ? a : b),
  );
  try {
    await poller.tick();
    assert.equal(counts.get("a"), 3);
    assert.equal(scans, 1);
    poller.wake("b");
    await poller.tick();
    assert.equal(counts.get("b"), 1);
    assert.equal(counts.get("a"), 6);
    for (let i = 0; i < 10; i++) await poller.tick();
    assert.equal(scans, 1);
    assert.equal(counts.get("a"), 6);
    now = 1000;
    await poller.tick();
    assert.equal(counts.get("a"), 9);
    now = 30000;
    await poller.tick();
    assert.equal(scans, 2);
  } finally {
    await poller.stop();
  }
});

test("same-quote concurrent attempts cannot release another attempt's in-flight reservation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhino-same-hold-"));
  const path = join(dir, "test.sqlite");
  const a = new Store(path),
    b = new Store(path);
  try {
    a.addCredit("demo-a", 100, randomUUID());
    const q = quote(a);
    let accept!: () => void, refuse!: () => void;
    const first = a.sales.withReservation(
      a.user("demo-a"),
      q,
      () =>
        new Promise((_, reject) => {
          refuse = () =>
            reject(
              new AppError(409, "refused", undefined, "UPSTREAM_REJECTED"),
            );
        }),
    );
    const second = b.sales.withReservation(
      b.user("demo-a"),
      q,
      () =>
        new Promise((resolve) => {
          accept = () => resolve({ approvalId: q.quoteId });
        }),
    );
    const rejection = assert.rejects(first);
    refuse();
    await rejection;
    assert.equal(a.sales.held("demo-a"), 60);
    accept();
    await second;
    assert.equal(a.sales.held("demo-a"), 60);
    assert.equal(a.sales.reservations("demo-a").length, 1);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeouts, throttling and invalid rejection envelopes retain the reservation", async () => {
  for (const [status, envelope] of [
    [408, { code: 40800 }],
    [429, { code: 42900 }],
    [502, { code: 50200 }],
    [409, { code: 0 }],
    [409, { message: "refused without code" }],
    [409, { code: "40900" }],
    [200, { code: 40900 }],
  ] as const) {
    const store = new Store(":memory:");
    try {
      store.addCredit("demo-a", 100, randomUUID());
      const q = quote(store);
      const client = new MerchantClient(
        "https://fixture.invalid",
        "fixture-key",
        async (url) =>
          Response.json(
            String(url).endsWith("/approve") ? envelope : { code: 0, data: q },
            { status: String(url).endsWith("/approve") ? status : 200 },
          ),
      );
      await assert.rejects(() =>
        new Operations(client, store).approve(store.user("demo-a"), q),
      );
      assert.equal(
        store.sales.held("demo-a"),
        60,
        `HTTP ${status} ${JSON.stringify(envelope)}`,
      );
    } finally {
      store.close();
    }
  }
});

test("legacy approval stays reserved when the later submit is explicitly rejected", async () => {
  const store = new Store(":memory:");
  try {
    store.addCredit("demo-a", 100, randomUUID());
    const q = quote(store);
    const body = { clientRequestId: q.clientRequestId };
    store.db
      .prepare("INSERT INTO api_request_modes VALUES(?,?,'quote')")
      .run("demo-a", q.clientRequestId);
    store.startRequest("demo-a", q.clientRequestId, "design", body);
    store.sales.freeze(store.user("demo-a"), q);
    const client = new MerchantClient(
      "https://fixture.invalid",
      "fixture-key",
      async (url) =>
        String(url).endsWith("/approve")
          ? Response.json({ code: 0, data: { approvalId: q.quoteId } })
          : Response.json({ code: 40900 }, { status: 409 }),
    );
    await assert.rejects(() =>
      new Operations(client, store).call(store.user("demo-a"), "design", body),
    );
    assert.equal(store.sales.held("demo-a"), 60);
    assert.equal(
      store.db
        .prepare(
          "SELECT status FROM sale_reservation_attempts WHERE quote_id=?",
        )
        .get(q.quoteId)?.status,
      "ACCEPTED",
    );
  } finally {
    store.close();
  }
});

test("a late failed concurrent retry cannot erase a durable successful submission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhino-accepted-retry-"));
  const path = join(dir, "test.sqlite");
  const a = new Store(path),
    b = new Store(path);
  try {
    const id = randomUUID();
    const body = { clientRequestId: id };
    let rejectLate!: () => void;
    let calls = 0;
    const accepted = { submission: { submissionNo: "GS-preserved" } };
    const client = new MerchantClient(
      "https://fixture.invalid",
      "fixture-key",
      async () => {
        if (++calls === 1)
          return new Promise((_, reject) => {
            rejectLate = () => reject(Error("late timeout"));
          });
        return Response.json({ code: 0, data: accepted });
      },
      { version: "0.4.0", accessKey: `ak-${"a".repeat(32)}` },
    );
    const early = new Operations(client, a).call(
      a.user("demo-a"),
      "design",
      body,
    );
    const rejected = assert.rejects(early);
    await new Operations(client, b).call(b.user("demo-a"), "design", body);
    rejectLate();
    await rejected;
    assert.equal(a.requests("demo-a")[0].status, "ACCEPTED");
    assert.deepEqual(a.requests("demo-a")[0].response, accepted);
    assert.deepEqual(
      await new Operations(client, a).call(a.user("demo-a"), "design", body),
      accepted,
    );
    assert.equal(calls, 2);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
