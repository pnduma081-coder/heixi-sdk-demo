import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppError, resultSaveError } from "../server/errors.ts";
import { MerchantClient } from "../server/merchant.ts";
import { Operations } from "../server/operations.ts";
import { ResultService } from "../server/results.ts";
import { Store } from "../server/store.ts";
import { verifyWebhook } from "../server/webhook.ts";
import type { MerchantEvent } from "../shared/types.ts";

function event(delta = -20): MerchantEvent {
  return {
    eventId: randomUUID(),
    eventVersion: "merchant-events/v1",
    eventType: delta > 0 ? "credits.refunded" : "credits.debited",
    externalUserId: "demo-user-a",
    occurredAt: new Date().toISOString(),
    data: { delta, ledgerId: randomUUID() },
  };
}
test("isolated SQLite persists users, topups and separate deduplicated platform costs across restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "black-rhino-demo-test-"));
  try {
    const store = new Store(join(directory, "test.sqlite"));
    assert.equal(store.users().length, 2);
    const id = randomUUID();
    store.addCredit("demo-a", 100, id);
    store.addCredit("demo-a", 100, id);
    assert.throws(() => store.addCredit("demo-a", 101, id), /数量已变化/);
    const debit = event();
    store.creditEvent(debit);
    store.creditEvent(debit);
    assert.equal(store.user("demo-a").credits, 100);
    assert.equal(store.platformCosts("demo-a").length, 1);
    assert.equal(store.user("demo-b").credits, 0);
    assert.throws(
      () =>
        store.creditEvent({ ...debit, data: { ...debit.data, delta: -21 } }),
      /内容/,
    );
    store.creditEvent(event(10));
    store.close();
    const reopened = new Store(join(directory, "test.sqlite"));
    assert.equal(reopened.user("demo-a").credits, 100);
    assert.equal(reopened.platformCosts("demo-a").length, 2);
    assert.equal(reopened.ledger("demo-a").length, 1);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("credit event rollback and negative balance preserve actual ledger facts", () => {
  const store = new Store(":memory:");
  try {
    store.db.exec(
      "CREATE TRIGGER fail_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'injected failure'); END",
    );
    assert.throws(() => store.creditEvent(event()));
    assert.equal(store.ledger("demo-a").length, 0);
    assert.equal(store.user("demo-a").credits, 0);
    store.db.exec("DROP TRIGGER fail_events");
    store.creditEvent({ ...event(), eventType: "credits.license_debited" });
    assert.equal(store.user("demo-a").credits, -20);
  } finally {
    store.close();
  }
});
test("raw-body HMAC validates each topic key, time and bound identities", () => {
  const payload = event(),
    raw = Buffer.from(JSON.stringify(payload));
  const secret = "whsec_fixture-only",
    keyId = randomUUID(),
    deliveryId = randomUUID(),
    timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1=${createHmac("sha256", secret).update(`${timestamp}.${keyId}.${deliveryId}.${payload.eventId}.`).update(raw).digest("hex")}`;
  const headers = {
    "x-black-rhino-timestamp": timestamp,
    "x-black-rhino-key-id": keyId,
    "x-black-rhino-delivery-id": deliveryId,
    "x-black-rhino-event-id": payload.eventId,
    "x-black-rhino-signature": signature,
  };
  const keys = new Map([[keyId, secret]]);
  assert.deepEqual(verifyWebhook(raw, headers, keys), payload);
  assert.throws(() => verifyWebhook(Buffer.from(`${raw} `), headers, keys));
  assert.throws(() =>
    verifyWebhook(raw, headers, new Map([[keyId, "other-topic-key"]])),
  );
  assert.throws(() => verifyWebhook(raw, headers, keys, Date.now() + 301_000));
  assert.throws(() =>
    verifyWebhook(
      raw,
      { ...headers, "x-black-rhino-event-id": randomUUID() },
      keys,
    ),
  );
});
test("session switches invalidate old token and request approval never debits twice", async () => {
  const store = new Store(":memory:");
  try {
    const token = store.newSession("demo-a"),
      next = store.newSession("demo-b", token);
    assert.equal(store.session(token), null);
    assert.equal(store.session(next)?.id, "demo-b");
    store.addCredit("demo-a", 100, randomUUID());
    const clientRequestId = randomUUID(),
      quoteId = randomUUID();
    let approvals = 0;
    const api = new MerchantClient(
      "https://platform.example",
      "fixture-key",
      async (input, init) => {
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer fixture-key",
        );
        const url = new URL(String(input));
        if (url.pathname.endsWith("/approve")) {
          approvals++;
          assert.equal(
            JSON.parse(String(init?.body)).externalUserId,
            "demo-user-a",
          );
          return Response.json({ code: 0, data: { approvalId: "approved" } });
        }
        return Response.json({
          code: 0,
          data: {
            quoteId,
            clientRequestId,
            estimatedCredits: 30,
            externalUserId: "demo-user-a",
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            saleItems: [{ itemId: randomUUID(), credits: 30 }],
          },
        });
      },
    );
    const operations = new Operations(api, store),
      user = store.user("demo-a");
    await Promise.all([
      operations.approve(user, { quoteId, clientRequestId }),
      operations.approve(user, { quoteId, clientRequestId }),
    ]);
    assert.equal(approvals, 1);
    assert.equal(store.user(user.id).credits, 100);
    store.creditEvent(event(-30));
    await operations.approve(user, { quoteId, clientRequestId });
    assert.equal(approvals, 1);
    assert.equal(store.user(user.id).credits, 100);
    await assert.rejects(
      () => operations.call(user, "models", { externalUserId: "other" }),
      /身份/,
    );
  } finally {
    store.close();
  }
});
test("API retries preserve request identity after uncertain transport and reject changed input", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const quoteId = randomUUID(),
    itemId = randomUUID();
  try {
    const client = new MerchantClient(
      "https://fixture.example",
      "fixture-key",
      async (input, options) => {
        const path = new URL(String(input)).pathname;
        const request = JSON.parse(String(options?.body));
        if (path.endsWith("/generation-quotes"))
          return Response.json({
            code: 0,
            data: {
              quoteId,
              clientRequestId: request.input.clientRequestId,
              externalUserId: request.externalUserId,
              estimatedCredits: 0,
              expiresAt: new Date(Date.now() + 300000).toISOString(),
              saleItems: [{ itemId, credits: 0 }],
            },
          });
        if (path.endsWith("/approve"))
          return Response.json({ code: 0, data: { approvalId: quoteId } });
        assert(path.endsWith("/submit"));
        if (++calls === 1) throw new Error("timeout");
        return Response.json({
          code: 0,
          data: { submission: { submissionNo: "GSfixture" } },
        });
      },
    );
    const operations = new Operations(client, store),
      user = store.user("demo-a"),
      body = { clientRequestId: randomUUID(), prompt: "a" };
    await assert.rejects(
      () => operations.call(user, "video", body),
      /结果可能未确定/,
    );
    await operations.call(user, "video", {
      prompt: "a",
      clientRequestId: body.clientRequestId,
    });
    await operations.call(user, "video", body);
    assert.equal(calls, 2);
    await assert.rejects(
      () => operations.call(user, "video", { ...body, prompt: "changed" }),
      /参数已变化/,
    );
  } finally {
    store.close();
  }
});
test("SDK media save failure keeps the cursor; retry persists once and survives restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rhino-sdk-results-"));
  const path = join(directory, "fixture.sqlite");
  let store = new Store(path),
    failed = true,
    downloads = 0,
    reads = 0;
  const sdkEvent: MerchantEvent = {
    ...event(),
    eventType: "generation.finished",
    data: {
      requestChannel: "SDK",
      submissionNo: "GSfixture",
      clientRequestId: "fixture-request",
      status: "SUCCEEDED",
    },
  };
  const client = new MerchantClient(
    "https://fixture.example",
    "fixture-key",
    async (input) => {
      reads++;
      return Response.json({
        code: 0,
        data: new URL(String(input)).pathname.endsWith("/events")
          ? {
              items: [sdkEvent],
              hasMore: false,
              nextCursor: sdkEvent.eventId,
            }
          : {
              ...sdkEvent.data,
              terminal: true,
              tasks: [
                {
                  role: "OUTPUT",
                  results: [
                    {
                      available: true,
                      url: "https://media.example/image",
                      type: "IMAGE",
                    },
                  ],
                },
              ],
            },
      });
    },
  );
  const media = {
    async save() {
      downloads++;
      if (failed) throw new AppError(409, "download failed");
      return {
        id: "fixture",
        name: "fixture",
        bytes: 12,
        contentType: "image/png",
      };
    },
  };
  try {
    const results = new ResultService(store, client, media),
      user = store.user("demo-a");
    await assert.rejects(() => results.sdk(user, sdkEvent.eventId));
    assert.equal(store.results(user.id).length, 0);
    assert.equal(store.cursor(user.id), undefined);
    failed = false;
    const saved = await results.sdk(user, sdkEvent.eventId);
    assert.equal(store.cursor(user.id), sdkEvent.eventId);
    store.close();
    store = new Store(path);
    const afterRestart = new ResultService(store, client, media),
      savedReads = reads;
    const repeated = await afterRestart.sdk(
      store.user("demo-a"),
      sdkEvent.eventId,
    );
    assert.equal(repeated.id, saved.id);
    assert.equal(reads, savedReads);
    assert.equal(downloads, 2);
    assert.equal(store.cursor("demo-a"), sdkEvent.eventId);
    await assert.rejects(
      () => afterRestart.sdk(store.user("demo-b"), sdkEvent.eventId),
      /当前用户/,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SDK event re-read persists text and cursor; API callbacks save independently and deduplicate", async () => {
  const store = new Store(":memory:");
  const sdkEvent: MerchantEvent = {
    ...event(),
    eventType: "generation.finished",
    data: {
      requestChannel: "SDK",
      submissionNo: "GSfixture",
      clientRequestId: "request-fixture",
      status: "SUCCEEDED",
      tasks: [{ role: "OUTPUT", text: "已生成的文本", results: [] }],
    },
  };
  let reads = 0;
  try {
    const client = new MerchantClient(
      "https://fixture.example",
      "fixture-key",
      async (input) => {
        reads++;
        if (new URL(String(input)).pathname.endsWith("/events"))
          return Response.json({
            code: 0,
            data: {
              items: [sdkEvent],
              hasMore: false,
              nextCursor: sdkEvent.eventId,
            },
          });
        return Response.json({
          code: 0,
          data: {
            submissionNo: "GSfixture",
            clientRequestId: "request-fixture",
            terminal: true,
            status: "SUCCEEDED",
            tasks: [{ role: "OUTPUT", text: "已生成的文本", results: [] }],
          },
        });
      },
    );
    const service = new ResultService(store, client, {
      async save() {
        throw new Error("Text results must not download files");
      },
    });
    const user = store.user("demo-a");
    await assert.rejects(() => service.sdk(user, randomUUID()), /更早/);
    assert.equal(store.cursor(user.id), undefined);
    const saved = await service.sdk(user, sdkEvent.eventId);
    assert.equal(store.cursor(user.id), sdkEvent.eventId);
    assert.match(JSON.stringify(saved.payload), /已生成的文本/);
    const afterSave = reads;
    await service.sdk(user, sdkEvent.eventId);
    assert.equal(reads, afterSave);
    const apiEvent = {
      ...sdkEvent,
      eventId: randomUUID(),
      data: { ...sdkEvent.data, requestChannel: "API" },
    };
    await service.generation(apiEvent);
    await service.generation(apiEvent);
    assert.equal(reads, afterSave);
    assert.deepEqual(
      store
        .results(user.id)
        .map((item) => item.source)
        .sort(),
      ["API", "SDK"],
    );
  } finally {
    store.close();
  }
});

test("generation callback diagnostics are owner-scoped, redact unknown errors and clear on retry", async () => {
  const store = new Store(":memory:");
  let failure: Error | undefined = resultSaveError(
    409,
    "结果文件不可用或类型不符",
  );
  const payload = {
    submissionNo: "GSfixture",
    clientRequestId: "request-fixture",
    terminal: true,
    status: "SUCCEEDED",
    tasks: [
      {
        role: "OUTPUT",
        results: [
          {
            available: true,
            url: "https://fixture.invalid/image",
            type: "IMAGE",
          },
        ],
      },
    ],
  };
  const client = new MerchantClient(
    "https://fixture.invalid",
    "fixture-key",
    async () => {
      throw new Error("Signed API callbacks must not query generation results");
    },
  );
  const service = new ResultService(store, client, {
    async save() {
      if (failure) throw failure;
      return {
        id: "fixture-file",
        name: "image",
        bytes: 1,
        contentType: "image/png",
      };
    },
  });
  const callback = {
    ...event(),
    eventType: "generation.finished",
    data: {
      ...payload,
      requestChannel: "API",
      submissionNo: "GSfixture",
      clientRequestId: "request-fixture",
    },
  };
  try {
    await assert.rejects(() => service.generation(callback));
    assert.equal(
      service.generationFailures.get("demo-a")?.reason,
      "结果文件不可用或类型不符",
    );
    assert.equal(service.generationFailures.get("demo-b"), undefined);
    assert.equal(store.results("demo-a").length, 0);
    failure = new Error("private URL and credential must never be exposed");
    await assert.rejects(() => service.generation(callback));
    assert.equal(
      service.generationFailures.get("demo-a")?.reason,
      "结果保存失败，请检查服务端处理状态",
    );
    failure = undefined;
    await service.generation(callback);
    assert.equal(service.generationFailures.get("demo-a"), undefined);
    assert.equal(store.results("demo-a").length, 1);
  } finally {
    store.close();
  }
});
