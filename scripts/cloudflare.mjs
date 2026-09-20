import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
export function readTunnelConfig() {
  const path = resolve(root, "cloudflare/tunnel.json");
  if (!existsSync(path))
    throw new Error(
      "缺少 cloudflare/tunnel.json：请复制 cloudflare/tunnel.example.json 并填写自己的隧道信息",
    );
  return JSON.parse(readFileSync(path, "utf8"));
}
export function remoteTunnelConfig(config, directory = root) {
  const origin = new URL(config.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== config.publicOrigin)
    throw new Error("隧道公网入口必须是精确 HTTPS origin");
  const app = config.appOrigin ? new URL(config.appOrigin) : undefined;
  if (
    app &&
    (app.protocol !== "https:" ||
      app.origin !== config.appOrigin ||
      app.origin === origin.origin)
  )
    throw new Error("页面入口须为与回调入口不同的精确 HTTPS origin");
  return {
    ingress: [
      {
        hostname: origin.hostname,
        path: "^/webhooks/(credits|generation)$",
        service: config.service,
        originRequest: {
          httpHostHeader: "127.0.0.1:3443",
          ...(config.service.startsWith("https:")
            ? {
                originServerName: "localhost",
                caPool: resolve(directory, ".local/tls/cert.pem"),
                noTLSVerify: false,
              }
            : {}),
        },
      },
      ...(app
        ? [
            {
              hostname: app.hostname,
              service: config.service,
              originRequest: {
                httpHostHeader: app.host,
                ...(config.service.startsWith("https:")
                  ? {
                      originServerName: "localhost",
                      caPool: resolve(directory, ".local/tls/cert.pem"),
                      noTLSVerify: false,
                    }
                  : {}),
              },
            },
          ]
        : []),
      { service: "http_status:404" },
    ],
  };
}
export function parseTunnelToken(input, config) {
  const raw = input.trim();
  const token =
    raw.match(/(?:--token\s+|service\s+install\s+)([A-Za-z0-9_+/=-]+)/)?.[1] ||
    raw;
  if (!/^[A-Za-z0-9_+/=-]{80,}$/.test(token))
    throw new Error("请粘贴完整隧道 Token 或控制台提供的连接命令");
  try {
    const value = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    if (
      value.t !== config.tunnelId ||
      value.a !== config.accountId ||
      typeof value.s !== "string" ||
      !value.s
    )
      throw new Error("mismatch");
  } catch {
    throw new Error("凭证不属于当前项目隧道，未保存");
  }
  return token;
}
export async function saveTunnelToken(input, config, directory = root) {
  const token = parseTunnelToken(input, config);
  const target = resolve(directory, ".local/cloudflare");
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
  const temporary = resolve(target, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, token, { mode: 0o600, flag: "wx" });
    await rename(temporary, resolve(target, "token"));
  } finally {
    await rm(temporary, { force: true });
  }
}
async function promptToken() {
  if (!process.stdin.isTTY)
    throw new Error(
      "请在交互终端运行 pnpm tunnel:token，避免把凭证写进命令历史",
    );
  process.stdout.write(
    "粘贴本隧道连接命令或 Token（输入不显示），然后回车：\n",
  );
  return new Promise((resolveInput, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (error) => {
      process.stdin.off("data", read);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolveInput(input);
    };
    const read = (chunk) => {
      const cleaned = chunk
        .replaceAll("\x1b[200~", "")
        .replaceAll("\x1b[201~", "");
      for (const character of cleaned) {
        if (character === "\x03")
          return finish(new Error("已取消，未保存凭证"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\x7f" || character === "\b")
          input = input.slice(0, -1);
        else input += character;
      }
      if (input.length > 16384) finish(new Error("输入过长，未保存凭证"));
    };
    process.stdin.on("data", read);
  });
}
// 临时本机表单用于安全粘贴控制台命令；不挂到示例应用或公网隧道。
export async function startTokenSetup(config, directory = root) {
  const path = `/setup/${randomUUID()}`;
  let origin = "",
    saving = false;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (req.headers.host !== new URL(origin).host || req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET") {
      res.end(
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本项目隧道凭证</title><h1>保存本项目隧道凭证</h1><p>仅保存到本项目 .local/cloudflare/token，成功后自动关闭接收服务。</p><form method="post" autocomplete="off"><label>隧道连接命令或 Token <input name="token" type="password" autocomplete="off" required></label><button type="submit">保存凭证</button></form></html>',
      );
      return;
    }
    if (
      req.method !== "POST" ||
      req.headers.origin !== origin ||
      !req.headers["content-type"]?.startsWith(
        "application/x-www-form-urlencoded",
      )
    ) {
      res.writeHead(403).end("请求来源不匹配");
      return;
    }
    if (saving) {
      res.writeHead(409).end("正在保存");
      return;
    }
    saving = true;
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString("utf8");
        if (body.length > 16384) throw new Error("输入过长");
      }
      await saveTunnelToken(
        new URLSearchParams(body).get("token") || "",
        config,
        directory,
      );
      res.end("凭证已保存；本机接收服务已关闭，可以关闭此页。");
      server.close();
    } catch {
      res.writeHead(400).end("凭证无效或保存失败，请返回重试。");
    } finally {
      saving = false;
    }
  });
  server.requestTimeout = 15000;
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", ready);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const timeout = setTimeout(() => {
    server.close();
    server.closeAllConnections();
  }, 600000);
  timeout.unref();
  server.once("close", () => clearTimeout(timeout));
  return { url: origin + path, server };
}
export async function checkPublicRoutes(origin, transport = fetch) {
  const checks = [
    ["/webhooks/credits", "POST", 401],
    ["/webhooks/generation", "POST", 401],
    ["/api/session", "GET", 404],
    ["/", "GET", 404],
  ];
  for (const [path, method, expected] of checks) {
    const response = await transport(new URL(path, origin), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      ...(method === "POST"
        ? { headers: { "Content-Type": "application/json" }, body: "{}" }
        : {}),
    });
    let signatureRejected = true;
    if (method === "POST") {
      const body = await response.json().catch(() => ({}));
      signatureRejected =
        typeof body.error === "string" && body.error.includes("回调签名");
    } else await response.body?.cancel();
    if (response.status !== expected || !signatureRejected)
      throw new Error(
        `${path} 验证失败：HTTP ${response.status}；请核对隧道路由和本地服务`,
      );
    console.info(`${path}：HTTP ${response.status}，符合预期`);
  }
}
async function main() {
  const config = readTunnelConfig(),
    command = process.argv[2] || "start";
  if (command === "token") {
    await saveTunnelToken(await promptToken(), config);
    console.info(
      "专用隧道凭证已保存到 .local/cloudflare/token（仅当前用户可读写）。",
    );
  } else if (command === "token-ui") {
    const setup = await startTokenSetup(config);
    console.info(`仅本机临时凭证页面（10分钟有效）：${setup.url}`);
  } else if (command === "config") {
    console.info(JSON.stringify(remoteTunnelConfig(config), null, 2));
  } else if (command === "check") {
    await checkPublicRoutes(config.publicOrigin);
  } else if (command === "start") {
    const tokenFile = resolve(root, ".local/cloudflare/token");
    if (!existsSync(tokenFile))
      throw new Error("尚未保存隧道凭证，请先运行 pnpm tunnel:token");
    if (
      config.service.startsWith("https:") &&
      !existsSync(resolve(root, ".local/tls/cert.pem"))
    )
      throw new Error("缺少本地证书，请先运行 pnpm setup:local");
    const env = { ...process.env };
    delete env.TUNNEL_TOKEN;
    delete env.TUNNEL_TOKEN_FILE;
    const child = spawn(
      "cloudflared",
      [
        "tunnel",
        "--no-autoupdate",
        "--metrics",
        "127.0.0.1:0",
        "run",
        "--token-file",
        tokenFile,
        config.tunnelId,
      ],
      { cwd: root, env, stdio: "inherit" },
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => child.kill(signal));
    child.once("error", () => {
      console.error("无法启动 cloudflared，请确认已安装。");
      process.exitCode = 1;
    });
    child.once("exit", (code) => {
      process.exitCode = code ?? 0;
    });
  } else
    throw new Error(
      "用法：node scripts/cloudflare.mjs [start|token|token-ui|config|check]",
    );
}
if (process.argv[1] === import.meta.filename) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
