import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../server/config.ts";
import { onlineSdkUrl } from "../shared/sdk-release.ts";

test("demo always uses the published SDK/API and one data directory without merchant-specific settings", () => {
  const config = resolveConfig({
    directory: "/fixture/project",
    env: {
      BLACK_RHINO_API_KEY: "synthetic-key-only",
      BLACK_RHINO_HOST_ORIGIN: "https://merchant.example",
    },
    callbackOrigin: "https://callbacks.example",
  });
  assert.equal(config.apiOrigin, "https://api.heixi.com");
  assert.equal(config.public.sdkApiOrigin, config.apiOrigin);
  assert.equal(config.public.sdkScriptUrl, onlineSdkUrl);
  assert.equal(config.public.sdkVersion, "0.3.0");
  assert.equal(config.dataDir, "/fixture/project/.local");
  assert.equal(config.public.hostOrigin, "https://merchant.example");
  assert.equal(config.listenOrigin, "http://127.0.0.1:3443");
  assert.equal(config.public.callbackOrigin, "https://callbacks.example");
  assert.deepEqual(config.public.missing, []);
  assert(!JSON.stringify(config.public).includes("synthetic-key-only"));
});

test("demo can start without credentials; HTTPS stays optional", () => {
  const config = resolveConfig({ directory: "/fixture/project" });
  assert.equal(config.dataDir, "/fixture/project/.local");
  assert.deepEqual(config.public.missing, ["BLACK_RHINO_API_KEY"]);
  assert.equal(config.public.apiReady, false);
  assert.equal(config.public.sdkReady, true);
  assert.equal(config.public.hostOrigin, "http://127.0.0.1:3443");
  assert.match(config.public.configurationIssues?.[0] || "", /HTTPS/);
  assert.equal(
    resolveConfig({ https: true }).public.hostOrigin,
    "https://127.0.0.1:3443",
  );
});

test("obsolete BLACK_RHINO_* variables are reported instead of silently ignored", () => {
  const config = resolveConfig({
    env: {
      BLACK_RHINO_API_KEY: "synthetic-key-only",
      BLACK_RHINO_API_ORIGIN: "https://localhost:18080",
    },
  });
  assert.equal(config.apiOrigin, "https://api.heixi.com");
  assert(
    config.public.configurationIssues?.some((issue) =>
      issue.includes("BLACK_RHINO_API_ORIGIN"),
    ),
  );
  assert(!JSON.stringify(config.public).includes("localhost:18080"));
});

test("page and callback origins remain exact and independent", () => {
  for (const origin of [
    "https://merchant.example/path",
    "https://merchant.example/",
    "https://user:pass@merchant.example",
    "http://merchant.example",
  ]) {
    assert.throws(() =>
      resolveConfig({ env: { BLACK_RHINO_HOST_ORIGIN: origin } }),
    );
  }
  assert.throws(() =>
    resolveConfig({ callbackOrigin: "http://callbacks.example" }),
  );
});

test("published page proxy sets HTTPS host without enabling local TLS or moving callbacks", () => {
  const config = resolveConfig({
    appOrigin: "https://demo.example",
    callbackOrigin: "https://callbacks.example",
    env: { BLACK_RHINO_HOST_ORIGIN: "http://127.0.0.1:3443" },
  });
  assert.equal(config.listenOrigin, "http://127.0.0.1:3443");
  assert.equal(config.public.hostOrigin, "https://demo.example");
  assert.equal(config.public.callbackOrigin, "https://callbacks.example");
  assert.throws(() => resolveConfig({ appOrigin: "http://demo.example" }));
});
