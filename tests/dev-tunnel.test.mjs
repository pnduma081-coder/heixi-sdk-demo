import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runTogether } from "../scripts/dev-tunnel.mjs";

function fixture() {
  const signals = new EventEmitter();
  const children = [];
  const stopped = [];
  const options = {
    signals,
    spawnProcess() {
      const child = new EventEmitter();
      children.push(child);
      return child;
    },
    stopProcess(child, signal) {
      stopped.push({ child, signal });
      queueMicrotask(() => child.emit("close", null));
    },
  };
  return { signals, children, stopped, options };
}

test("Ctrl+C stops both owned processes and removes signal handlers", async () => {
  const f = fixture();
  const done = runTogether([["fake-service"], ["fake-tunnel"]], f.options);
  f.signals.emit("SIGINT");
  assert.equal(await done, 130);
  assert.deepEqual(
    f.stopped,
    f.children.map((child) => ({ child, signal: "SIGTERM" })),
  );
  assert.equal(f.signals.listenerCount("SIGINT"), 0);
  assert.equal(f.signals.listenerCount("SIGTERM"), 0);
});

test("a failed tunnel stops its companion and preserves the failure code", async () => {
  const f = fixture();
  const done = runTogether([["fake-service"], ["fake-tunnel"]], f.options);
  f.children[1].emit("close", 7);
  assert.equal(await done, 7);
  assert.deepEqual(f.stopped, [{ child: f.children[0], signal: "SIGTERM" }]);
});

test("a clean service exit also stops its companion", async () => {
  const f = fixture();
  const done = runTogether([["fake-service"], ["fake-tunnel"]], f.options);
  f.children[0].emit("close", 0);
  assert.equal(await done, 0);
  assert.deepEqual(f.stopped, [{ child: f.children[1], signal: "SIGTERM" }]);
});
