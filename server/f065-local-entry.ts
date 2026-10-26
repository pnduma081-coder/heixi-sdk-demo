import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { resolveF065Config } from "./f065-local.ts";
import { provideF065EnvConfig } from "./f065-local-provider.ts";
import { startDemo } from "./index.ts";

const args = process.argv.slice(2);
const values = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const key = args[i],
    value = args[i + 1];
  if (
    ![
      "--local-env",
      "--credits-callback",
      "--api-origin",
      "--sdk-file",
      "--sdk-sha256",
      "--host-origin",
      "--tls-dir",
    ].includes(key) ||
    !value ||
    values.has(key)
  )
    throw new Error("本地入口参数无效，不使用默认平台或 SDK");
  values.set(key, value);
}
function required(key: string) {
  const value = values.get(key);
  if (!value) throw new Error(`缺少 ${key}`);
  return value;
}
const directory = mkdtempSync(join(tmpdir(), "black-rhino-f065-host-"));
try {
  const localEnv = values.get("--local-env");
  if (
    localEnv &&
    (localEnv !== "true" ||
      [...values.keys()].some(
        (key) =>
          !["--local-env", "--sdk-file", "--credits-callback"].includes(key),
      ))
  )
    throw new Error("本地env模式仅允许 --local-env true --sdk-file 固定制品");
  const credits = values.get("--credits-callback");
  if (credits && (!localEnv || credits !== "enabled"))
    throw new Error("credits开关仅允许本地env模式显式enabled");
  const config = localEnv
    ? provideF065EnvConfig({
        loadedConfig: loadConfig(),
        sdkFile: required("--sdk-file"),
        directory,
      })
    : resolveF065Config({
        apiOrigin: required("--api-origin"),
        hostOrigin: required("--host-origin"),
        sdkFile: required("--sdk-file"),
        sdkSha256: required("--sdk-sha256"),
        directory,
      });
  config.localCreditsEnabled = credits === "enabled";
  if (config.localCreditsEnabled) {
    config.public.callbacksReady = true;
    config.public.configurationIssues = [
      "本地算力回调验收；生成批准、提交及事件同步仍禁用。",
    ];
  }
  if (
    (config.listenOrigin || config.public.hostOrigin).startsWith("https:") &&
    !values.has("--tls-dir")
  )
    throw new Error("HTTPS 入口需要已受信任的本机证书目录");
  const server = await startDemo(config, values.get("--tls-dir"));
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void server.stop().then(() => {
        rmSync(directory, { recursive: true });
        process.exit(0);
      });
    });
} catch (error) {
  rmSync(directory, { recursive: true });
  throw error;
}
