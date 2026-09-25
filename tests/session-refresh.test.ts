import assert from "node:assert/strict";
import test from "node:test";
import { SessionRefresh } from "../src/session-refresh.ts";

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

test("session reads only happen on request, including after success or failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0;
  const refresh = new SessionRefresh(async () => {
    calls++;
    if (calls === 2) throw new Error("offline");
  });
  t.after(() => refresh.stop());
  t.mock.timers.tick(3_600_000);
  await flush();
  assert.equal(calls, 0);
  await refresh.refresh();
  t.mock.timers.tick(3_600_000);
  await flush();
  assert.equal(calls, 1);
  await assert.rejects(refresh.refresh(), /offline/);
  t.mock.timers.tick(3_600_000);
  await flush();
  assert.equal(calls, 2);
  await refresh.refresh();
  assert.equal(calls, 3);
});

test("actions during a slow read coalesce into one fresh read without overlap", async () => {
  let release!: () => void;
  let calls = 0;
  const refresh = new SessionRefresh(() => {
    calls++;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const first = refresh.refresh();
  await flush();
  assert.equal(refresh.refresh(), first);
  assert.equal(refresh.refresh(), first);
  assert.equal(calls, 1);
  release();
  await flush();
  assert.equal(calls, 2);
  release();
  await first;
  refresh.stop();
});

test("a failed old read does not discard a refresh requested after an action", async () => {
  let reject!: (error: Error) => void;
  let calls = 0;
  const refresh = new SessionRefresh(() => {
    calls++;
    return calls === 1
      ? new Promise<void>((_, fail) => {
          reject = fail;
        })
      : Promise.resolve();
  });
  const pending = refresh.refresh();
  await flush();
  refresh.refresh();
  reject(new Error("old user request failed"));
  await pending;
  assert.equal(calls, 2);
  refresh.stop();
});

test("unmount prevents queued or future reads, including during an in-flight read", async () => {
  const early = new SessionRefresh(async () => assert.fail("unmounted"));
  const queued = early.refresh();
  early.stop();
  await queued;
  await early.refresh();

  let release!: () => void;
  let calls = 0;
  const refresh = new SessionRefresh(() => {
    calls++;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const pending = refresh.refresh();
  await flush();
  refresh.refresh();
  refresh.stop();
  release();
  await pending;
  await refresh.refresh();
  assert.equal(calls, 1);
});
