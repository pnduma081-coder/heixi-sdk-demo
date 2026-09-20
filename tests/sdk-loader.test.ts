import assert from "node:assert/strict";
import test from "node:test";
import { onlineSdkUrl } from "../shared/sdk-release.ts";
import { loadSdk } from "../src/sdk.ts";

test("CDN SDK loader retries the same release, rejects source mixing and never falls back", async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  type Script = {
    src: string;
    referrerPolicy?: string;
    onload?: (() => void) | null;
    onerror?: (() => void) | null;
    remove(): void;
  };
  const scripts: Script[] = [];
  const fakeWindow: { BlackRhinoSDK?: { init(): void } } = {};
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({ src: "", remove() {} }),
      head: {
        append(script: Script) {
          scripts.push(script);
        },
      },
    },
  });
  try {
    await assert.rejects(
      loadSdk("https://unconfigured.example/sdk.js"),
      /未登记/,
    );
    fakeWindow.BlackRhinoSDK = { init() {} };
    await assert.rejects(loadSdk(onlineSdkUrl), /未知来源/);
    delete fakeWindow.BlackRhinoSDK;
    const first = loadSdk(onlineSdkUrl);
    assert.equal(loadSdk(onlineSdkUrl), first);
    assert.equal(scripts[0].src, onlineSdkUrl);
    assert.equal(scripts[0].referrerPolicy, "no-referrer");
    scripts[0].onerror?.();
    await assert.rejects(first, /不会切换/);
    const retry = loadSdk(onlineSdkUrl);
    assert.equal(scripts[1].src, onlineSdkUrl);
    fakeWindow.BlackRhinoSDK = { init() {} };
    scripts[1].onload?.();
    await retry;
    await loadSdk(onlineSdkUrl);
    await assert.rejects(loadSdk("/vendor/black-rhino-sdk.iife.js"), /未登记/);
    assert.deepEqual(
      scripts.map((script) => script.src),
      [onlineSdkUrl, onlineSdkUrl],
    );
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
