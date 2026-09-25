import { existsSync, readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type RequestListener,
} from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https";
import { resolve } from "node:path";
import { createServer as createViteServer } from "vite";
import { onlineSdkVersion } from "../shared/sdk-release.ts";
import { type Config, loadConfig, root } from "./config.ts";
import { EventPoller } from "./event-poller.ts";
import { createHandler, errorResponse } from "./http.ts";
import { MediaStore } from "./media.ts";
import { MerchantClient } from "./merchant.ts";
import { Operations } from "./operations.ts";
import { ResultService } from "./results.ts";
import { Store } from "./store.ts";

export function createFrontendServer(
  server: HttpServer | HttpsServer,
  pageOrigin?: string,
) {
  const page = pageOrigin ? new URL(pageOrigin) : undefined;
  return createViteServer({
    root,
    configFile: resolve(root, "vite.config.ts"),
    // bundle 模式会删除刚导入的临时配置，触发 node --watch 无限重启。
    // 项目已要求 Node 24+，可直接加载 TS 配置并保留前端热更新。
    configLoader: "native",
    server: {
      middlewareMode: true,
      ...(page ? { allowedHosts: [page.hostname] } : {}),
      hmr: {
        server,
        ...(page
          ? {
              protocol: page.protocol === "https:" ? "wss" : "ws",
              host: page.hostname,
              clientPort: Number(
                page.port || (page.protocol === "https:" ? 443 : 80),
              ),
            }
          : {}),
      },
    },
  });
}

export async function startDemo(
  config: Config,
  tlsDirectory = resolve(root, ".local/tls"),
) {
  const hostOrigin = config.public.hostOrigin;
  const listenOrigin = config.listenOrigin || hostOrigin;
  const useHttps = new URL(listenOrigin).protocol === "https:";
  const cert = resolve(tlsDirectory, "cert.pem"),
    key = resolve(tlsDirectory, "key.pem");
  if (useHttps && (!existsSync(cert) || !existsSync(key)))
    throw new Error("请先运行 pnpm setup:local 准备本地证书");
  const store = new Store(resolve(config.dataDir, "demo.sqlite"));
  const api = new MerchantClient(config.apiOrigin, config.apiKey, fetch, {
    version: onlineSdkVersion,
    accessKey: config.accessKey,
  });
  const results = new ResultService(
    store,
    api,
    new MediaStore(resolve(config.dataDir, "media")),
  );
  const handle = createHandler(
    config,
    store,
    api,
    new Operations(api, store),
    results,
  );
  const listener: RequestListener = (req, res) => {
    if (
      ![new URL(hostOrigin).host, new URL(listenOrigin).host].includes(
        req.headers.host || "",
      )
    ) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    void handle(req, res)
      .then((handled) => {
        if (!handled) vite.middlewares(req, res);
      })
      .catch((error) => errorResponse(res, error));
  };
  const server = useHttps
    ? createHttpsServer(
        { cert: readFileSync(cert), key: readFileSync(key) },
        listener,
      )
    : createHttpServer(listener);
  const vite = await createFrontendServer(server, hostOrigin);
  server.requestTimeout = 120_000;
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(
      Number(new URL(listenOrigin).port || (useHttps ? 443 : 80)),
      "127.0.0.1",
      () => {
        ready();
        console.info(`打开黑犀示例页面：${hostOrigin}`);
        console.info(`本机回源监听：${listenOrigin}`);
        for (const issue of config.public.configurationIssues || [])
          console.info(issue);
        console.info(
          config.public.missing.length
            ? `待填写配置：${config.public.missing.join(", ")}`
            : config.public.apiReady
              ? "AK/SK 格式有效；API 事件由服务端轮询，SDK 回调仍须配置"
              : "AK/SK 格式无效，API 调用与后台同步未启用",
        );
      },
    );
  });
  let stopping = false;
  const poller = new EventPoller(
    () => results.syncState.users(),
    (user) => results.syncEvents(user),
    Date.now,
    (userId) => results.syncState.active(userId),
  );
  results.onActivity = (userId) => poller.wake(userId);
  const pollTimer = config.public.apiReady
    ? setInterval(() => {
        void poller.tick();
      }, 1000)
    : undefined;
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(pollTimer);
    await poller.stop();
    await vite.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    store.close();
  }
  return { stop, address: server.address() };
}
if (process.argv[1] === import.meta.filename) {
  const { stop } = await startDemo(
    loadConfig({
      https: process.argv.includes("--https"),
    }),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      void stop().then(() => process.exit(0));
    });
}
