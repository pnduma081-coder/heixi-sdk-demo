import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SavedFile } from "../shared/types.ts";

// A single byte range covers browser video metadata and seeking requests.
// Unsupported/malformed ranges and unvalidated If-Range fall back to full GET.
function byteRange(value: string | undefined, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value?.trim() || "");
  if (!match || (!match[1] && !match[2])) return undefined;
  const length = BigInt(size);
  const first = match[1] ? BigInt(match[1]) : undefined;
  const last = match[2] ? BigInt(match[2]) : undefined;
  if (first !== undefined && last !== undefined && last < first)
    return undefined;
  if (
    !size ||
    (first !== undefined && first >= length) ||
    (last === 0n && first === undefined)
  )
    return null;
  const suffixLength = last ?? length;
  const start = first ?? (suffixLength >= length ? 0n : length - suffixLength);
  const end =
    first === undefined || last === undefined || last >= length
      ? length - 1n
      : last;
  return { start: Number(start), end: Number(end) };
}

export function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  file: SavedFile,
) {
  const range =
    req.method === "GET" && !req.headers["if-range"]
      ? byteRange(req.headers.range, file.bytes)
      : undefined;
  const headers = {
    "Content-Type": file.contentType,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  };
  if (range === null) {
    res
      .writeHead(416, {
        ...headers,
        "Content-Range": `bytes */${file.bytes}`,
        "Content-Length": 0,
      })
      .end();
    return;
  }
  res.writeHead(range ? 206 : 200, {
    ...headers,
    "Content-Length": range ? range.end - range.start + 1 : file.bytes,
    ...(range
      ? { "Content-Range": `bytes ${range.start}-${range.end}/${file.bytes}` }
      : {}),
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(path, range);
  res.on("close", () => stream.destroy());
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}
