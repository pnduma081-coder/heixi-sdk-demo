import assert from "node:assert/strict";
import test from "node:test";
import { delayedFeedback } from "../src/delayed-feedback.ts";
import { SdkWorkspace, type WorkspaceState } from "../src/sdk-workspace.ts";

test("quick navigation never flashes loading; long waits display feedback and disposal cancels it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shown: boolean[] = [];
  const feedback = delayedFeedback((value) => shown.push(value));
  feedback.set(true);
  t.mock.timers.tick(250);
  feedback.set(false);
  t.mock.timers.tick(1000);
  assert.deepEqual(shown, [false]);
  feedback.set(true);
  t.mock.timers.tick(599);
  assert.deepEqual(shown, [false]);
  t.mock.timers.tick(1);
  assert.deepEqual(shown, [false, true]);
  feedback.set(true); // 持续导航不重复重启提示计时。
  feedback.set(false);
  assert.equal(shown.at(-1), false);
  feedback.set(true);
  feedback.dispose();
  t.mock.timers.tick(1000);
  assert.deepEqual(shown, [false, true, false]);
});

test("feedback delay does not delay SDK readiness or completed navigation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const visible: boolean[] = [],
    states: WorkspaceState[] = [];
  const feedback = delayedFeedback((value) => visible.push(value));
  let navDelay = 0;
  const workspace = new SdkWorkspace(
    async () => ({
      ready: Promise.resolve(),
      navigate: async () => {
        if (navDelay)
          await new Promise<void>((resolve) => setTimeout(resolve, navDelay));
      },
      update: async () => {},
      getState: () => null,
      refreshSession: async () => {},
      destroy: () => {},
    }),
    (state) => {
      states.push(state);
      feedback.set(state.status === "navigating");
    },
  );
  try {
    await workspace.show({ page: "main_image" });
    await workspace.show({ page: "detail_page" });
    assert.equal(states.at(-1)?.status, "ready"); // 不推进时钟也完成快导航。
    assert(!visible.includes(true));
    navDelay = 100;
    const pending = workspace.show({ page: "aigc" });
    await Promise.resolve(); // 让队列进入模拟 SDK navigate。
    t.mock.timers.tick(99);
    assert.equal(states.at(-1)?.status, "navigating");
    t.mock.timers.tick(1);
    await pending;
    assert.equal(states.at(-1)?.status, "ready"); // SDK 100ms 完成后立即ready，不等600ms。
    t.mock.timers.tick(1000);
    assert(!visible.includes(true));
  } finally {
    feedback.dispose();
    workspace.dispose();
  }
});
