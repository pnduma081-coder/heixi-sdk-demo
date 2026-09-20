import assert from "node:assert/strict";
import test from "node:test";
import { menu, tools } from "../src/navigation.ts";
import type { SdkInstance } from "../src/sdk.ts";
import {
  SdkWorkspace,
  sdkFailureMessage,
  type WorkspaceState,
} from "../src/sdk-workspace.ts";

function client(navigate: SdkInstance["navigate"] = async () => {}) {
  let destroyed = 0;
  const updates: unknown[] = [];
  const instance: SdkInstance = {
    ready: Promise.resolve({ capabilities: tools.map((tool) => tool.page) }),
    navigate,
    update: async (value) => {
      updates.push(value);
    },
    getState: () => null,
    refreshSession: async () => {},
    destroy: () => {
      destroyed++;
    },
  };
  return { instance, updates, destroyed: () => destroyed };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("menu has distinct deep links for all SDK tools and valid category entries", () => {
  assert.equal(tools.length, 20);
  assert.equal(new Set(tools.map((tool) => tool.path)).size, 20);
  assert.equal(tools.filter((tool) => tool.group === "apparel").length, 10);
  assert.equal(tools.filter((tool) => tool.group === "video").length, 5);
  assert(
    menu.every((item) =>
      tools.some(
        (tool) => tool.path === item.path && tool.group === item.group,
      ),
    ),
  );
});
test("automatic opening, menu navigation and recharge reuse one instance", async () => {
  let opens = 0;
  const navigation: unknown[] = [];
  const states: WorkspaceState[] = [];
  const sdk = client(async (target) => {
    navigation.push(target);
  });
  const workspace = new SdkWorkspace(
    async () => {
      opens++;
      return sdk.instance;
    },
    (state) => states.push(state),
  );
  await workspace.show({ page: "main_image" });
  await workspace.show({ page: "detail_page" });
  await workspace.update({ credits: 1200 });
  await workspace.show({ page: "detail_page" });
  assert.equal(opens, 1);
  assert.deepEqual(navigation, [{ page: "detail_page" }]);
  assert.deepEqual(sdk.updates, [{ credits: 1200 }]);
  assert.deepEqual(
    states.map((state) => state.status),
    ["loading", "ready", "navigating", "ready"],
  );
  workspace.dispose();
  assert.equal(sdk.destroyed(), 1);
});
test("rapid navigation back to the previous page ends on the latest selected page", async () => {
  const pending = deferred<void>(),
    started = deferred<void>();
  const navigation: string[] = [];
  const sdk = client(async (target) => {
    navigation.push(target.page);
    if (target.page === "detail_page") {
      started.resolve();
      await pending.promise;
    }
  });
  const workspace = new SdkWorkspace(
    async () => sdk.instance,
    () => {},
  );
  await workspace.show({ page: "main_image" });
  const detail = workspace.show({ page: "detail_page" });
  await started.promise;
  const back = workspace.show({ page: "main_image" });
  pending.resolve();
  await Promise.all([detail, back]);
  assert.deepEqual(navigation, ["detail_page", "main_image"]);
  workspace.dispose();
});
test("late instances are destroyed after switching page or user", async () => {
  const pending = deferred<SdkInstance>(),
    started = deferred<void>(),
    old = client(),
    latest = client();
  let calls = 0,
    signal: AbortSignal | undefined;
  const workspace = new SdkWorkspace(
    async (_target, currentSignal) => {
      if (++calls === 1) {
        signal = currentSignal;
        started.resolve();
        return pending.promise;
      }
      return latest.instance;
    },
    () => {},
  );
  const first = workspace.show({ page: "main_image" });
  await started.promise;
  const second = workspace.show({ page: "aigc" });
  assert.equal(signal?.aborted, true);
  pending.resolve(old.instance);
  await Promise.all([first, second]);
  assert.equal(old.destroyed(), 1);
  assert.equal(calls, 2);
  workspace.dispose();
  assert.equal(latest.destroyed(), 1);
});
test("failed initialization has a retry path, and successful connection is cancelled on disposal", async () => {
  const states: WorkspaceState[] = [],
    sdk = client();
  let calls = 0,
    connection: AbortSignal | undefined;
  const workspace = new SdkWorkspace(
    async (_target, signal) => {
      connection = signal;
      if (++calls === 1) throw new Error("商户 API Key 无效");
      return sdk.instance;
    },
    (state) => states.push(state),
  );
  await workspace.show({ page: "main_image" });
  assert.equal(states.at(-1)?.status, "error");
  assert.equal(
    sdkFailureMessage(states.at(-1)?.error),
    "页面暂时无法打开，请稍后重试。",
  );
  await workspace.retry();
  assert.equal(states.at(-1)?.status, "ready");
  workspace.dispose();
  assert.equal(connection?.aborted, true);
  assert.equal(
    sdkFailureMessage({ code: "INITIALIZATION_FAILED" }),
    "页面暂时无法打开，请稍后重试。",
  );
});

test("navigation rejection keeps the visible instance and retry uses navigate", async () => {
  let opens = 0,
    navigations = 0;
  const states: WorkspaceState[] = [];
  const sdk = client(async () => {
    if (++navigations === 1)
      throw {
        code: "INVALID_ARGUMENT",
        message: "private authorization details",
      };
  });
  const workspace = new SdkWorkspace(
    async () => {
      opens++;
      return sdk.instance;
    },
    (state) => states.push(state),
  );
  await workspace.show({ page: "main_image" });
  await workspace.show({ page: "detail_page" });
  assert.equal(states.at(-1)?.status, "error");
  assert.equal(states.at(-1)?.retainPage, true);
  assert.equal(sdk.destroyed(), 0);
  await workspace.retry();
  assert.equal(opens, 1);
  assert.equal(navigations, 2);
  assert.equal(states.at(-1)?.status, "ready");
  workspace.dispose();
});

test("fatal SDK failure clears the old instance and retry opens a fresh one", async () => {
  const old = client(),
    next = client(),
    states: WorkspaceState[] = [];
  let opens = 0;
  const workspace = new SdkWorkspace(
    async () => (++opens === 1 ? old.instance : next.instance),
    (state) => states.push(state),
  );
  await workspace.show({ page: "main_image" });
  workspace.fail({ code: "FRAME_RELOADED" });
  assert.equal(old.destroyed(), 1);
  assert.equal(states.at(-1)?.status, "error");
  assert(!states.at(-1)?.retainPage);
  await workspace.retry();
  assert.equal(opens, 2);
  workspace.dispose();
  assert.equal(next.destroyed(), 1);
});

test("late navigation cannot restore readiness after account disposal", async () => {
  const pending = deferred<void>(),
    started = deferred<void>();
  const states: WorkspaceState[] = [];
  const sdk = client(async () => {
    started.resolve();
    await pending.promise;
  });
  const workspace = new SdkWorkspace(
    async () => sdk.instance,
    (state) => states.push(state),
  );
  await workspace.show({ page: "main_image" });
  const navigation = workspace.show({ page: "detail_page" });
  await started.promise;
  workspace.dispose();
  pending.resolve();
  await navigation;
  assert.equal(states.at(-1)?.status, "navigating");
  assert.equal(sdk.destroyed(), 1);
});

test("user errors never expose arbitrary messages, URLs, credentials or protocol details", () => {
  const internal = new Error(
    "SDK signature failed https://localhost:18080 key=private-key payload=private-payload",
  );
  assert.equal(sdkFailureMessage(internal), "页面暂时无法打开，请稍后重试。");
  assert.equal(
    sdkFailureMessage({ code: "TIMEOUT", message: internal.message }),
    "页面加载超时，请重试。",
  );
  assert.equal(
    sdkFailureMessage({ code: "constructor" }),
    "页面暂时无法打开，请稍后重试。",
  );
});
