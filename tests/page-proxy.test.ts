import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveConfig } from "../server/config.ts";
import { startDemo } from "../server/index.ts";

test("HTTPS page proxy over HTTP preserves session, origin checks, Vite HMR and callback separation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rhino-page-proxy-"));
  const config = resolveConfig({
    directory,
    appOrigin: "https://demo.example",
    callbackOrigin: "https://callbacks.example",
  });
  config.listenOrigin = "http://127.0.0.1:0";
  const demo = await startDemo(config);
  assert(demo.address && typeof demo.address === "object");
  const port = demo.address.port;
  const get = (
    path: string,
    body?: object,
    headers: Record<string, string> = {},
  ) =>
    new Promise<{ status: number | undefined; body: string; cookie: string }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            path,
            method: body ? "POST" : "GET",
            headers: {
              host: "demo.example",
              ...headers,
              ...(body ? { "content-type": "application/json" } : {}),
            },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              text += chunk;
            });
            res.on("end", () =>
              resolve({
                status: res.statusCode,
                body: text,
                cookie: res.headers["set-cookie"]?.[0] || "",
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body ? JSON.stringify(body) : undefined);
      },
    );
  try {
    assert.equal((await get("/")).status, 200);
    const publicConfig = await get("/api/config");
    assert.equal(
      JSON.parse(publicConfig.body).hostOrigin,
      "https://demo.example",
    );
    const session = await get("/api/session");
    assert.equal(session.status, 200);
    assert.match(session.cookie, /; Secure;/);
    const cookie = session.cookie.split(";")[0];
    assert.equal(
      (
        await get(
          "/api/session",
          { userId: "demo-b" },
          { cookie, origin: "https://foreign.example" },
        )
      ).status,
      403,
    );
    const switched = await get(
      "/api/session",
      { userId: "demo-b" },
      { cookie, origin: "https://demo.example" },
    );
    assert.equal(switched.status, 200);
    assert.equal(JSON.parse(switched.body).id, "demo-b");
    // 本机 HTTP 回源地址仍可管理示例账户；Cookie 不带 Secure，但不能冒用代理来源。
    const local = { host: "127.0.0.1:0" };
    const localSession = await get("/api/session", undefined, local);
    assert.equal(localSession.status, 200);
    assert.doesNotMatch(localSession.cookie, /Secure/);
    const localCookie = localSession.cookie.split(";")[0];
    assert.equal(
      (
        await get(
          "/api/session",
          { userId: "demo-b" },
          { ...local, cookie: localCookie, origin: "http://127.0.0.1:0" },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await get(
          "/api/session",
          { userId: "demo-a" },
          { ...local, cookie: localCookie, origin: "https://demo.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await get("/webhooks/credits", {}, { host: "127.0.0.1:0" })).status,
      401,
    );
    assert.equal(
      (await get("/api/session", undefined, { host: "foreign.example" }))
        .status,
      403,
    );
    for (const path of ["/.env.local", "/server/config.ts"])
      assert.equal((await get(path)).status, 403);
    const hmr = await get("/@vite/client");
    assert.equal(hmr.status, 200);
    assert.match(hmr.body, /wss/);
    assert.match(hmr.body, /demo\.example/);
  } finally {
    await demo.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
