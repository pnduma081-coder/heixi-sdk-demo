import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveConfig } from "../server/config.ts";
import { localReadTransport, resolveF065Config } from "../server/f065-local.ts";
import { startDemo } from "../server/index.ts";
import { localSdkPath, onlineSdkUrl } from "../shared/sdk-release.ts";
import { createSdkOptions, loadSdk } from "../src/sdk.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "f065-host-test-"));
  const sdkFile = join(directory, "sdk.js");
  const bytes = Buffer.from(
    '/* synthetic 0.4 artifact, never executed */ "http://localhost:18080"',
  );
  writeFileSync(sdkFile, bytes);
  return {
    input: {
      directory: join(directory, "data"),
      sdkFile,
      sdkSha256: createHash("sha256").update(bytes).digest("hex"),
      apiOrigin: "http://localhost:18080",
      hostOrigin: "http://127.0.0.1:3443",
    },
    bytes,
    close: () => rmSync(directory, { recursive: true }),
  };
}
test("local mode pins 0.4 artifact, has no credentials or online defaults and leaves online mode unchanged", () => {
  const f = fixture();
  try {
    const config = resolveF065Config(f.input);
    assert.equal(config.public.sdkVersion, "0.4.0");
    assert.equal(config.public.sdkScriptUrl, localSdkPath);
    assert.equal(config.public.apiReady, false);
    assert.equal(config.public.callbacksReady, false);
    assert.equal(config.apiKey, "");
    assert.equal(config.accessKey, "");
    assert(!JSON.stringify(config.public).includes("heixi.com"));
    assert.equal(resolveConfig().public.sdkScriptUrl, onlineSdkUrl);
    for (const apiOrigin of [
      "https://api.heixi.com",
      "http://localhost:18080/path",
      "http://user:pass@localhost:18080",
      "http://127.0.0.2:18080",
    ])
      assert.throws(() => resolveF065Config({ ...f.input, apiOrigin }));
    assert.throws(() =>
      resolveF065Config({ ...f.input, apiOrigin: f.input.hostOrigin }),
    );
    assert.throws(() =>
      resolveF065Config({ ...f.input, sdkSha256: "0".repeat(64) }),
    );
    assert.throws(() =>
      resolveF065Config({ ...f.input, apiOrigin: "http://localhost:18081" }),
    );
  } finally {
    f.close();
  }
});
test("local transport permits only exact local catalog/signature and never redirects, polls, approves or submits", async () => {
  const calls: string[] = [];
  const transport = localReadTransport(
    "http://localhost:18080",
    async (url) => {
      calls.push(String(url));
      return Response.json({ code: 0, data: {} });
    },
  );
  await transport("http://localhost:18080/api/v1/open/models", {
    redirect: "error",
  });
  await transport("http://localhost:18080/api/v1/open/sdk/signature", {
    method: "POST",
    redirect: "error",
  });
  for (const path of [
    "/open/events",
    "/open/history",
    "/open/design-jobs",
    "/open/sdk/generation-quotes/id/approve",
    "/open/feature-operations/id/approve",
  ])
    await assert.rejects(
      transport(`http://localhost:18080/api/v1${path}`, {
        method: "POST",
        redirect: "error",
      }),
    );
  await assert.rejects(
    transport("http://localhost:18080/api/v1/open/events", {
      redirect: "error",
    }),
  );
  await assert.rejects(
    transport("https://api.heixi.com/api/v1/open/models", {
      redirect: "error",
    }),
  );
  await assert.rejects(
    transport("http://localhost:18080/api/v1/open/models", {
      redirect: "follow",
    }),
  );
  assert.equal(calls.length, 2);
});
test("cancelled legacy and FEATURE host requests stop before approval in local mode", async () => {
  const options = createSdkOptions("synthetic", {
    localReadOnly: true,
    onRefresh() {},
    onRecharge() {},
    onError() {},
  });
  for (const request of [
    { quoteId: "legacy" },
    {
      quoteId: "feature",
      featureConfirmation: { featureCode: "PROMPT_ASSISTANCE" },
    },
  ])
    assert.deepEqual(
      await options.onBeforeGenerate(request, AbortSignal.abort()),
      { approved: false, message: "已取消本地验收" },
    );
});
test("isolated local server serves pinned bytes/config, rejects callbacks and writes, makes no platform requests", async () => {
  const f = fixture();
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const config = resolveF065Config({
    ...f.input,
    hostOrigin: `http://127.0.0.1:${address.port}`,
  });
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(url);
    assert.equal(new URL(url).origin, config.public.hostOrigin);
    return original(input, init);
  }) as typeof fetch;
  let server: Awaited<ReturnType<typeof startDemo>> | undefined;
  try {
    server = await startDemo(config);
    const script = await fetch(config.public.hostOrigin + localSdkPath);
    assert.equal(script.status, 200);
    assert.equal(await script.text(), f.bytes.toString());
    const response = await fetch(`${config.public.hostOrigin}/api/config`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.sdkMode, "f065-local");
    for (const path of [
      "/webhooks/credits",
      "/webhooks/generation",
      "/api/sdk/approve",
      "/api/generate",
    ])
      assert.equal(
        (await fetch(config.public.hostOrigin + path, { method: "POST" }))
          .status,
        403,
      );
    assert.equal(requests.length, 6);
  } finally {
    await server?.stop();
    globalThis.fetch = original;
    f.close();
  }
});

test("local SDK loader admits only approved exact tunnel and never falls back on load failure", async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const location = {
    hostname: "other.example",
    origin: "https://other.example",
  };
  type Script = { src: string; onerror?: () => void; remove(): void };
  const scripts: Script[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({ src: "", remove() {} }),
      head: { append: (s: Script) => scripts.push(s) },
    },
  });
  try {
    for (const origin of [
      "https://other.example",
      "http://rhino-demo.laotangcode.shop",
      "https://rhino-demo.laotangcode.shop:444",
      "https://rhino-demo.laotangcode.shop.evil.test",
    ]) {
      location.origin = origin;
      location.hostname = new URL(origin).hostname;
      await assert.rejects(loadSdk(localSdkPath, "f065-local"), /精确tunnel/);
    }
    location.origin = "https://rhino-demo.laotangcode.shop";
    location.hostname = "rhino-demo.laotangcode.shop";
    await assert.rejects(loadSdk(onlineSdkUrl, "f065-local"), /未登记/);
    const pending = loadSdk(localSdkPath, "f065-local");
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].src, localSdkPath);
    scripts[0].onerror?.();
    await assert.rejects(pending, /不会切换/);
    assert.equal(scripts.length, 1);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("browser platform override rejects unapproved public origin before reading an artifact", () => {
  for (const browserApiOrigin of [
    "https://api.heixi.com",
    "http://rhino-platform.laotangcode.shop",
    "https://rhino-platform.laotangcode.shop:444",
    "https://rhino-demo.laotangcode.shop",
  ])
    assert.throws(
      () =>
        resolveF065Config({
          apiOrigin: "http://localhost:18080",
          hostOrigin: "http://127.0.0.1:3443",
          browserApiOrigin,
          sdkFile: "/not-read",
          sdkSha256: "0".repeat(64),
          directory: "/tmp/not-used",
        }),
      /精确批准/,
    );
});
