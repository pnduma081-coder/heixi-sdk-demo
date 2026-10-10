import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readTunnelConfig } from "./cloudflare.mjs";

const root = resolve(import.meta.dirname, "..");

function stopChild(child, signal) {
  try {
    // 独立进程组仅包含本命令创建的进程，包括 watch 和 cloudflared 的子进程。
    if (process.platform === "win32") child.kill(signal);
    else if (child.pid) process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

export function runTogether(
  commands,
  { spawnProcess = spawn, signals = process, stopProcess = stopChild } = {},
) {
  return new Promise((resolveDone) => {
    const children = new Set();
    let stopping = false,
      exitCode = 0,
      timer;
    const finish = () => {
      if (!stopping || children.size) return;
      clearTimeout(timer);
      signals.off("SIGINT", interrupt);
      signals.off("SIGTERM", terminate);
      resolveDone(exitCode);
    };
    const stop = (code) => {
      if (stopping) return;
      stopping = true;
      exitCode = code;
      for (const child of children) stopProcess(child, "SIGTERM");
      timer = setTimeout(() => {
        for (const child of children) stopProcess(child, "SIGKILL");
      }, 5000);
      timer.unref();
      finish();
    };
    const interrupt = () => stop(130);
    const terminate = () => stop(143);
    signals.on("SIGINT", interrupt);
    signals.on("SIGTERM", terminate);
    for (const args of commands) {
      try {
        const child = spawnProcess(process.execPath, args, {
          cwd: root,
          stdio: "inherit",
          detached: process.platform !== "win32",
        });
        children.add(child);
        child.once("error", (error) => {
          console.error(`启动失败：${error.message}`);
          stop(1);
        });
        child.once("close", (code) => {
          children.delete(child);
          // 任一进程退出时收起另一进程，避免只留下隧道或服务。
          stop(code ?? 1);
          finish();
        });
      } catch (error) {
        console.error(`启动失败：${error.message}`);
        stop(1);
        break;
      }
    }
  });
}

if (process.argv[1] === import.meta.filename) {
  try {
    const config = readTunnelConfig();
    if (config.service !== "http://127.0.0.1:3443")
      throw new Error(
        "dev:tunnel 使用 HTTP 回源，请先将隧道 service 配置为 http://127.0.0.1:3443，并同步核对 Cloudflare 控制台路由。",
      );
    if (!existsSync(resolve(root, ".local/cloudflare/token")))
      throw new Error("尚未保存隧道凭证，请先运行 pnpm tunnel:token");
    console.info("启动 HTTP 开发服务和隧道；按 Ctrl+C 一并停止。");
    process.exitCode = await runTogether([
      ["--disable-warning=ExperimentalWarning", "--watch", "server/index.ts"],
      ["scripts/cloudflare.mjs", "start"],
    ]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
