import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createServer as createViteServer } from "vite";
import { hostOrigin, root, sdkApiOrigin } from "../server/config.ts";
import type { SessionState } from "../shared/types.ts";

// 独立浏览器夹具：仅内存用户与替身 SDK，不读取配置、不连接其他服务。
const state: SessionState = {
  user: {
    id: "fixture-a",
    name: "测试用户 A",
    credits: 1000,
    externalUserId: "fixture-a",
  },
  users: [
    {
      id: "fixture-a",
      name: "测试用户 A",
      credits: 1000,
      externalUserId: "fixture-a",
    },
    {
      id: "fixture-b",
      name: "测试用户 B",
      credits: 500,
      externalUserId: "fixture-b",
    },
  ],
  ledger: [],
  results: [],
  requests: [],
};
if (process.argv.includes("--sales")) {
  state.users[0].credits = 965;
  state.ledger = [
    {
      id: "fixture-sale",
      userId: "fixture-a",
      kind: "SALE_DEBIT",
      delta: -35,
      balance: 965,
      reference: "fixture-item-debit",
      createdAt: new Date().toISOString(),
    },
  ];
  state.platformCosts = [
    {
      eventId: "fixture-cost",
      kind: "credits.debited",
      delta: -20,
      payload: {},
      createdAt: new Date().toISOString(),
    },
  ];
}
state.user = state.users[0];
let signatureFailure = false;
let slowUpdate = false;
let stalledFrame = false;
let navigationMode = "normal";
const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1:3444");
  function json(value: unknown, status = 200) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  }
  if (url.pathname.startsWith("/__fixture__/")) {
    signatureFailure = url.pathname === "/__fixture__/signature-error";
    slowUpdate = url.pathname === "/__fixture__/slow-update";
    stalledFrame = url.pathname === "/__fixture__/stalled-frame";
    navigationMode =
      url.pathname === "/__fixture__/slow-navigation"
        ? "slow"
        : url.pathname === "/__fixture__/navigation-error"
          ? "fail"
          : "normal";
    res.writeHead(302, { Location: "/create/main-image" });
    res.end();
    return;
  }
  if (url.pathname === "/__sdk-fixture__/embed") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<!doctype html><p>隔离握手超时夹具：不连接真实平台，不回应握手。</p>",
    );
    return;
  }
  if (url.pathname === "/vendor/black-rhino-sdk.iife.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(
      `window.__SDK_FIXTURE_SLOW_UPDATE__ = ${slowUpdate}; window.__SDK_FIXTURE_STALLED_FRAME__ = ${stalledFrame}; window.__SDK_FIXTURE_NAVIGATION__ = ${JSON.stringify(navigationMode)};\n${readFileSync(resolve(root, "tests/fixtures/sdk-browser.js"), "utf8")}`,
    );
    return;
  }
  if (!url.pathname.startsWith("/api/")) {
    vite.middlewares(req, res);
    return;
  }
  void (async () => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    if (url.pathname === "/api/config")
      json({
        apiReady: true,
        callbacksReady: true,
        sdkReady: true,
        missing: [],
        hostOrigin,
        sdkApiOrigin: stalledFrame ? "http://127.0.0.1:3444" : sdkApiOrigin,
      });
    else if (url.pathname === "/api/session") {
      if (req.method === "POST")
        state.user =
          state.users.find((user) => user.id === body.userId) || state.user;
      json(
        req.method === "POST"
          ? state.user
          : {
              ...state,
              platformCosts:
                state.user.id === "fixture-a" ? state.platformCosts : [],
              ledger: state.ledger.filter(
                (item) => item.userId === state.user.id,
              ),
            },
      );
    } else if (url.pathname === "/api/credits") {
      state.user.credits += body.amount;
      state.ledger.unshift({
        id: crypto.randomUUID(),
        userId: state.user.id,
        delta: body.amount,
        balance: state.user.credits,
        kind: "TOPUP",
        reference: body.requestId,
        createdAt: new Date().toISOString(),
      });
      json(state.user);
    } else if (url.pathname === "/api/users") {
      const id = crypto.randomUUID();
      state.users.push({ id, name: body.name, externalUserId: id, credits: 0 });
      json(state.users.at(-1));
    } else if (url.pathname === "/api/sdk/state") json({ resultCursor: null });
    else if (url.pathname === "/api/sdk/signature")
      json(
        signatureFailure
          ? { error: "商户 API Key 无效（隔离验收用错误）" }
          : { signature: "fixture-signature" },
        signatureFailure ? 401 : 200,
      );
    else json({ error: "此隔离页面不发起真实生成" }, 400);
  })().catch(() => json({ error: "fixture request failed" }, 500));
});
const vite = await createViteServer({
  root,
  configFile: resolve(root, "vite.config.ts"),
  configLoader: "native",
  server: {
    middlewareMode: true,
    hmr: { server, host: "127.0.0.1", clientPort: 3444 },
  },
});
server.listen(3444, "127.0.0.1", () =>
  console.info("ISOLATED_PLATFORM_PREVIEW http://127.0.0.1:3444"),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void vite.close().then(() => {
      server.closeAllConnections();
      server.close(() => process.exit(0));
    });
  });
