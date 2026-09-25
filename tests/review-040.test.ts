import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveConfig } from "../server/config.ts";
import { checkConnection } from "../server/connection.ts";
import { AppError } from "../server/errors.ts";
import { EventPoller } from "../server/event-poller.ts";
import { MerchantClient } from "../server/merchant.ts";
import { type EventSyncReport, ResultService } from "../server/results.ts";
import { Store } from "../server/store.ts";
import type { MerchantEvent, User } from "../shared/types.ts";
import { statusPollingDecision } from "../src/status-polling.ts";

const key = `sk-${"s".repeat(43)}`,
  accessKey = `ak-${"a".repeat(32)}`;
const auth = { version: "0.4.0", accessKey } as const;
const ok = (data: unknown) => Response.json({ code: 0, data });
const noMedia = { save: async () => assert.fail("no media expected") };
function event(
  type: string,
  data: Record<string, unknown> = {},
): MerchantEvent {
  return {
    eventId: randomUUID(),
    eventVersion: "merchant-events/v1",
    eventType: type,
    externalUserId: "demo-user-a",
    occurredAt: new Date().toISOString(),
    data,
  };
}

test("invalid AK is shown locally and cannot enable config or send a connection probe", async () => {
  for (const bad of ["", "ak-***", `${accessKey} `, `ak-${"A".repeat(32)}`]) {
    const config = resolveConfig({
      env: { BLACK_RHINO_API_KEY: key, BLACK_RHINO_ACCESS_KEY: bad },
    });
    assert.equal(config.public.apiReady, false);
    assert.equal(config.public.callbacksReady, false);
    if (bad)
      assert(
        config.public.configurationIssues?.some((value) =>
          value.includes("ACCESS_KEY 格式错误"),
        ),
      );
    const api = new MerchantClient(
      "https://fixture.invalid",
      key,
      async () => assert.fail("no invalid credential request"),
      { ...auth, accessKey: bad },
    );
    const report = await checkConnection(api, "demo-user-a");
    assert.equal(report.checks.length, 1);
    assert.match(report.checks[0].message, /AK/);
    assert(!JSON.stringify(report).includes(key));
  }
});

test("business refusals retain safe details without falsely labelling version errors", async () => {
  for (const status of [200, 400, 409, 429]) {
    const api = new MerchantClient(
      "https://fixture.invalid",
      key,
      async () =>
        Response.json(
          {
            code: 40910,
            message: `报价已失效 ${key}`,
            messageKey: "quote.expired",
            traceId: "safe-trace",
          },
          { status },
        ),
      auth,
    );
    await assert.rejects(
      () => api.request("/open/design-jobs", "demo-user-a"),
      (error: unknown) => {
        assert(error instanceof AppError);
        assert.equal(error.status, status === 200 ? 400 : status);
        assert.doesNotMatch(error.message, /协议版本|AK 配置|凭据失效/);
        assert.match(JSON.stringify(error.details), /quote.expired/);
        assert(!JSON.stringify(error.details).includes(key));
        return true;
      },
    );
  }
});

test("unknown and malformed events stay durable while later valid costs are processed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rhino-inbox-review-"));
  let store = new Store(join(directory, "test.sqlite"));
  const unknown = event("future.new_event"),
    malformed = event("credits.debited", { delta: "invalid" });
  const cost = event("credits.debited", { delta: -20 });
  let queries = 0;
  const api = new MerchantClient(
    "https://fixture.invalid",
    key,
    async (url) => {
      queries++;
      return ok(
        new URL(String(url)).searchParams.has("cursor")
          ? { items: [], hasMore: false, nextCursor: cost.eventId }
          : {
              items: [unknown, malformed, null, cost],
              hasMore: false,
              nextCursor: cost.eventId,
            },
      );
    },
    auth,
  );
  try {
    let results = new ResultService(store, api, noMedia);
    const report = await results.syncEvents(store.user("demo-a"));
    assert.equal(report.pending, 3);
    assert.equal(report.processed, 1);
    assert.equal(store.apiEventCursor("demo-a"), cost.eventId);
    assert.equal(store.platformCosts("demo-a").length, 1);
    assert.equal(store.user("demo-a").credits, 0);
    assert.equal(store.processed(unknown.eventId, "demo-a"), false);
    store.close();
    store = new Store(join(directory, "test.sqlite"));
    results = new ResultService(store, api, noMedia);
    assert.match(results.syncIssue("demo-a") || "", /3 条/);
    const replay = await results.syncEvents(store.user("demo-a"));
    assert.equal(replay.pending, 3);
    assert.equal(replay.processed, 0); // retries are delayed, not hammered each tick
    assert.equal(queries, 2);
    assert.equal(store.platformCosts("demo-a").length, 1);
    assert.equal(results.syncIssue("demo-b"), undefined);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed inbox persistence and altered event identity roll back the entire received page", async () => {
  const store = new Store(":memory:");
  const cost = event("credits.debited", { delta: -20 });
  const api = new MerchantClient(
    "https://fixture.invalid",
    key,
    async () => ok({ items: [cost], nextCursor: cost.eventId, hasMore: false }),
    auth,
  );
  const results = new ResultService(store, api, noMedia);
  try {
    store.db.exec(
      "CREATE TRIGGER fail_inbox BEFORE INSERT ON api_event_inbox BEGIN SELECT RAISE(ABORT,'inbox failed'); END",
    );
    await assert.rejects(
      () => results.syncEvents(store.user("demo-a")),
      /inbox failed/,
    );
    assert.equal(store.apiEventCursor("demo-a"), undefined);
    assert.equal(store.platformCosts("demo-a").length, 0);
    store.db.exec("DROP TRIGGER fail_inbox");
    await results.syncEvents(store.user("demo-a"));
    const later = event("credits.refunded", { delta: 10 });
    assert.throws(
      () =>
        results.inbox.receive(
          store.user("demo-a"),
          [later, { ...cost, data: { delta: -30 } }],
          later.eventId,
        ),
      /内容变化/,
    );
    assert.equal(store.apiEventCursor("demo-a"), cost.eventId);
    assert.equal(results.inbox.pending("demo-a"), 0);
  } finally {
    store.close();
  }
});

test("persisted result retries survive restart and do not require a successful network fetch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rhino-inbox-replay-"));
  let store = new Store(join(directory, "test.sqlite"));
  const result = event("generation.finished", {
    requestChannel: "API",
    submissionNo: "GSreview",
    clientRequestId: randomUUID(),
    status: "SUCCEEDED",
    tasks: [
      {
        role: "OUTPUT",
        results: [{ type: "image", url: "https://fixture.invalid/image.png" }],
      },
    ],
  });
  let offline = false,
    diskFails = true;
  const api = new MerchantClient(
    "https://fixture.invalid",
    key,
    async () => {
      if (offline) throw new Error("network offline");
      return ok({
        items: [result],
        hasMore: false,
        nextCursor: result.eventId,
      });
    },
    auth,
  );
  const media = {
    save: async () => {
      if (diskFails) throw new Error("disk failed");
      return {
        id: "a".repeat(64),
        name: "saved.png",
        bytes: 1,
        contentType: "image/png",
      };
    },
  };
  try {
    let results = new ResultService(store, api, media);
    assert.equal((await results.syncEvents(store.user("demo-a"))).pending, 1);
    store.close();
    store = new Store(join(directory, "test.sqlite"));
    results = new ResultService(store, api, media);
    diskFails = false;
    offline = true;
    results.inbox.retry("demo-a");
    await assert.rejects(
      () => results.syncEvents(store.user("demo-a")),
      /无响应/,
    );
    assert.equal(store.results("demo-a").length, 1);
    assert.equal(results.inbox.pending("demo-a"), 0);
    await results.generation(result);
    assert.equal(store.results("demo-a").length, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const user = (id: string): User => ({
  id,
  name: id,
  externalUserId: id,
  credits: 0,
});
const idle: EventSyncReport = {
  received: 0,
  processed: 0,
  pending: 0,
  hasMore: false,
};

test("background polling backs off idle and failing users and wakes on a new request", async () => {
  let now = 0,
    count = 0,
    fails = false;
  const poller = new EventPoller(
    () => [user("a")],
    async () => {
      count++;
      if (fails) throw new Error("offline");
      return idle;
    },
    () => now,
  );
  await poller.tick();
  assert.equal(count, 1);
  now = 5000;
  await poller.tick();
  assert.equal(count, 1);
  now = 30_000;
  await poller.tick();
  assert.equal(count, 2);
  now = 60_000;
  await poller.tick();
  assert.equal(count, 2);
  poller.wake("a");
  await poller.tick();
  assert.equal(count, 3);
  fails = true;
  poller.wake("a");
  await poller.tick();
  assert.equal(count, 4);
  now += 5000;
  await poller.tick();
  assert.equal(count, 4);
  now += 5000;
  await poller.tick();
  assert.equal(count, 5);
  await poller.stop();
  now += 300_000;
  await poller.tick();
  assert.equal(count, 5);
});

test("one slow user does not block others, concurrency is bounded and shutdown drains work", async () => {
  let release!: (value: EventSyncReport) => void;
  const blocked = new Promise<EventSyncReport>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const poller = new EventPoller(
    () => [user("a"), user("b"), user("c")],
    async (user) => {
      calls.push(user.id);
      return user.id === "a" ? blocked : idle;
    },
    () => 0,
  );
  const first = poller.tick();
  // Let the fast slot settle, while A remains in flight.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["a", "b"]);
  await poller.tick();
  assert.deepEqual(calls, ["a", "b", "c"]);
  let stopped = false;
  const stop = poller.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release(idle);
  await first;
  await stop;
  assert.equal(stopped, true);
});

test("browser polling stops at terminal state even if saving fails, and bounds errors and elapsed time", () => {
  const pending = { terminal: false, saved: false, elapsedMs: 0, failures: 0 };
  assert.equal(statusPollingDecision(pending), "continue");
  assert.equal(
    statusPollingDecision({ ...pending, terminal: true }),
    "complete",
  );
  assert.equal(statusPollingDecision({ ...pending, saved: true }), "complete");
  assert.equal(
    statusPollingDecision({ ...pending, elapsedMs: 600_000 }),
    "paused",
  );
  assert.equal(statusPollingDecision({ ...pending, failures: 3 }), "paused");
});
