import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  onlineApiOrigin,
  onlineSdkUrl,
  onlineSdkVersion,
  sdkDocs,
} from "../shared/sdk-release.ts";
import type { DemoConfig } from "../shared/types.ts";
import { validAccessKey, validSecretKey } from "./merchant-auth.ts";

export const root = resolve(import.meta.dirname, "..");
export const hostOrigin = "http://127.0.0.1:3443";
export const httpsHostOrigin = "https://127.0.0.1:3443";
export const sdkApiOrigin = onlineApiOrigin;
export type Config = {
  apiOrigin: string;
  apiKey: string;
  accessKey?: string;
  public: DemoConfig;
  dataDir: string;
  listenOrigin?: string;
};

function exactOrigin(value: string, name: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} 必须是精确 origin`);
  }
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error(
      `${name} 必须是精确 HTTP(S) origin，不能含路径、凭证或末尾斜杠`,
    );
  return url;
}

// 纯配置解析：合成测试只传显式环境值，不读取真实配置、凭证或运行数据。
export function resolveConfig({
  https = false,
  env = {},
  callbackOrigin,
  appOrigin,
  directory = root,
}: {
  https?: boolean;
  env?: Record<string, string | undefined>;
  callbackOrigin?: string;
  appOrigin?: string;
  directory?: string;
} = {}): Config {
  const apiOrigin = onlineApiOrigin;
  const listenOrigin = https ? httpsHostOrigin : hostOrigin;
  if (appOrigin && exactOrigin(appOrigin, "示例代理入口").protocol !== "https:")
    throw new Error("示例代理入口必须使用 HTTPS");
  const pageOrigin = appOrigin || env.BLACK_RHINO_HOST_ORIGIN || listenOrigin;
  const pageUrl = exactOrigin(pageOrigin, "BLACK_RHINO_HOST_ORIGIN");
  if (pageOrigin !== listenOrigin && pageUrl.protocol !== "https:")
    throw new Error("自定义 SDK 宿主入口必须是 HTTPS origin");
  if (
    callbackOrigin &&
    exactOrigin(callbackOrigin, "Cloudflare 回调入口").protocol !== "https:"
  )
    throw new Error("Cloudflare 回调入口必须是 HTTPS origin");
  const missing = ["BLACK_RHINO_API_KEY", "BLACK_RHINO_ACCESS_KEY"].filter(
    (key) => !env[key],
  );
  const configurationIssues = [];
  if (pageUrl.protocol !== "https:")
    configurationIssues.push(
      "当前页面为 HTTP；SDK 需要 HTTPS 页面入口。账户和 API 调试仍可使用。",
    );
  const invalidCredentials = [];
  if (env.BLACK_RHINO_ACCESS_KEY && !validAccessKey(env.BLACK_RHINO_ACCESS_KEY))
    invalidCredentials.push(
      "BLACK_RHINO_ACCESS_KEY 格式错误：应为 ak- 加 32 位小写十六进制字符，不含空格或掩码。",
    );
  if (env.BLACK_RHINO_API_KEY && !validSecretKey(env.BLACK_RHINO_API_KEY))
    invalidCredentials.push(
      "BLACK_RHINO_API_KEY 格式错误：应为 sk- 加 43 位密钥字符，不含 Bearer、空格或掩码。",
    );
  configurationIssues.push(...invalidCredentials);
  const credentialsReady =
    missing.length === 0 && invalidCredentials.length === 0;
  const knownVariables = [
    "BLACK_RHINO_API_KEY",
    "BLACK_RHINO_ACCESS_KEY",
    "BLACK_RHINO_HOST_ORIGIN",
  ];
  const ignored = Object.keys(env).filter(
    (name) => name.startsWith("BLACK_RHINO_") && !knownVariables.includes(name),
  );
  if (ignored.length)
    configurationIssues.push(
      `以下环境变量已不再生效，可从 .env.local 删除：${ignored.join(", ")}。SDK 与 API 地址固定为 ${apiOrigin}。`,
    );
  if (!https && pageOrigin === httpsHostOrigin)
    configurationIssues.push(
      "宿主页配置为本机 HTTPS，但监听仍是 HTTP。请由用户使用 dev:https 命令启动。",
    );
  return {
    apiOrigin,
    apiKey: env.BLACK_RHINO_API_KEY || "",
    accessKey: env.BLACK_RHINO_ACCESS_KEY || "",
    listenOrigin,
    dataDir: resolve(directory, ".local"),
    public: {
      apiOrigin,
      missing,
      apiReady: credentialsReady,
      callbacksReady: credentialsReady,
      sdkReady: true,
      hostOrigin: pageOrigin,
      sdkApiOrigin,
      sdkScriptUrl: onlineSdkUrl,
      sdkVersion: onlineSdkVersion,
      ...sdkDocs(),
      configurationIssues,
      ...(callbackOrigin ? { callbackOrigin } : {}),
    },
  };
}

export function loadConfig({ https = false } = {}): Config {
  // 仅应用启动加载商户配置，不向 Vite 暴露环境变量。
  const envPath = resolve(root, ".env.local");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const tunnelPath = resolve(root, "cloudflare/tunnel.json");
  const tunnel = existsSync(tunnelPath)
    ? JSON.parse(readFileSync(tunnelPath, "utf8"))
    : undefined;
  return resolveConfig({
    https,
    env: process.env,
    callbackOrigin: tunnel?.published ? tunnel.publicOrigin : undefined,
    appOrigin: tunnel?.appPublished ? tunnel.appOrigin : undefined,
  });
}
