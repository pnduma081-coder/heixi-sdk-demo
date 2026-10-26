import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { localSdkPath } from "../shared/sdk-release.ts";
import type { Config } from "./config.ts";

export function loopbackOrigin(value: string) {
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    throw new Error("本地平台和宿主必须使用精确 loopback origin");
  return url.origin;
}

export function resolveF065Config(input: {
  apiOrigin: string;
  hostOrigin: string;
  sdkFile: string;
  sdkSha256: string;
  directory: string;
  browserApiOrigin?: string;
}): Config {
  const apiOrigin = loopbackOrigin(input.apiOrigin);
  const hostOrigin = loopbackOrigin(input.hostOrigin);
  const browserApiOrigin = input.browserApiOrigin ?? apiOrigin;
  // 公网增量仅绑定已批准且回源本机的平台域名，不放开任意上游或线上回退。
  if (
    browserApiOrigin !== apiOrigin &&
    browserApiOrigin !== "https://rhino-platform.laotangcode.shop"
  )
    throw new Error("浏览器平台必须使用精确批准的本地tunnel入口");
  if (apiOrigin === hostOrigin) throw new Error("平台与宿主不能使用同一入口");
  if (!/^[a-f0-9]{64}$/.test(input.sdkSha256))
    throw new Error("需要明确 SDK SHA256");
  const bytes = readFileSync(input.sdkFile);
  if (
    bytes.length > 2 * 1024 * 1024 ||
    createHash("sha256").update(bytes).digest("hex") !== input.sdkSha256
  )
    throw new Error("SDK 制品校验失败");
  if (!bytes.toString("utf8").includes(JSON.stringify(browserApiOrigin)))
    throw new Error("SDK 制品未绑定所选本地平台");
  // 专用入口不加载线上配置或凭据；真实会话接入须单独核验本地商户身份。
  return {
    apiOrigin,
    apiKey: "",
    accessKey: "",
    listenOrigin: hostOrigin,
    dataDir: resolve(input.directory),
    localSdk: { bytes, sha256: input.sdkSha256 },
    public: {
      sdkMode: "f065-local",
      sdkVersion: "0.4.0",
      sdkScriptUrl: localSdkPath,
      apiOrigin,
      sdkApiOrigin: browserApiOrigin,
      hostOrigin,
      apiReady: false,
      callbacksReady: false,
      sdkReady: true,
      missing: ["F065_LOCAL_MERCHANT_SESSION"],
      configurationIssues: ["本地 0.4 只读验收；未接入商户会话，不提交生成。"],
    },
  };
}

export function localReadTransport(
  origin: string,
  transport: typeof fetch,
  creditsEnabled = false,
): typeof fetch {
  const target = loopbackOrigin(origin);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    // 仅显式本地算力验收允许领取该topic密钥；其它写操作及事件同步仍拒绝。
    if (
      url.origin !== target ||
      url.username ||
      url.password ||
      init?.redirect !== "error" ||
      !(
        (method === "GET" &&
          ["/api/v1/open/models", "/api/v1/open/configs"].includes(
            url.pathname,
          )) ||
        (method === "POST" && url.pathname === "/api/v1/open/sdk/signature") ||
        (creditsEnabled &&
          method === "POST" &&
          url.pathname === "/api/v1/open/webhooks/credits/signing-key" &&
          !url.search)
      )
    )
      throw new Error("本地验收拒绝外部地址或非只读请求");
    return transport(input, init);
  };
}
