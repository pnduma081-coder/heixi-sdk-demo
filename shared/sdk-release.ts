export const onlineApiOrigin = "https://api.heixi.com";
export const onlineSdkVersion = "0.4.0";
export const documentationVersions = ["0.4.0", "0.3.0"] as const;
export type MerchantVersion = (typeof documentationVersions)[number];
export const onlineSdkUrl =
  "https://cdn.heixi.com/online/merchant-sdk/0.4.0/black-rhino-sdk.iife.js";
export function sdkDocs(version: MerchantVersion = onlineSdkVersion) {
  if (!documentationVersions.includes(version))
    throw new Error("不支持的文档版本");
  const base = `https://cdn.heixi.com/online/merchant-sdk/docs/${version}`;
  return {
    sdkDocsUrl: `${base}/sdk.html`,
    apiDocsUrl: `${base}/api.html`,
    sdkMarkdownUrl: `${base}/sdk.md`,
    apiMarkdownUrl: `${base}/api.md`,
    openApiUrl: `${base}/openapi.json`,
  };
}
