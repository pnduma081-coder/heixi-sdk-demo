import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resultSaveError } from "../server/errors.ts";
import { EventPoller } from "../server/event-poller.ts";
import { MerchantClient } from "../server/merchant.ts";
import { ResultService } from "../server/results.ts";
import { Store } from "../server/store.ts";

function event(no: string) {
  return {
    eventId: randomUUID(),
    eventVersion: "merchant-events/v1",
    eventType: "generation.finished",
    externalUserId: "demo-user-a",
    occurredAt: new Date().toISOString(),
    data: {
      requestChannel: "API",
      clientRequestId: no,
      submissionNo: no,
      status: "SUCCEEDED",
      tasks: [
        {
          role: "OUTPUT",
          results: [
            { type: "VIDEO", url: "https://fixture.invalid/result.mp4" },
          ],
        },
      ],
    },
  };
}
const file = {
  id: "a".repeat(64),
  name: "result.mp4",
  bytes: 1,
  contentType: "video/mp4",
};

test("idle five-minute backoff wakes for the persisted retry before expiry and before a slow event fetch", async (t) => {
  const base = 1_800_000_000_000,
    deadline = base + 24 * 3600000,
    retryAt = deadline - 2000;
  t.mock.timers.enable({ apis: ["Date"], now: base });
  const store = new Store(":memory:"),
    user = store.user("demo-a");
  const trace: Array<{ kind: string; at: number }> = [];
  const api = new MerchantClient(
    "https://fixture.invalid",
    "fixture",
    async () => {
      trace.push({ kind: "fetch", at: Date.now() });
      if (Date.now() >= retryAt) t.mock.timers.setTime(Date.now() + 10000);
      return Response.json({ code: 0, data: { items: [], hasMore: false } });
    },
  );
  const results = new ResultService(store, api, {
    save: async () => {
      trace.push({ kind: "save", at: Date.now() });
      return file;
    },
  });
  const item = event("GS-last-slot");
  results.inbox.receive(user, [item], item.eventId);
  store.db
    .prepare(
      "UPDATE api_event_inbox SET status='RETRY_LATER',attempts=8,next_attempt=? WHERE event_key=?",
    )
    .run(retryAt, item.eventId);
  const poller = new EventPoller(
    () => [user],
    (u) => results.syncEvents(u),
    Date.now,
    () => false,
    (id) => store.user(id),
    (id, now) => results.inbox.nextRetryAt(id, now),
  );
  try {
    for (let now = deadline - 600000; now <= retryAt; now += 1000) {
      t.mock.timers.setTime(now);
      await poller.tick();
    }
    assert.deepEqual(
      trace.filter((x) => x.kind === "save"),
      [{ kind: "save", at: retryAt }],
    );
    assert.deepEqual(
      trace.slice(-2).map((x) => x.kind),
      ["save", "fetch"],
    );
    assert(
      trace.filter((x) => x.kind === "fetch").length < 10,
      "do not replace idle backoff with constant polling",
    );
    assert.equal(store.results(user.id).length, 1);
    assert.equal(results.inbox.nextRetryAt(user.id, Date.now()), undefined);
    assert.equal(results.inbox.paused(user.id), 0);
  } finally {
    await poller.stop();
    store.close();
  }
});

test("a slow earlier save cannot start another queued attempt after its hard deadline", async (t) => {
  const base = 1_800_000_000_000,
    deadline = base + 24 * 3600000;
  t.mock.timers.enable({ apis: ["Date"], now: base });
  const store = new Store(":memory:"),
    user = store.user("demo-a");
  let saves = 0;
  const api = new MerchantClient(
    "https://fixture.invalid",
    "fixture",
    async () => Response.json({ code: 0, data: { items: [], hasMore: false } }),
  );
  const results = new ResultService(store, api, {
    save: async () => {
      saves++;
      t.mock.timers.setTime(deadline + 1000);
      return file;
    },
  });
  try {
    const first = event("GS-first"),
      second = event("GS-second");
    results.inbox.receive(user, [first, second], second.eventId);
    store.db
      .prepare(
        "UPDATE api_event_inbox SET status='RETRY_LATER',attempts=8,next_attempt=?",
      )
      .run(deadline - 1000);
    t.mock.timers.setTime(deadline - 1000);
    const report = await results.syncEvents(user);
    assert.equal(report.processed, 1);
    assert.equal(saves, 1);
    assert.equal(results.inbox.paused(user.id), 1);
    assert.equal(store.results(user.id)[0].submissionNo, "GS-first");
    assert.equal(results.inbox.nextRetryAt(user.id, Date.now()), undefined);
  } finally {
    store.close();
  }
});

test("failed event fetch still schedules local retry ahead of network error backoff", async () => {
  const user = { id: "a", name: "a", externalUserId: "a", credits: 0 };
  let now = 0,
    calls = 0;
  const poller = new EventPoller(
    () => [user],
    async () => {
      calls++;
      throw new Error("offline");
    },
    () => now,
    () => false,
    undefined,
    () => (calls === 1 ? 2000 : undefined),
  );
  try {
    await poller.tick();
    now = 1000;
    await poller.tick();
    assert.equal(calls, 1);
    now = 2000;
    await poller.tick();
    assert.equal(calls, 2);
    now = 3000;
    await poller.tick();
    assert.equal(calls, 2);
  } finally {
    await poller.stop();
  }
});

test("processing before and after fetch shares one twenty-event budget and keeps settlement deduplication", async () => {
  const store = new Store(":memory:"),
    user = store.user("demo-a");
  const cost = () => ({
    ...event("GS-budget"),
    eventType: "credits.debited",
    data: { delta: -1 },
  });
  const old = Array.from({ length: 20 }, cost),
    arrivals = Array.from({ length: 20 }, cost);
  let fetches = 0;
  const api = new MerchantClient(
    "https://fixture.invalid",
    "fixture",
    async () =>
      Response.json({
        code: 0,
        data: {
          items: fetches++ === 0 ? arrivals : [],
          hasMore: false,
          nextCursor: arrivals.at(-1)?.eventId,
        },
      }),
  );
  const results = new ResultService(store, api, {
    save: async () => assert.fail("no media"),
  });
  try {
    results.inbox.receive(user, old, old[19].eventId);
    store.db
      .prepare("UPDATE api_event_inbox SET attempts=1 WHERE user_id=?")
      .run(user.id);
    const first = await results.syncEvents(user);
    assert.equal(first.processed, 20);
    assert.equal(first.pending, 20);
    assert.equal(store.platformCosts(user.id).length, 20);
    assert.equal(store.processed(old[9].eventId, user.id), true);
    assert.equal(
      store.processed(old[10].eventId, user.id),
      false,
      "retry limit is still ten",
    );
    assert.equal(
      store.processed(arrivals[9].eventId, user.id),
      true,
      "fresh events keep reserved capacity",
    );
    assert.equal((await results.syncEvents(user)).processed, 20);
    assert.equal(store.platformCosts(user.id).length, 40);
    results.inbox.receive(user, [...old, ...arrivals], arrivals[19].eventId);
    assert.equal((await results.syncEvents(user)).processed, 0);
    assert.equal(store.platformCosts(user.id).length, 40);
  } finally {
    store.close();
  }
});

test("repeated ninety-second media retries cannot starve fresh cost and sale events", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const store = new Store(":memory:"),
    user = store.user("demo-a");
  let saves = 0,
    page: unknown[] = [],
    cursor = "";
  const api = new MerchantClient(
    "https://fixture.invalid",
    "fixture",
    async () =>
      Response.json({
        code: 0,
        data: { items: page, hasMore: false, nextCursor: cursor },
      }),
  );
  const results = new ResultService(store, api, {
    save: async () => {
      saves++;
      t.mock.timers.setTime(Date.now() + 90000);
      throw resultSaveError(504, "persistent CDN timeout");
    },
  });
  try {
    const retries = Array.from({ length: 5 }, (_, i) => event(`GS-retry-${i}`));
    results.inbox.receive(user, retries, retries[4].eventId);
    store.db
      .prepare("UPDATE api_event_inbox SET attempts=1 WHERE user_id=?")
      .run(user.id);
    for (let round = 0; round < 4; round++) {
      const quote = {
        quoteId: randomUUID(),
        clientRequestId: randomUUID(),
        externalUserId: user.externalUserId,
        estimatedCredits: 1,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        saleItems: [{ itemId: randomUUID(), credits: 1 }],
      };
      store.sales.approvalPolicy(user.id, quote.clientRequestId);
      store.sales.freezeAudit(user, quote);
      const cost = {
        ...event("GS-cost"),
        eventType: "credits.debited",
        data: { delta: -1 },
      };
      const itemId = quote.saleItems[0].itemId;
      const sale = {
        ...event("GS-sale"),
        eventType: "credits.sale_debited",
        data: {
          quoteId: quote.quoteId,
          clientRequestId: quote.clientRequestId,
          itemId,
          amount: 1,
          taskNo: `AI-sale-${round}`,
          settlementId: `sale:${itemId}:debit`,
        },
      };
      page = [cost, sale];
      cursor = sale.eventId;
      const report = await results.syncEvents(user);
      assert.equal(saves, round + 1);
      assert.equal(report.processed, 2);
      assert.equal(store.platformCosts(user.id).length, round + 1);
      assert.equal(store.sales.records(user.id).length, round + 1);
      assert(
        store.sales
          .records(user.id)
          .every((record) => record.status === "RECORDED"),
      );
      assert.equal(results.inbox.paused(user.id), 0);
      assert.equal(store.apiEventCursor(user.id), cursor);
    }
    assert.equal(store.user(user.id).credits, 0);
    assert.deepEqual(store.ledger(user.id), []);
    assert.deepEqual(store.platformCosts("demo-b"), []);
  } finally {
    store.close();
  }
});

test("slow retries and slow fresh events each progress once per round, including after fetch failure", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const store = new Store(":memory:"),
    user = store.user("demo-a");
  const retry = event("GS-retry"),
    fresh = [event("GS-fresh-1"), event("GS-fresh-2")];
  const starts: string[] = [];
  const api = new MerchantClient(
    "https://fixture.invalid",
    "fixture",
    async () => {
      throw new Error("network down");
    },
  );
  const results = new ResultService(store, api, {
    save: async (_url, scope) => {
      const key = scope.split(":")[2];
      starts.push(key);
      t.mock.timers.setTime(Date.now() + 90000);
      throw resultSaveError(504, "CDN timeout");
    },
  });
  try {
    results.inbox.receive(user, [retry, ...fresh], fresh[1].eventId);
    store.db
      .prepare("UPDATE api_event_inbox SET attempts=1 WHERE event_key=?")
      .run(retry.eventId);
    await assert.rejects(results.syncEvents(user), /无响应/);
    assert.deepEqual(starts, [retry.eventId, fresh[0].eventId]);
    await assert.rejects(results.syncEvents(user), /无响应/);
    assert.deepEqual(starts, [
      retry.eventId,
      fresh[0].eventId,
      retry.eventId,
      fresh[1].eventId,
    ]);
    assert.equal(results.inbox.paused(user.id), 0);
    assert.equal(
      results.inbox
        .diagnostics(user.id)
        .find((row) => row.eventKey === fresh[0].eventId)?.attempts,
      1,
    );
  } finally {
    store.close();
  }
});

test("fresh processing has its own ten-second slice and untouched items remain pending", async (t) => {
  const base = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now: base });
  const store = new Store(":memory:"),
    user = store.user("demo-a");
  const old = Array.from({ length: 5 }, (_, i) => event(`GS-budget-${i}`));
  const arrival = {
    ...event("GS-new-cost"),
    eventType: "credits.debited",
    data: { delta: -1 },
  };
  let saves = 0,
    fetchedAt = 0;
  const api = new MerchantClient(
    "https://fixture.invalid",
    "fixture",
    async () => {
      fetchedAt = Date.now();
      return Response.json({
        code: 0,
        data: { items: [arrival], hasMore: false, nextCursor: arrival.eventId },
      });
    },
  );
  const results = new ResultService(store, api, {
    save: async () => {
      saves++;
      t.mock.timers.setTime(Date.now() + 10000);
      return file;
    },
  });
  try {
    results.inbox.receive(user, old, old[4].eventId);
    const report = await results.syncEvents(user);
    assert.equal(saves, 1);
    assert.equal(fetchedAt, base);
    assert.equal(report.processed, 1);
    assert.equal(report.received, 1);
    assert.equal(report.pending, 5);
    assert.equal(
      store.platformCosts(user.id).length,
      0,
      "a slow fresh item must not bypass its own time budget",
    );
    assert.equal(
      store.apiEventCursor(user.id),
      arrival.eventId,
      "new events still persist after processing yields",
    );
    const remaining = results.inbox.due(user.id, Date.now());
    assert.equal(remaining.length, 5);
    assert(
      remaining.every((item) => item.attempts === 0),
      "not starting an item is not a processing failure",
    );
    assert.equal(results.inbox.paused(user.id), 0);
  } finally {
    store.close();
  }
});

test("two slow users yield after their in-flight saves so a third user's sync can run", async (t) => {
  const base = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now: base });
  const store = new Store(":memory:");
  store.db.exec("INSERT INTO users VALUES('demo-z','Z','demo-user-z',0)");
  const users = store.users(),
    started: string[] = [],
    calls: string[] = [],
    fetched: string[] = [];
  const releases: Array<() => void> = [];
  const api = new MerchantClient(
    "https://fixture.invalid",
    "fixture",
    async (url) => {
      fetched.push(
        new URL(String(url)).searchParams.get("externalUserId") || "",
      );
      return Response.json({ code: 0, data: { items: [], hasMore: false } });
    },
  );
  const results = new ResultService(store, api, {
    save: async (_url, scope) => {
      const id = scope.split(":")[0];
      started.push(id);
      if (started.length <= 2) {
        await new Promise<void>((resolve) => releases.push(resolve));
        throw resultSaveError(504, "fixture slow timeout");
      }
      return file;
    },
  });
  for (const user of users.slice(0, 2)) {
    const items = Array.from({ length: 10 }, (_, i) => ({
      ...event(`GS-${user.id}-${i}`),
      externalUserId: user.externalUserId,
    }));
    results.inbox.receive(user, items, items[9].eventId);
    store.db
      .prepare("UPDATE api_event_inbox SET attempts=1 WHERE user_id=?")
      .run(user.id);
  }
  const poller = new EventPoller(
    () => users,
    (u) => {
      calls.push(u.id);
      return results.syncEvents(u);
    },
    Date.now,
    () => false,
    (id) => store.user(id),
    (id, now) => results.inbox.nextRetryAt(id, now),
  );
  try {
    const first = poller.tick();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.deepEqual(started, ["demo-a", "demo-b"]);
    t.mock.timers.setTime(base + 90000);
    for (const release of releases) release();
    await first;
    assert.equal(
      started.length,
      2,
      "do not start all ten slow retries in one batch",
    );
    assert.deepEqual(fetched, ["demo-user-a", "demo-user-b"]);
    assert.equal(results.inbox.due("demo-a", Date.now()).length, 9);
    assert.equal(results.inbox.due("demo-b", Date.now()).length, 9);
    await poller.tick();
    assert.equal(calls[2], "demo-z");
    assert(fetched.includes("demo-user-z"));
  } finally {
    for (const release of releases) release();
    await poller.stop();
    store.close();
  }
});
