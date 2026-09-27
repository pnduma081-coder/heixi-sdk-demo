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
import { ResultService } from "../server/results.ts";
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

test("persistent media failures switch to hourly retry without pretending the event succeeded", () => {
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
    assert.equal(inbox.paused(user.id), 0);
    assert.equal(inbox.deferred(user.id), 1);
    assert.equal(inbox.pending(user.id), 0);
    const due = 7 * 300000 + 3600000;
    assert.equal(inbox.due(user.id, due - 1).length, 0);
    assert.equal(inbox.due(user.id, due).length, 1);
    assert.equal(
      inbox.diagnostics(user.id)[0].nextAttemptAt,
      new Date(due).toISOString(),
    );
    assert.equal(inbox.diagnostics(user.id)[0].attempts, 8);
    assert.equal(store.processed(key, user.id), false);
  } finally {
    store.close();
  }
});

test("media and storage failures automatically recover after restart at the persisted hourly deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  for (const failure of [
    resultSaveError(504, "CDN timeout"),
    new Error("temporary disk failure"),
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "rhino-hourly-retry-"));
    let store = new Store(join(directory, "test.sqlite"));
    let broken = true,
      downloads = 0;
    const eventId = randomUUID();
    const client = new MerchantClient(
      "https://fixture.invalid",
      "fixture",
      async () =>
        Response.json({ code: 0, data: { items: [], hasMore: false } }),
      auth,
    );
    const media = {
      save: async () => {
        downloads++;
        if (broken) throw failure;
        return {
          id: "a".repeat(64),
          name: "result.mp4",
          bytes: 1,
          contentType: "video/mp4",
        };
      },
    };
    try {
      let results = new ResultService(store, client, media);
      results.inbox.receive(
        store.user("demo-a"),
        [
          {
            eventId,
            eventVersion: "merchant-events/v1",
            eventType: "generation.finished",
            externalUserId: "demo-user-a",
            occurredAt: new Date().toISOString(),
            data: {
              requestChannel: "API",
              clientRequestId: "hourly-recovery",
              submissionNo: "GShourly",
              status: "SUCCEEDED",
              tasks: [
                {
                  role: "OUTPUT",
                  results: [
                    {
                      type: "VIDEO",
                      url: "https://fixture.invalid/result.mp4",
                    },
                  ],
                },
              ],
            },
          },
        ],
        eventId,
      );
      for (let i = 0; i < 8; i++) {
        if (i)
          t.mock.timers.setTime(
            Date.parse(
              results.inbox.diagnostics("demo-a")[0].nextAttemptAt || "",
            ),
          );
        const report = await results.syncEvents(store.user("demo-a"));
        assert.equal(report.pending, i === 7 ? 0 : 1);
      }
      assert.equal(downloads, 8);
      assert.match(results.syncIssue("demo-a") || "", /每小时自动重试/);
      const due = Date.parse(
        results.inbox.diagnostics("demo-a")[0].nextAttemptAt || "",
      );
      assert.equal(due - Date.now(), 3600000);
      store.close();
      store = new Store(join(directory, "test.sqlite"));
      results = new ResultService(store, client, media);
      t.mock.timers.setTime(due - 1);
      await results.syncEvents(store.user("demo-a"));
      assert.equal(downloads, 8);
      t.mock.timers.setTime(due);
      await results.syncEvents(store.user("demo-a"));
      assert.equal(downloads, 9);
      assert.equal(results.inbox.deferred("demo-a"), 1);
      assert.equal(
        Date.parse(results.inbox.diagnostics("demo-a")[0].nextAttemptAt || ""),
        due + 3600000,
      );
      broken = false;
      t.mock.timers.setTime(due + 3600000);
      await results.syncEvents(store.user("demo-a"));
      assert.equal(downloads, 10);
      assert.equal(store.results("demo-a").length, 1);
      assert.equal(store.results("demo-b").length, 0);
      assert.equal(results.inbox.deferred("demo-a"), 0);
      assert.equal(results.syncIssue("demo-a"), undefined);
      await results.syncEvents(store.user("demo-a"));
      assert.equal(downloads, 10);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("upgrade restores paused transient failures once, preserves contract quarantine and allows scoped manual retry", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const directory = mkdtempSync(join(tmpdir(), "rhino-retry-upgrade-"));
  let store = new Store(join(directory, "test.sqlite"));
  try {
    let inbox = new EventInbox(store);
    for (const category of ["MEDIA", "PROCESSING", "CONTRACT"]) {
      const key = randomUUID();
      inbox.receive(store.user("demo-a"), [{ eventId: key }], key);
      store.db
        .prepare(
          "UPDATE api_event_inbox SET status='PAUSED',attempts=8,last_error=?,next_attempt=? WHERE event_key=?",
        )
        .run(category, Date.now(), key);
    }
    store.close();
    store = new Store(join(directory, "test.sqlite"));
    inbox = new EventInbox(store);
    assert.equal(inbox.deferred("demo-a"), 2);
    assert.equal(inbox.paused("demo-a"), 1);
    const deadline = Date.now() + 3600000;
    assert(
      inbox
        .diagnostics("demo-a")
        .filter((r) => !r.paused)
        .every(
          (r) =>
            r.attempts === 8 && Date.parse(r.nextAttemptAt || "") === deadline,
        ),
    );
    t.mock.timers.setTime(deadline - 1);
    store.close();
    store = new Store(join(directory, "test.sqlite"));
    inbox = new EventInbox(store);
    assert.equal(inbox.due("demo-a", deadline - 1).length, 0);
    assert.equal(inbox.due("demo-a", deadline).length, 2); // Restart did not reset the clock.
    inbox.retry("demo-b");
    assert.equal(inbox.deferred("demo-a"), 2);
    inbox.retry("demo-a");
    assert.equal(inbox.deferred("demo-a"), 0);
    assert.equal(inbox.pending("demo-a"), 3);
    assert(inbox.diagnostics("demo-a").every((r) => r.attempts === 8));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart reconciles interrupted sends without changing saved responses, rejections or unsent attempts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rhino-crash-recovery-"));
  let store = new Store(join(directory, "test.sqlite"));
  const response = { submissionNo: "GSaccepted" };
  try {
    for (const id of ["sent", "legacy", "saved", "rejected", "unsent"]) {
      store.startRequest("demo-a", id, "design", { clientRequestId: id });
      if (id === "legacy") continue;
      const attempt = store.attempts.begin("demo-a", id);
      if (id === "sent") {
        // Stop after the durable send marker; no catch/finally runs before reopen.
        void attempt.send(() => new Promise(() => {}));
      } else if (id === "saved") {
        store.finishRequest("demo-a", id, response, "ACCEPTED");
      } else if (id === "rejected") {
        await assert.rejects(
          attempt.send(async () => {
            throw new AppError(409, "refused", undefined, "UPSTREAM_REJECTED");
          }),
        );
        attempt.failed();
      }
    }
    assert.equal(
      store.requests("demo-a").find((r) => r.id === "sent")?.status,
      "PENDING",
    );
    store.close();
    store = new Store(join(directory, "test.sqlite"));
    const rows = store.requests("demo-a");
    for (const id of ["sent", "legacy"])
      assert.equal(rows.find((r) => r.id === id)?.status, "UNCONFIRMED");
    assert.equal(rows.find((r) => r.id === "saved")?.status, "ACCEPTED");
    assert.deepEqual(rows.find((r) => r.id === "saved")?.response, response);
    assert.equal(rows.find((r) => r.id === "rejected")?.status, "REJECTED");
    assert.equal(rows.find((r) => r.id === "unsent")?.status, "PENDING");
    store.close();
    store = new Store(join(directory, "test.sqlite"));
    assert.deepEqual(store.requests("demo-a"), rows);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
