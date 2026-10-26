import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveConfig } from "../server/config.ts";
import {
  type F065LocalMerchantSource,
  f065EnvTarget,
  f065LocalTarget,
  provideF065EnvConfig,
  provideF065LocalConfig,
} from "../server/f065-local-provider.ts";

const merchantSource: F065LocalMerchantSource = {
  kind: "verified-local-merchant",
  merchantId: f065LocalTarget.merchantId,
  siteId: 1,
  memberId: "1",
  apiOrigin: "https://localhost:18080",
  hostOrigin: "https://127.0.0.1:3443",
  frameOrigin: "https://localhost:18080",
};
const sdkFile = process.env.F065_TEST_SDK_FILE;
const tunnelSdkFile = process.env.F065_TEST_TUNNEL_SDK_FILE;
function input() {
  return {
    merchantSource,
    sdkFile: sdkFile || "/not-read",
    directory: "/tmp/f065-provider-unused",
  };
}

test("verified local source and actual pinned HTTPS 0.4 artifact remain disabled without credentials", {
  skip: !sdkFile,
}, () => {
  const config = provideF065LocalConfig(input());
  assert.equal(config.apiOrigin, merchantSource.apiOrigin);
  assert.equal(config.public.hostOrigin, merchantSource.hostOrigin);
  assert.equal(config.public.sdkVersion, "0.4.0");
  assert.equal(config.localSdk?.sha256, f065LocalTarget.sdkSha256);
  assert.equal(config.public.apiReady, false);
  assert.equal(config.public.callbacksReady, false);
  assert.equal(config.apiKey, "");
  assert.equal(config.accessKey, "");
  assert.deepEqual(config.public.missing, ["F065_LOCAL_MERCHANT_SESSION"]);
});

test("source identity, tenant, API, host and canonical origin cannot drift or fall back online", () => {
  for (const patch of [
    { kind: "online" },
    { merchantId: "7278d144-0102-49c9-b617-223011d7fcf8" },
    { siteId: 2 },
    { memberId: "11" },
    { apiOrigin: "http://localhost:18080" },
    { apiOrigin: "https://api.heixi.com" },
    { hostOrigin: "https://localhost:3443" },
    { hostOrigin: "https://127.0.0.1:3443/" },
    { frameOrigin: "https://www.heixi.com" },
    { frameOrigin: "http://localhost:18080" },
  ])
    assert.throws(() =>
      provideF065LocalConfig({
        ...input(),
        merchantSource: {
          ...merchantSource,
          ...patch,
        } as F065LocalMerchantSource,
      }),
    );
});

test("missing explicit local identity fails before reading artifact", () => {
  assert.throws(
    () =>
      provideF065LocalConfig({
        ...input(),
        sdkFile: "/not-read",
        merchantSource: undefined as unknown as F065LocalMerchantSource,
      }),
    /指定本地商户/,
  );
});

test("changed artifact is rejected even when it claims the expected local origin", () => {
  const directory = mkdtempSync(join(tmpdir(), "f065-provider-test-"));
  try {
    const file = join(directory, "sdk.js");
    writeFileSync(file, '"https://localhost:18080"');
    assert.throws(
      () => provideF065LocalConfig({ ...input(), sdkFile: file }),
      /制品校验失败/,
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

function syntheticLoaded() {
  return resolveConfig({
    appOrigin: f065EnvTarget.hostOrigin,
    env: {
      BLACK_RHINO_API_KEY: `sk-${"x".repeat(43)}`,
      BLACK_RHINO_ACCESS_KEY: `ak-${"a".repeat(32)}`,
    },
  });
}
test("explicit env mode pins local HTTP API, approved tunnel and HTTPS artifact without leaking credentials", {
  skip: !tunnelSdkFile,
}, () => {
  const loadedConfig = syntheticLoaded();
  const config = provideF065EnvConfig({
    loadedConfig,
    sdkFile: tunnelSdkFile || "/not-read",
    directory: "/tmp/f065-env-test",
  });
  assert.equal(config.apiOrigin, "http://localhost:18080");
  assert.equal(config.public.sdkApiOrigin, f065EnvTarget.frameOrigin);
  assert.equal(config.localSdk?.sha256, f065EnvTarget.sdkSha256);
  assert.equal(config.public.hostOrigin, f065EnvTarget.hostOrigin);
  assert.equal(config.listenOrigin, "http://127.0.0.1:3443");
  assert.equal(config.public.apiReady, true);
  assert.equal(config.public.callbacksReady, false);
  assert.equal(config.public.sdkMode, "f065-local");
  assert.equal(config.apiKey, loadedConfig.apiKey);
  assert.equal(config.accessKey, loadedConfig.accessKey);
  assert.equal(
    JSON.stringify(config.public).includes(loadedConfig.apiKey),
    false,
  );
  assert.equal(
    JSON.stringify(config.public).includes(loadedConfig.accessKey || "MISSING"),
    false,
  );
  assert.equal(loadedConfig.apiOrigin, "https://api.heixi.com");
});
test("env mode refuses missing credentials, different host or TLS tunnel backhaul before artifact access", () => {
  for (const patch of [
    { apiKey: "" },
    { accessKey: "" },
    { listenOrigin: "https://127.0.0.1:3443" },
    { public: { ...syntheticLoaded().public, apiReady: false } },
    {
      public: {
        ...syntheticLoaded().public,
        hostOrigin: "https://other.example",
      },
    },
  ])
    assert.throws(
      () =>
        provideF065EnvConfig({
          loadedConfig: { ...syntheticLoaded(), ...patch },
          sdkFile: "/not-read",
          directory: "/tmp/not-used",
        }),
      /本地env模式/,
    );
});

test("env mode refuses the previous localhost artifact after the explicit tunnel binding", {
  skip: !sdkFile,
}, () => {
  assert.throws(
    () =>
      provideF065EnvConfig({
        loadedConfig: syntheticLoaded(),
        sdkFile: sdkFile || "/not-read",
        directory: "/tmp/not-used",
      }),
    /制品校验失败/,
  );
});
