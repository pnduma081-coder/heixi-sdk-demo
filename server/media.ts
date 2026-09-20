import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { request } from "node:https";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SavedFile } from "../shared/types.ts";
import { AppError, resultSaveError } from "./errors.ts";

export class MediaStore {
  directory: string;
  transport: typeof request;
  constructor(directory: string, transport: typeof request = request) {
    this.directory = directory;
    this.transport = transport;
  }
  async save(value: string, scope: string, type: string): Promise<SavedFile> {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password)
      throw resultSaveError(409, "结果媒体必须使用 HTTPS 地址");
    await mkdir(this.directory, { recursive: true });
    const id = createHash("sha256").update(scope).digest("hex");
    const temporary = join(this.directory, `${id}.${randomUUID()}.part`);
    let bytes = 0,
      contentType = "";
    // 信任已验签回调或平台查询提供的完整 URL，交由系统网络栈处理 DNS 和代理。
    try {
      await new Promise<void>((resolve, reject) => {
        const outgoing = this.transport(
          url,
          {
            agent: false,
            rejectUnauthorized: true,
          },
          (response) => {
            contentType = String(response.headers["content-type"] || "").split(
              ";",
            )[0];
            const allowed =
              type === "VIDEO"
                ? ["video/mp4", "video/webm", "video/quicktime"]
                : [
                    "image/png",
                    "image/jpeg",
                    "image/webp",
                    "image/gif",
                    "image/avif",
                  ];
            if (response.statusCode !== 200 || !allowed.includes(contentType)) {
              response.destroy();
              reject(resultSaveError(409, "结果文件不可用或类型不符"));
              return;
            }
            const counter = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                bytes += chunk.length;
                callback(
                  bytes > 200 * 1024 * 1024
                    ? new AppError(413, "单个结果文件超过 200 MiB")
                    : null,
                  chunk,
                );
              },
            });
            pipeline(
              response,
              counter,
              createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
            ).then(resolve, reject);
          },
        );
        const timer = setTimeout(
          () => outgoing.destroy(resultSaveError(504, "下载结果超时")),
          90_000,
        );
        outgoing.on("close", () => clearTimeout(timer));
        outgoing.on("error", reject);
        outgoing.end();
      });
      if (!bytes) throw resultSaveError(409, "结果文件为空");
      const fileHandle = await open(temporary, "r");
      try {
        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }
      await rename(temporary, join(this.directory, id));
      const directoryHandle = await open(this.directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      return {
        id,
        name: `${type.toLowerCase()}-${id.slice(0, 8)}`,
        contentType,
        bytes,
      };
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
