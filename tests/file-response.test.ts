import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { httpsHostOrigin, sdkApiOrigin } from "../server/config.ts";
import { createHandler } from "../server/http.ts";
import { MerchantClient } from "../server/merchant.ts";
import { Operations } from "../server/operations.ts";
import { ResultService } from "../server/results.ts";
import { Store } from "../server/store.ts";

test("private media supports browser byte ranges and HEAD without bypassing ownership", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "rhino-file-http-"));
  const store = new Store(":memory:");
  const api = new MerchantClient(
    "https://fixture.example",
    "test-key",
    async () => {
      throw new Error("No upstream requests allowed");
    },
  );
  const results = new ResultService(store, api, {
    async save() {
      throw new Error("No downloads allowed");
    },
  });
  const file = {
    id: "a".repeat(64),
    name: "fixture",
    contentType: "video/mp4",
    bytes: 10,
  };
  const bytes = Buffer.from("0123456789");
  await mkdir(join(dataDir, "media"));
  await writeFile(join(dataDir, "media", file.id), bytes);
  store.saveResult(store.user("demo-a"), "API", "file-test", {}, [file]);
  const handler = createHandler(
    {
      apiOrigin: "https://fixture.example",
      apiKey: "test-key",
      dataDir,
      public: {
        apiReady: true,
        callbacksReady: false,
        sdkReady: true,
        missing: [],
        hostOrigin: httpsHostOrigin,
        sdkApiOrigin,
      },
    },
    store,
    api,
    new Operations(api, store),
    results,
  );
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/files/${file.id}`;
  const cookie = `demo_session=${store.newSession("demo-a")}`;
  const get = (range?: string, extra: Record<string, string> = {}) =>
    fetch(url, {
      headers: { cookie, ...(range ? { Range: range } : {}), ...extra },
    });
  const full = await get();
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(await full.text(), bytes.toString());
  for (const [range, contentRange, body] of [
    ["bytes=0-1", "bytes 0-1/10", "01"],
    ["bytes=5-", "bytes 5-9/10", "56789"],
    ["bytes=-3", "bytes 7-9/10", "789"],
    ["bytes=8-999999999999999999999", "bytes 8-9/10", "89"],
    ["bytes=-999999999999999999999", "bytes 0-9/10", "0123456789"],
  ]) {
    const response = await get(range);
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get("content-range"), contentRange);
    assert.equal(response.headers.get("content-length"), String(body.length));
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(await response.text(), body);
  }
  for (const range of [
    "bytes=10-",
    "bytes=-0",
    "bytes=999999999999999999999-",
  ]) {
    const response = await get(range);
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), "bytes */10");
    assert.equal(await response.text(), "");
  }
  for (const range of ["bytes=9-1", "items=0-1", "bytes=-", "bytes=0-1,5-6"]) {
    const response = await get(range);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), bytes.toString());
  }
  const conditional = await get("bytes=0-1", { "If-Range": '"unknown"' });
  assert.equal(conditional.status, 200);
  assert.equal(await conditional.text(), bytes.toString());
  const head = await fetch(url, {
    method: "HEAD",
    headers: { cookie, Range: "bytes=0-1" },
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(head.headers.get("content-range"), null);
  assert.equal(await head.text(), "");
  for (const method of ["GET", "HEAD"]) {
    const anonymous = await fetch(url, {
      method,
      headers: { Range: "bytes=0-1" },
    });
    assert.equal(anonymous.status, 401);
    await anonymous.arrayBuffer();
    const other = await fetch(url, {
      method,
      headers: {
        cookie: `demo_session=${store.newSession("demo-b")}`,
        Range: "bytes=0-1",
      },
    });
    assert.equal(other.status, 404);
    assert.equal(other.headers.get("content-range"), null);
    await other.arrayBuffer();
  }
  const switched = await get("bytes=0-1", { "X-Demo-User": "demo-b" });
  assert.equal(switched.status, 409);
  await switched.arrayBuffer();
});
