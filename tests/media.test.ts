import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions, request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { MediaStore } from "../server/media.ts";

function downloadFixture(statusCode = 200) {
  const urls: string[] = [];
  const transport = ((
    url: URL,
    options: RequestOptions,
    receive: (response: IncomingMessage) => void,
  ) => {
    urls.push(url.href);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(
      options.lookup,
      undefined,
      "DNS must use the normal system network stack",
    );
    assert.equal(options.host, undefined);
    assert.equal(options.hostname, undefined);
    const outgoing = new EventEmitter() as ClientRequest;
    outgoing.end = (() => {
      queueMicrotask(() => {
        const response = new PassThrough() as unknown as IncomingMessage;
        response.statusCode = statusCode;
        response.headers = { "content-type": "image/png" };
        receive(response);
        (response as unknown as PassThrough).end(
          Buffer.from("isolated image bytes"),
        );
        outgoing.emit("close");
      });
      return outgoing;
    }) as typeof outgoing.end;
    return outgoing;
  }) as typeof request;
  return { transport, urls };
}

test("trusted result URLs download from changing CDN hosts without domain lists or DNS overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rhino-media-"));
  const fixture = downloadFixture();
  const media = new MediaStore(directory, fixture.transport);
  try {
    const urls = [
      "https://cdn.example/one.png",
      "https://new-storage.example/two.png?signature=fixture-only",
    ];
    for (const [index, url] of urls.entries()) {
      const saved = await media.save(url, `fixture-${index}`, "IMAGE");
      assert.equal(saved.contentType, "image/png");
      assert.equal(
        await readFile(join(directory, saved.id), "utf8"),
        "isolated image bytes",
      );
    }
    assert.deepEqual(fixture.urls, urls);
    assert.equal(
      (await readdir(directory)).filter((name) => name.endsWith(".part"))
        .length,
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("media still requires HTTPS and never treats a failed download as a saved file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rhino-media-"));
  const fixture = downloadFixture(404);
  const media = new MediaStore(directory, fixture.transport);
  try {
    await assert.rejects(
      () => media.save("http://cdn.example/image.png", "insecure", "IMAGE"),
      /HTTPS/,
    );
    assert.equal(fixture.urls.length, 0);
    await assert.rejects(
      () => media.save("https://new-cdn.example/image.png", "missing", "IMAGE"),
      /结果文件不可用/,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
