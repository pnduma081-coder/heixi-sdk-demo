import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkPublicRoutes,
  parseTunnelToken,
  remoteTunnelConfig,
  saveTunnelToken,
  startTokenSetup,
} from "../scripts/cloudflare.mjs";

const fixture = {
  tunnelId: "00000000-0000-4000-8000-000000000001",
  accountId: "fixture-account",
  publicOrigin: "https://hooks.example",
  service: "http://127.0.0.1:3443",
};
const token = Buffer.from(
  JSON.stringify({
    t: fixture.tunnelId,
    a: fixture.accountId,
    s: "synthetic-test-secret-only",
  }),
).toString("base64");
test("page proxy uses its own hostname while callback hostname remains restricted", () => {
  const config = remoteTunnelConfig({
    ...fixture,
    appOrigin: "https://demo.example",
  });
  assert.equal(config.ingress.length, 3);
  assert.equal(config.ingress[0].path, "^/webhooks/(credits|generation)$");
  assert.equal(config.ingress[1].hostname, "demo.example");
  assert.equal(config.ingress[1].originRequest.httpHostHeader, "demo.example");
  assert.equal(config.ingress[1].service, "http://127.0.0.1:3443");
  assert.deepEqual(config.ingress[2], { service: "http_status:404" });
  assert.throws(() =>
    remoteTunnelConfig({ ...fixture, appOrigin: fixture.publicOrigin }),
  );
});
test("temporary token form rejects foreign submissions and closes after a private save", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rhino-token-form-"));
  const { server, url } = await startTokenSetup(fixture, directory);
  try {
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("referrer-policy"), "same-origin");
    assert.match(await page.text(), /type="password"/);
    const submit = (origin) =>
      fetch(url, {
        method: "POST",
        headers: { origin },
        body: new URLSearchParams({ token }),
      });
    assert.equal((await submit("https://foreign.example")).status, 403);
    assert.equal((await fetch(new URL("/", url))).status, 404);
    await assert.rejects(readFile(join(directory, ".local/cloudflare/token")));
    const saved = await submit(new URL(url).origin);
    assert.equal(saved.status, 200);
    assert(!(await saved.text()).includes(token));
    assert.equal(
      await readFile(join(directory, ".local/cloudflare/token"), "utf8"),
      token,
    );
    assert.equal(server.listening, false);
  } finally {
    server.close();
    server.closeAllConnections();
    await rm(directory, { recursive: true, force: true });
  }
});
test("tunnel exposes exactly signed webhook paths with HTTP origin and local Host", () => {
  const config = remoteTunnelConfig(fixture, "/fixture/project");
  assert.equal(config.ingress.length, 2);
  const route = config.ingress[0],
    pattern = new RegExp(route.path);
  assert(pattern.test("/webhooks/credits"));
  assert(pattern.test("/webhooks/generation"));
  for (const path of [
    "/",
    "/api/session",
    "/files/id",
    "/webhooks/credits/extra",
    "/webhooks/other",
  ])
    assert(!pattern.test(path));
  assert.equal(route.service, fixture.service);
  assert.deepEqual(route.originRequest, { httpHostHeader: "127.0.0.1:3443" });
  assert.deepEqual(config.ingress[1], { service: "http_status:404" });
});
test("optional HTTPS tunnel origin retains certificate verification", () => {
  const route = remoteTunnelConfig(
    { ...fixture, service: "https://127.0.0.1:3443" },
    "/fixture/project",
  ).ingress[0];
  assert.equal(route.originRequest.noTLSVerify, false);
  assert.equal(route.originRequest.originServerName, "localhost");
  assert.equal(
    route.originRequest.caPool,
    "/fixture/project/.local/tls/cert.pem",
  );
});
test("token handling accepts the displayed command, checks ownership and stores credentials privately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rhino-tunnel-"));
  try {
    assert.equal(
      parseTunnelToken(`cloudflared tunnel run --token ${token}`, fixture),
      token,
    );
    assert.throws(
      () => parseTunnelToken(token, { ...fixture, tunnelId: "other" }),
      /不属于/,
    );
    assert.throws(() => parseTunnelToken("eyJh********", fixture), /完整/);
    await saveTunnelToken(token, fixture, directory);
    const file = join(directory, ".local/cloudflare/token");
    assert.equal(await readFile(file, "utf8"), token);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(() =>
      saveTunnelToken("wrong-token", fixture, directory),
    );
    assert.equal(await readFile(file, "utf8"), token);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("public checks verify webhook rejection and deny account access, without credentials or real events", async () => {
  const calls = [];
  await checkPublicRoutes(fixture.publicOrigin, async (url, options) => {
    calls.push([url.pathname, options.method]);
    assert.equal(options.redirect, "error");
    if (options.method === "POST") {
      assert.equal(options.body, "{}");
      return Response.json({ error: "回调签名无效或已过期" }, { status: 401 });
    }
    return new Response(null, { status: 404 });
  });
  assert.equal(calls.length, 4);
  await assert.rejects(
    () =>
      checkPublicRoutes(
        fixture.publicOrigin,
        async () => new Response("login", { status: 401 }),
      ),
    /验证失败/,
  );
  await assert.rejects(
    () =>
      checkPublicRoutes(fixture.publicOrigin, async (url) =>
        url.pathname.startsWith("/webhooks/")
          ? Response.json({ error: "回调签名无效" }, { status: 401 })
          : Response.json({ user: "must not be public" }),
      ),
    /验证失败/,
  );
});
