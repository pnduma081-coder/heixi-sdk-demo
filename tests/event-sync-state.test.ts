import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventPoller } from "../server/event-poller.ts";
import { EventSyncState } from "../server/event-sync-state.ts";
import { Store } from "../server/store.ts";

test("unused users are excluded while requests, SDK use and recovery persist across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "rhino-sync-state-"));
  let store = new Store(join(dir, "test.sqlite"));
  try {
    let state = new EventSyncState(store);
    assert.deepEqual(state.users(), []);
    store.startRequest("demo-a", "req-one", "design", {});
    assert.deepEqual(
      state.users().map((u) => u.id),
      ["demo-a"],
    );
    assert(state.active("demo-a"));
    state.watch("demo-b");
    assert.equal(state.active("demo-b"), false);
    store.close();
    store = new Store(join(dir, "test.sqlite"));
    state = new EventSyncState(store);
    assert.deepEqual(
      state.users().map((u) => u.id),
      ["demo-a", "demo-b"],
    );
    assert(state.active("demo-a"));
    state.complete("demo-a", "req-one");
    assert.equal(state.active("demo-a"), false);
    assert.equal(state.users().length, 2); // 保留低频退款/迟到事件补偿。
    store.startRequest("demo-a", "req-two", "design", {});
    assert(state.active("demo-a"));
    assert.equal(state.active("demo-a", Date.now() + 25 * 3600_000), false);
    assert.equal(state.users().length, 2); // 超时不丢弃、不重提原请求。
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saved historical results do not count as active work", () => {
  const store = new Store(":memory:");
  try {
    store.startRequest("demo-a", "req-one", "design", {});
    store.saveResult(
      store.user("demo-a"),
      "API",
      "event-one",
      {
        clientRequestId: "req-one",
        submissionNo: "GS-one",
        status: "SUCCEEDED",
      },
      [],
    );
    const state = new EventSyncState(store);
    assert.equal(state.active("demo-a"), false);
    assert.equal(state.users().length, 1);
  } finally {
    store.close();
  }
});

test("a long-running task keeps short polling even when no new events arrive", async () => {
  const store = new Store(":memory:");
  const state = new EventSyncState(store);
  let now = Date.now(),
    calls = 0;
  const poller = new EventPoller(
    () => state.users(),
    async () => {
      calls++;
      return { received: 0, processed: 0, pending: 0, hasMore: false };
    },
    () => now,
    (user) => state.active(user, now),
  );
  try {
    await poller.tick();
    assert.equal(calls, 0);
    store.startRequest("demo-a", "req-one", "video", {});
    store.finishRequest(
      "demo-a",
      "req-one",
      { submissionNo: "GS-one" },
      "ACCEPTED",
    );
    for (let i = 0; i < 80; i++) {
      await poller.tick();
      now += 5000;
    }
    assert.equal(calls, 80);
    state.complete("demo-a", "req-one");
    await poller.tick();
    now += 5000;
    await poller.tick();
    assert.equal(calls, 81);
    now += 25_000;
    await poller.tick();
    assert.equal(calls, 82);
  } finally {
    await poller.stop();
    store.close();
  }
});
