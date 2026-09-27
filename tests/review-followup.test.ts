import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppError, resultSaveError } from "../server/errors.ts";
import { EventInbox } from "../server/event-inbox.ts";
import { EventSyncState } from "../server/event-sync-state.ts";
import { MerchantClient } from "../server/merchant.ts";
import { Operations } from "../server/operations.ts";
import { Store } from "../server/store.ts";
import { requestStatusLabel } from "../src/request-status.ts";

const auth = { version: "0.4.0", accessKey: `ak-${"a".repeat(32)}` } as const;
const refused = () =>
  Response.json({ code: 40910, message: "rejected" }, { status: 409 });

test("local validation and explicit rejection are not active, while a quote read failure never claims a submitted approval", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const client = new MerchantClient(
    "https://fixture.invalid",
    "fixture",
    async () => {
      calls++;
      return refused();
    },
    auth,
  );
  const ops = new Operations(client, store),
    user = store.user("demo-a"),
    sync = new EventSyncState(store);
  try {
    await assert.rejects(() =>
      ops.call(user, "design", {
        clientRequestId: "local",
        contentLanguage: "NONE",
      }),
    );
    assert.equal(calls, 0);
    assert.equal(store.requests(user.id)[0].status, "NOT_SENT");
    assert.equal(sync.active(user.id), false);
    assert.deepEqual(sync.users(), []);
    await assert.rejects(() =>
      ops.call(user, "design", {
        clientRequestId: "rejected",
        contentLanguage: "zh-CN",
      }),
    );
    assert.equal(store.requests(user.id)[0].status, "REJECTED");
    assert.equal(sync.active(user.id), false);
    assert.deepEqual(sync.users(), []);
    await assert.rejects(() =>
      ops.approve(user, {
        quoteId: randomUUID(),
        clientRequestId: "quote-read",
      }),
    );
    assert.equal(store.requests(user.id)[0].status, "NOT_SENT");
    assert.equal(calls, 2);
    assert.equal(sync.active(user.id), false);
    assert.equal(requestStatusLabel("NOT_SENT"), "未发送");
    assert.equal(requestStatusLabel("REJECTED"), "已拒绝");
  } finally {
    store.close();
  }
});

test("lost response survives restart and a later explicit rejection; accepted response remains recoverable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rhino-attempts-"));
  let store = new Store(join(directory, "test.sqlite"));
  let mode = "offline";
  const client = new MerchantClient(
    "https://fixture.invalid",
    "fixture",
    async () => {
      if (mode === "offline") throw new Error("lost response");
      if (mode === "reject") return refused();
      return Response.json({ code: 0, data: { submissionNo: "GS-one" } });
    },
    auth,
  );
  const body = { clientRequestId: "same", contentLanguage: "zh-CN" };
  try {
    await assert.rejects(() =>
      new Operations(client, store).call(store.user("demo-a"), "design", body),
    );
    assert.equal(store.requests("demo-a")[0].status, "UNCONFIRMED");
    store.close();
    store = new Store(join(directory, "test.sqlite"));
    mode = "reject";
    await assert.rejects(() =>
      new Operations(client, store).call(store.user("demo-a"), "design", body),
    );
    assert.equal(store.requests("demo-a")[0].status, "UNCONFIRMED");
    mode = "ok";
    const result = await new Operations(client, store).call(
      store.user("demo-a"),
      "design",
      body,
    );
    mode = "offline";
    assert.deepEqual(
      await new Operations(client, store).call(
        store.user("demo-a"),
        "design",
        body,
      ),
      result,
    );
    assert.equal(store.requests("demo-a")[0].status, "ACCEPTED");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejection from another connection cannot erase an in-flight attempt or an old unconfirmed record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rhino-attempt-race-"));
  const store = new Store(join(directory, "test.sqlite"));
  store.startRequest("demo-a", "old", "design", { clientRequestId: "old" });
  store.finishRequest("demo-a", "old", undefined, "UNCONFIRMED");
  const other = new Store(join(directory, "test.sqlite"));
  let release!: () => void;
  const client = new MerchantClient(
    "https://fixture.invalid",
    "fixture",
    async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error("unknown");
    },
    auth,
  );
  const reject = new MerchantClient(
    "https://fixture.invalid",
    "fixture",
    async () => refused(),
    auth,
  );
  try {
    await assert.rejects(() =>
      new Operations(reject, other).call(other.user("demo-a"), "design", {
        clientRequestId: "old",
      }),
    );
    assert.equal(store.requests("demo-a")[0].status, "UNCONFIRMED");
    const first = new Operations(client, store).call(
      store.user("demo-a"),
      "design",
      { clientRequestId: "race" },
    );
    const settled = assert.rejects(first);
    await assert.rejects(() =>
      new Operations(reject, other).call(other.user("demo-a"), "design", {
        clientRequestId: "race",
      }),
    );
    assert.equal(store.requests("demo-a")[0].status, "UNCONFIRMED");
    release();
    await settled;
    assert.equal(store.requests("demo-a")[0].status, "UNCONFIRMED");
  } finally {
    store.close();
    other.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid events pause durably, retain original payload and retry manually with a fresh bounded cycle", () => {
  const directory = mkdtempSync(join(tmpdir(), "rhino-paused-inbox-"));
  let store = new Store(join(directory, "test.sqlite"));
  try {
    let inbox = new EventInbox(store);
    const user = store.user("demo-a"),
      key = randomUUID();
    const raw = {
      eventId: key,
      externalUserId: user.externalUserId,
      eventType: "future",
    };
    inbox.receive(user, [raw], key);
    for (let i = 0; i < 3; i++) {
      const due = inbox.due(user.id, (i + 1) * 300000);
      assert.equal(due.length, 1);
      inbox.failed(
        user.id,
        key,
        due[0].attempts,
        (i + 1) * 300000,
        new AppError(400, "bad format"),
      );
    }
    assert.equal(inbox.pending(user.id), 0);
    assert.equal(inbox.paused(user.id), 1);
    assert.deepEqual(inbox.due(user.id, Number.MAX_SAFE_INTEGER), []);
    assert.equal(inbox.diagnostics(user.id)[0].nextAttemptAt, null);
    store.close();
    store = new Store(join(directory, "test.sqlite"));
    inbox = new EventInbox(store);
    assert.equal(inbox.paused(user.id), 1);
    inbox.retry("demo-b");
    assert.equal(inbox.paused(user.id), 1);
    inbox.retry(user.id);
    assert.deepEqual(inbox.due(user.id, Number.MAX_SAFE_INTEGER)[0].value, raw);
    inbox.failed(user.id, key, 3, 0, new AppError(400, "still bad"));
    assert.equal(inbox.pending(user.id), 1);
    assert.equal(inbox.diagnostics(user.id)[0].attempts, 4);
    inbox.complete(user.id, key);
    assert.deepEqual(inbox.diagnostics(user.id), []);
    assert.equal(store.apiEventCursor(user.id), key);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persistent media failures also have a finite retry budget without pretending the event succeeded", () => {
  const store = new Store(":memory:");
  try {
    const inbox = new EventInbox(store),
      user = store.user("demo-a"),
      key = randomUUID();
    inbox.receive(user, [{ eventId: key }], key);
    for (let i = 0; i < 8; i++)
      inbox.failed(
        user.id,
        key,
        i,
        i * 300000,
        resultSaveError(502, "download failed"),
      );
    assert.equal(inbox.paused(user.id), 1);
    assert.equal(inbox.diagnostics(user.id)[0].attempts, 8);
    assert.equal(store.processed(key, user.id), false);
  } finally {
    store.close();
  }
});
