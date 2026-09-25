import type { MerchantVersion } from "../shared/sdk-release.ts";
import { AppError } from "./errors.ts";

export type MerchantAuth = { version?: MerchantVersion; accessKey?: string };
export const validAccessKey = (value: string) =>
  /^ak-[a-f0-9]{32}$/.test(value);
export const validSecretKey = (value: string) =>
  /^sk-[A-Za-z0-9_-]{43}$/.test(value);
export function merchantHeaders(key: string, auth: MerchantAuth = {}) {
  const version = auth.version ?? "0.3.0";
  if (version !== "0.3.0" && version !== "0.4.0")
    throw new AppError(400, "不支持的商户协议版本");
  if (version === "0.3.0" && auth.accessKey)
    throw new AppError(400, "AK 必须配合显式 0.4.0 协议使用");
  if (version === "0.4.0" && !validAccessKey(auth.accessKey || ""))
    throw new AppError(
      400,
      "请配置完整商户 AK（ak- 加 32 位小写十六进制字符）",
    );
  if (!key)
    throw new AppError(
      503,
      "请在本项目 .env.local填写 BLACK_RHINO_API_KEY 并重启示例",
    );
  return {
    Authorization: `Bearer ${key}`,
    ...(version === "0.4.0"
      ? {
          "X-Merchant-Version": version,
          "X-Merchant-AK": auth.accessKey as string,
        }
      : {}),
  };
}
