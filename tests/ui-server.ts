import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostOrigin as httpOrigin,
  httpsHostOrigin,
  resolveConfig,
} from "../server/config.ts";
import { startDemo } from "../server/index.ts";

const useHttps = process.argv.includes("--https");
const hostOrigin = useHttps ? httpsHostOrigin : httpOrigin;
const get = useHttps ? httpsGet : httpGet;

// 浏览器验收只使用本次新建的临时库、证书和空凭证，不加载真实环境文件。
const directory = mkdtempSync(join(tmpdir(), "black-rhino-demo-ui-test-"));
if (useHttps)
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "ignore" },
  );
const server = await startDemo(
  resolveConfig({ https: useHttps, directory }),
  directory,
);
if (process.argv.includes("--verify")) {
  try {
    for (const path of [
      "/",
      "/create/main-image",
      "/create/apparel/background-replace",
      "/works",
      "/api/session",
      "/api",
      "/src/main.ts",
      "/src/App.vue",
      "/src/AccountPages.vue",
      "/src/AppIcon.vue",
      "/src/router.ts",
      "/src/navigation.ts",
      "/src/sdk-workspace.ts",
      "/src/ApiPanel.vue",
      "/src/SdkPanel.vue",
      "/shared/examples.ts",
      "/shared/sdk-release.ts",
      "/server/config.ts",
      "/.env.example",
    ]) {
      const status = await new Promise<number | undefined>(
        (resolve, reject) => {
          get(
            hostOrigin + path,
            {
              ...(useHttps
                ? { ca: readFileSync(join(directory, "cert.pem")) }
                : {}),
              rejectUnauthorized: true,
            },
            (response) => {
              if (path === "/api/session") {
                const cookie = response.headers["set-cookie"]?.[0] || "";
                assert.match(cookie, /HttpOnly/);
                assert.equal(cookie.includes("; Secure;"), useHttps);
                assert(cookie.startsWith("demo_session="));
              }
              const chunks: Buffer[] = [];
              if (path === "/api/session")
                response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              response.resume();
              response.on("end", () => {
                try {
                  if (path === "/api/session") {
                    const state = JSON.parse(Buffer.concat(chunks).toString());
                    assert.equal(state.user.externalUserId, "demo-user-a");
                    assert.equal(state.user.credits, 0);
                  }
                  resolve(response.statusCode);
                } catch (error) {
                  reject(error);
                }
              });
            },
          ).on("error", reject);
        },
      );
      assert.equal(
        status,
        path === "/server/config.ts" || path.startsWith("/.env.") ? 403 : 200,
        path,
      );
    }
    console.info(
      `PASS: ${useHttps ? "HTTPS" : "HTTP"}、Vue/Vite 模块编译、SDK 静态文件，以及服务端/环境模板访问限制。`,
    );
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void server.stop().then(() => {
      rmSync(directory, { recursive: true, force: true });
      process.exit(0);
    });
  });
