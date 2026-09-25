import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MerchantClient } from "../server/merchant.ts";
import { ResultService } from "../server/results.ts";
import { Store } from "../server/store.ts";
import type { MerchantEvent } from "../shared/types.ts";

function event(sdk = false): MerchantEvent {
  return {
    eventId: randomUUID(),
    eventVersion: "merchant-events/v1",
    externalUserId: "demo-user-a",
    occurredAt: new Date().toISOString(),
    eventType: sdk ? "generation.finished" : "task.status_changed",
    data: sdk
      ? {
          requestChannel: "SDK",
          submissionNo: `GS${randomUUID()}`,
          clientRequestId: randomUUID(),
          status: "SUCCEEDED",
        }
      : {},
  };
}
function platform(events: MerchantEvent[], count: { pages: number }) {
  return new MerchantClient(
    "https://synthetic.invalid",
    "synthetic-key",
    async (input, options) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/events")) {
        count.pages++;
        assert.equal(url.searchParams.get("limit"), "20");
        const cursor = url.searchParams.get("cursor"),
          index = cursor
            ? events.findIndex((item) => item.eventId === cursor)
            : -1;
        if (cursor) assert(index >= 0);
        const items = events.slice(index + 1, index + 21);
        return Response.json({
          code: 0,
          data: {
            items,
            nextCursor: items.at(-1)?.eventId ?? cursor,
            hasMore: index + 21 < events.length,
          },
        });
      }
      assert.equal(options?.method, "GET");
      const item = events.find((item) =>
        url.pathname.endsWith(`/${item.data.submissionNo}`),
      );
      assert(item);
      return Response.json({
        code: 0,
        data: {
          ...item.data,
          terminal: true,
          tasks: [
            {
              role: "OUTPUT",
              results: [
                {
                  type: "IMAGE",
                  available: true,
                  url: "https://synthetic.invalid/file",
                },
              ],
            },
          ],
        },
      });
    },
  );
}
const file = {
  id: "a".repeat(64),
  name: "fixture.png",
  contentType: "image/png",
  bytes: 1,
};

test("SDK scan resumes past 2000 unrelated events after restart without acknowledging skipped events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rhino-sdk-scan-")),
    database = join(directory, "test.sqlite");
  let store = new Store(database);
  const events = Array.from({ length: 2000 }, () => event()),
    target = event(true),
    count = { pages: 0 };
  events.push(target);
  const api = platform(events, count),
    media = { save: async () => file };
  try {
    let service = new ResultService(store, api, media);
    await assert.rejects(
      () => service.sdk(store.user("demo-a"), target.eventId),
      /扫描进度已保存/,
    );
    assert.equal(count.pages, 100);
    assert.equal(store.sdkScanCursor("demo-a"), events[1999].eventId);
    assert.equal(store.cursor("demo-a"), undefined);
    assert.equal(store.apiEventCursor("demo-a"), undefined);
    assert.equal(store.results("demo-a").length, 0);
    store.close();
    store = new Store(database);
    service = new ResultService(store, api, media);
    const saved = await service.sdk(store.user("demo-a"), target.eventId);
    assert.equal(count.pages, 101);
    assert.equal(saved.reference, target.eventId);
    assert.equal(store.sdkScanCursor("demo-a"), target.eventId);
    assert.equal(store.cursor("demo-a"), target.eventId);
    assert.equal(store.apiEventCursor("demo-a"), undefined);
    await service.sdk(store.user("demo-a"), target.eventId);
    assert.equal(count.pages, 101);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SDK scanning cannot skip an earlier result and cannot advance through a failed media save", async () => {
  const store = new Store(":memory:"),
    first = event(true),
    second = event(true);
  let failed = true;
  const service = new ResultService(
    store,
    platform([event(), first, second], { pages: 0 }),
    {
      save: async () => {
        if (failed) throw new Error("synthetic download failure");
        return file;
      },
    },
  );
  try {
    const user = store.user("demo-a");
    await assert.rejects(() => service.sdk(user, second.eventId), /更早/);
    assert.equal(store.sdkScanCursor(user.id), undefined);
    await assert.rejects(() => service.sdk(user, first.eventId), /download/);
    assert.equal(store.sdkScanCursor(user.id), undefined);
    assert.equal(store.cursor(user.id), undefined);
    failed = false;
    await service.sdk(user, first.eventId);
    await service.sdk(user, second.eventId);
    assert.equal(store.results(user.id).length, 2);
    assert.equal(store.cursor(user.id), second.eventId);
  } finally {
    store.close();
  }
});

test("different SDK callbacks for one user serialize so a slow first save cannot roll back the cursor", async () => {
  const store = new Store(":memory:"),
    first = event(true),
    second = event(true),
    count = { pages: 0 };
  let release!: () => void, saving!: () => void;
  const blocked = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      saving = resolve;
    });
  let downloads = 0;
  const service = new ResultService(store, platform([first, second], count), {
    save: async () => {
      if (++downloads === 1) {
        saving();
        await blocked;
      }
      return file;
    },
  });
  try {
    const a = service.sdk(store.user("demo-a"), first.eventId);
    await started;
    const b = service.sdk(store.user("demo-a"), second.eventId);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(count.pages, 1);
    release();
    await Promise.all([a, b]);
    assert.equal(store.cursor("demo-a"), second.eventId);
    assert.equal(store.sdkScanCursor("demo-a"), second.eventId);
    assert.equal(store.results("demo-a").length, 2);
  } finally {
    release();
    store.close();
  }
});

test("SDK result, processed event and both cursors roll back together on persistence failure", async () => {
  const store = new Store(":memory:"),
    target = event(true);
  const service = new ResultService(store, platform([target], { pages: 0 }), {
    save: async () => file,
  });
  try {
    store.db.exec(
      "CREATE TRIGGER fail_sdk_cursor BEFORE INSERT ON sdk_scan_cursors BEGIN SELECT RAISE(ABORT,'scan cursor failed'); END",
    );
    await assert.rejects(
      () => service.sdk(store.user("demo-a"), target.eventId),
      /scan cursor failed/,
    );
    assert.equal(store.results("demo-a").length, 0);
    assert.equal(store.cursor("demo-a"), undefined);
    assert.equal(store.sdkScanCursor("demo-a"), undefined);
    assert.equal(store.processed(target.eventId, "demo-a"), false);
    store.db.exec("DROP TRIGGER fail_sdk_cursor");
    await service.sdk(store.user("demo-a"), target.eventId);
    assert.equal(store.cursor("demo-a"), target.eventId);
  } finally {
    store.close();
  }
});
