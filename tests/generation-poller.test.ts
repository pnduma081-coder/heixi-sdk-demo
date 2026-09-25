import assert from "node:assert/strict";
import test from "node:test";
import {
  GenerationPoller,
  type PollingState,
} from "../src/generation-poller.ts";

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

test("a task polls only while active, coalesces manual reads and stops at terminal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  let release!: (terminal: boolean) => void;
  let state: PollingState = "idle";
  const poller = new GenerationPoller<boolean>({
    read: async () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    apply: (terminal) => terminal,
    error: (cause) => assert.fail(String(cause)),
    state: (value) => {
      state = value;
    },
    hidden: () => false,
  });
  t.after(() => poller.dispose());
  poller.start("GS-one");
  await flush();
  const manual = poller.refresh("GS-one");
  assert.equal(calls, 1);
  release(false);
  await manual;
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(calls, 2);
  release(true);
  await flush();
  assert.equal(state, "complete");
  t.mock.timers.tick(600_000);
  await flush();
  assert.equal(calls, 2);
});

test("hidden pages pause; returning respects the original total timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let hidden = true,
    calls = 0;
  let state: PollingState = "idle";
  const poller = new GenerationPoller({
    read: async () => {
      calls++;
      return false;
    },
    apply: (v) => v,
    error: (cause) => assert.fail(String(cause)),
    state: (v) => {
      state = v;
    },
    hidden: () => hidden,
  });
  t.after(() => poller.dispose());
  poller.start("GS-one");
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(calls, 0);
  hidden = false;
  poller.visibilityChanged();
  await flush();
  assert.equal(calls, 1);
  hidden = true;
  poller.visibilityChanged();
  t.mock.timers.tick(600_000);
  hidden = false;
  poller.visibilityChanged();
  await flush();
  assert.equal(state, "paused");
  assert.equal(calls, 1);
  await poller.refresh("GS-one");
  assert.equal(calls, 2);
});

test("three consecutive failures pause; explicit restart resets the failure budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0,
    errors = 0;
  let state: PollingState = "idle";
  const poller = new GenerationPoller({
    read: async () => {
      calls++;
      throw new Error("offline");
    },
    apply: () => false,
    error: () => {
      errors++;
    },
    state: (v) => {
      state = v;
    },
    hidden: () => false,
  });
  t.after(() => poller.dispose());
  poller.start("GS-one");
  await flush();
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(3000);
    await flush();
  }
  assert.equal(state, "paused");
  assert.equal(errors, 3);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(calls, 3);
  poller.start("GS-one");
  await flush();
  assert.equal(state, "running");
  assert.equal(calls, 4);
});

test("switching tasks aborts the old request and ignores even a late successful response", async () => {
  const calls: string[] = [],
    applied: string[] = [],
    signals: AbortSignal[] = [];
  let release!: (v: boolean) => void;
  const poller = new GenerationPoller<boolean>({
    read: (no, signal) => {
      calls.push(no);
      signals.push(signal);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    apply: (_, no) => {
      applied.push(no);
      return true;
    },
    error: (cause) => assert.fail(String(cause)),
    state: () => {},
    hidden: () => false,
  });
  poller.start("GS-old");
  await flush();
  poller.start("GS-new");
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(calls, ["GS-old"]);
  release(true);
  await flush();
  assert.deepEqual(applied, []);
  assert.deepEqual(calls, ["GS-old", "GS-new"]);
  release(true);
  await flush();
  assert.deepEqual(applied, ["GS-new"]);
  poller.dispose();
  poller.start("GS-after-dispose");
  await poller.refresh("GS-after-dispose");
  assert.equal(calls.length, 2);
});
