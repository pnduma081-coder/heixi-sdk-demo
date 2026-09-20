import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";

test("dev watch stays running after Vite startup and restarts once for a source edit", {
  timeout: 20000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "black-rhino-dev-watch-test-"));
  const source = join(directory, "source.mjs"),
    entry = join(directory, "entry.mjs");
  writeFileSync(source, 'export const version = "first";\n');
  // 只启动真实的 Vite 初始化流程，不监听应用端口、不读取环境文件或 SQLite。
  writeFileSync(
    entry,
    `
import { createServer } from "node:https";
import { createFrontendServer } from ${JSON.stringify(new URL("../server/index.ts", import.meta.url).href)};
import { version } from "./source.mjs";
const server = await createFrontendServer(createServer());
for (const path of ["/src/main.ts", "/src/App.vue", "/src/SdkPanel.vue", "/src/ApiPanel.vue"]) {
  const result = await server.transformRequest(path);
  if (!result?.code) throw new Error("Frontend module did not compile: " + path);
}
console.log("WATCH_READY:" + version);
setInterval(() => {}, 1000);
process.on("SIGTERM", () => { void server.close().then(() => process.exit(0)); });
`,
  );
  const child = spawn(
    process.execPath,
    ["--watch", "--watch-preserve-output", entry],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (part) => {
    output += part;
  });
  child.stderr.on("data", (part) => {
    output += part;
  });
  const exited = once(child, "exit");
  const count = () => (output.match(/WATCH_READY:/g) || []).length;
  async function waitForMarker(marker: string) {
    const until = Date.now() + 7000;
    while (
      !output.includes(marker) &&
      Date.now() < until &&
      child.exitCode === null
    )
      await pause(50);
    assert.ok(
      output.includes(marker),
      output || "watch process did not become ready",
    );
  }
  try {
    await waitForMarker("WATCH_READY:first");
    await pause(1500);
    assert.equal(
      count(),
      1,
      `Vite startup must not restart its host:\n${output}`,
    );
    writeFileSync(source, 'export const version = "second";\n');
    await waitForMarker("WATCH_READY:second");
    await pause(1500);
    assert.equal(
      count(),
      2,
      `Source edit must trigger exactly one restart:\n${output}`,
    );
    assert.equal(child.exitCode, null, "watch process must still be running");
  } finally {
    child.kill("SIGTERM");
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
