import assert from "node:assert/strict";
import test from "node:test";
import { ResultWatcher } from "../src/result-watcher.ts";

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
const saved = {
  id: "saved",
  userId: "a",
  source: "API",
  reference: "event",
  submissionNo: "GS-one",
  status: "SUCCEEDED",
  payload: {},
  files: [],
  receiptId: "receipt",
  createdAt: "2026-09-27T00:00:00Z",
};

test("terminal result watcher reads only local task, stops on save and coalesces repeated start", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const document = { hidden: false };
  Object.defineProperty(globalThis, "document", {
    value: document,
    configurable: true,
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  });
  let calls = 0,
    refreshes = 0,
    state = "idle";
  t.mock.method(
    globalThis,
    "fetch",
    async (input: unknown, init: RequestInit) => {
      assert.equal(String(input), "/api/results/status?submissionNo=GS-one");
      assert.equal(new Headers(init.headers).get("x-demo-user"), "a");
      calls++;
      return {
        ok: true,
        json: async () => ({ result: calls < 19 ? null : saved }),
      } as Response;
    },
  );
  const watcher = new ResultWatcher({
    userId: "a",
    saved: (result) => {
      assert.equal(result.id, "saved");
      refreshes++;
    },
    state: (v) => {
      state = v;
    },
    error: (e) => assert.fail(String(e)),
  });
  t.after(() => watcher.dispose());
  watcher.start("GS-one");
  await flush();
  watcher.start("GS-one");
  assert.equal(calls, 1);
  for (let i = 0; i < 18; i++) {
    t.mock.timers.tick(5000);
    await flush();
  }
  assert.equal(calls, 19);
  assert.equal(refreshes, 1);
  assert.equal(state, "complete");
  watcher.start("GS-one");
  t.mock.timers.tick(600000);
  await flush();
  assert.equal(calls, 19);
});

test("result watcher pauses after bounded reads, after hidden deadline, and ignores late previous results", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const document = { hidden: false };
  Object.defineProperty(globalThis, "document", {
    value: document,
    configurable: true,
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  });
  let calls = 0,
    state = "idle",
    block = false;
  let release!: () => void;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (block)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return {
      ok: true,
      json: async () => ({ result: block ? saved : null }),
    } as Response;
  });
  const watcher = new ResultWatcher({
    userId: "a",
    saved: () => assert.fail("old result applied"),
    state: (v) => {
      state = v;
    },
    error: (e) => assert.fail(String(e)),
  });
  t.after(() => watcher.dispose());
  watcher.start("GS-one");
  await flush();
  for (let i = 0; i < 120; i++) {
    t.mock.timers.tick(5000);
    await flush();
  }
  assert.equal(calls, 120);
  assert.equal(state, "paused");
  watcher.start("GS-one");
  await flush();
  assert.equal(calls, 120);
  watcher.stop();
  document.hidden = true;
  watcher.start("GS-two");
  t.mock.timers.tick(600001);
  document.hidden = false;
  watcher.visibilityChanged();
  await flush();
  assert.equal(calls, 120);
  assert.equal(state, "paused");
  watcher.stop();
  block = true;
  watcher.start("GS-old");
  await flush();
  watcher.stop();
  release();
  await flush();
  assert.equal(state, "idle");
});
