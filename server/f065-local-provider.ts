import type { Config } from "./config.ts";
import { resolveF065Config } from "./f065-local.ts";

export const f065LocalTarget = Object.freeze({
  merchantId: "5feeb49b-8ee3-444a-baaf-79a06f97765d",
  siteId: 1,
  memberId: "1",
  apiOrigin: "https://localhost:18080",
  hostOrigin: "https://127.0.0.1:3443",
  frameOrigin: "https://localhost:18080",
  sdkVersion: "0.4.0",
  sourceCommit: "cf6a5246b3b97dd9039b3af0f29b96e0587f4381",
  sdkSha256: "ccb7870a2218d8ef6800d5890f54bbb9f5fbdd0a61a58ec709ee1b1e4e78ecf3",
});

export type F065LocalMerchantSource = {
  kind: "verified-local-merchant";
  merchantId: string;
  siteId: number;
  memberId: string;
  apiOrigin: string;
  hostOrigin: string;
  frameOrigin: string;
};

export function provideF065LocalConfig(input: {
  merchantSource: F065LocalMerchantSource;
  sdkFile: string;
  directory: string;
}) {
  const source = input.merchantSource;
  // 只绑定已核实的本地归属和完整HTTPS链路；元数据不是凭据认证或启用授权。
  if (
    source?.kind !== "verified-local-merchant" ||
    source.merchantId !== f065LocalTarget.merchantId ||
    source.siteId !== f065LocalTarget.siteId ||
    source.memberId !== f065LocalTarget.memberId ||
    source.apiOrigin !== f065LocalTarget.apiOrigin ||
    source.hostOrigin !== f065LocalTarget.hostOrigin ||
    source.frameOrigin !== f065LocalTarget.frameOrigin
  )
    throw new Error("F065配置来源必须是已核实的指定本地商户及HTTPS目标");
  // 不加载env、隧道或凭据；沿既有关闭态返回，不能凭配置元数据打开真实iframe。
  return resolveF065Config({
    apiOrigin: f065LocalTarget.apiOrigin,
    hostOrigin: f065LocalTarget.hostOrigin,
    sdkFile: input.sdkFile,
    sdkSha256: f065LocalTarget.sdkSha256,
    directory: input.directory,
  });
}

export const f065EnvTarget = Object.freeze({
  merchantId: "7278d144-0102-49c9-b617-223011d7fcf8",
  siteId: 1,
  memberId: "11",
  apiOrigin: "http://localhost:18080",
  hostOrigin: "https://rhino-demo.laotangcode.shop",
  listenOrigin: "http://127.0.0.1:3443",
  frameOrigin: "https://rhino-platform.laotangcode.shop",
  sdkSha256: "d854521c49d556f7dc3fe0ea8a9e232eb8f17a78be93aa67ce4547fed3d50d89",
});

export function provideF065EnvConfig(input: {
  loadedConfig: Config;
  sdkFile: string;
  directory: string;
}): Config {
  const loaded = input.loadedConfig;
  // 复用应用内部env加载；固定已核本地API和原tunnel，不接受线上回退或任意宿主。
  if (
    loaded.public.hostOrigin !== f065EnvTarget.hostOrigin ||
    loaded.listenOrigin !== f065EnvTarget.listenOrigin ||
    !loaded.public.apiReady ||
    !loaded.apiKey ||
    !loaded.accessKey
  )
    throw new Error("本地env模式需要已核实的凭据及原tunnel HTTP回源");
  const config = resolveF065Config({
    apiOrigin: f065LocalTarget.apiOrigin,
    hostOrigin: f065LocalTarget.hostOrigin,
    sdkFile: input.sdkFile,
    sdkSha256: f065EnvTarget.sdkSha256,
    browserApiOrigin: f065EnvTarget.frameOrigin,
    directory: input.directory,
  });
  return {
    ...config,
    apiOrigin: f065EnvTarget.apiOrigin,
    apiKey: loaded.apiKey,
    accessKey: loaded.accessKey,
    listenOrigin: f065EnvTarget.listenOrigin,
    public: {
      ...config.public,
      apiOrigin: f065EnvTarget.apiOrigin,
      hostOrigin: f065EnvTarget.hostOrigin,
      apiReady: true,
      missing: [],
      configurationIssues: [
        "F065本地无付费验收；事件同步、回调及生成批准已禁用。",
      ],
    },
  };
}
