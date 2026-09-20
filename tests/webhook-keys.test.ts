import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { hostOrigin, sdkApiOrigin } from "../server/config.ts";
import { createHandler } from "../server/http.ts";
import { MerchantClient } from "../server/merchant.ts";
import { Operations } from "../server/operations.ts";
import { ResultService } from "../server/results.ts";
import { Store } from "../server/store.ts";
import { WebhookKeys } from "../server/webhook-keys.ts";

function signed(
  keyId: string,
  secret: string,
  delta = -5,
  timestamp = Math.floor(Date.now() / 1000),
  sale?: { eventType: string; data: Record<string, unknown> },
) {
  const eventId = randomUUID(),
    deliveryId = randomUUID();
  const raw = Buffer.from(
    JSON.stringify({
      eventId,
      eventVersion: "merchant-events/v1",
      externalUserId: "demo-user-a",
      eventType: delta < 0 ? "credits.debited" : "credits.refunded",
      occurredAt: new Date().toISOString(),
      data: { delta },
      ...sale,
    }),
  );
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${keyId}.${deliveryId}.${eventId}.`)
    .update(raw)
    .digest("hex");
  return {
    raw,
    headers: {
      "x-black-rhino-timestamp": String(timestamp),
      "x-black-rhino-key-id": keyId,
      "x-black-rhino-delivery-id": deliveryId,
      "x-black-rhino-event-id": eventId,
      "x-black-rhino-signature": `v1=${signature}`,
    },
  };
}
const secret = `whsec_${"a".repeat(43)}`;

test("automatic keys: one API Key, per-topic cache, rotation/history, invalid and expired callbacks", async () => {
  let count = 0;
  const old = randomUUID(),
    current = randomUUID();
  const transport: typeof fetch = async (input, options) => {
    count++;
    assert.equal(
      new URL(String(input)).pathname,
      "/api/v1/open/webhooks/credits/signing-key",
    );
    assert.equal(
      new Headers(options?.headers).get("Authorization"),
      "Bearer fixture-api-key",
    );
    assert.equal(new Headers(options?.headers).get("Origin"), null);
    const body = JSON.parse(String(options?.body));
    assert.deepEqual(Object.keys(body), ["keyId"]);
    return Response.json({ code: 0, data: { keyId: body.keyId, secret } });
  };
  const keys = new WebhookKeys(
    "https://fixture.invalid",
    "fixture-api-key",
    transport,
  );
  const first = signed(old, secret);
  await Promise.all([
    keys.verify(first.raw, first.headers, "credits"),
    keys.verify(first.raw, first.headers, "credits"),
  ]);
  assert.equal(count, 1);
  const next = signed(current, secret);
  await keys.verify(next.raw, next.headers, "credits");
  await keys.verify(first.raw, first.headers, "credits");
  assert.equal(count, 2);
  await assert.rejects(keys.verify(first.raw, first.headers, "generation"));
  const expired = signed(
    randomUUID(),
    secret,
    -5,
    Math.floor(Date.now() / 1000) - 600,
  );
  const before = count;
  await assert.rejects(keys.verify(expired.raw, expired.headers, "credits"));
  assert.equal(count, before);
  const bad = {
    ...first.headers,
    "x-black-rhino-signature": `v1=${"0".repeat(64)}`,
  };
  await assert.rejects(keys.verify(first.raw, bad, "credits"));
  for (let i = 0; i < 33; i++) {
    const item = signed(randomUUID(), secret);
    await keys.verify(item.raw, item.headers, "credits");
  }
  const beforeReload = count;
  await keys.verify(first.raw, first.headers, "credits");
  assert.equal(count, beforeReload + 1);
});

test("failed lookup is not cached and never bypasses signature verification", async () => {
  let requests = 0;
  const id = randomUUID();
  const keys = new WebhookKeys(
    "https://fixture.invalid",
    "fixture-api-key",
    async () => {
      requests++;
      if (requests === 1)
        return Response.json(
          { code: 40100, secret: "must-not-leak" },
          { status: 401 },
        );
      return Response.json({ code: 0, data: { keyId: id, secret } });
    },
  );
  const message = signed(id, secret);
  await assert.rejects(
    keys.verify(message.raw, message.headers, "credits"),
    (error) =>
      error instanceof Error && !error.message.includes("must-not-leak"),
  );
  await keys.verify(message.raw, message.headers, "credits");
  assert.equal(requests, 2);
  await assert.rejects(
    new WebhookKeys("https://fixture.invalid", "", async () => {
      throw Error("must not fetch");
    }).verify(message.raw, message.headers, "credits"),
  );
});

test("real HTTP receiver: automatic key lookup, debit/refund and replay deduplication; invalid signature cannot write", async () => {
  const store = new Store(":memory:");
  const keyId = randomUUID();
  let lookups = 0;
  const api = new MerchantClient(
    "https://fixture.invalid",
    "fixture-api-key",
    async (input) => {
      assert.equal(
        new URL(String(input)).pathname,
        "/api/v1/open/webhooks/credits/signing-key",
      );
      lookups++;
      return Response.json({ code: 0, data: { keyId, secret } });
    },
  );
  const results = new ResultService(store, api, {
    async save() {
      throw Error("no downloads");
    },
  });
  const handler = createHandler(
    {
      apiOrigin: api.apiOrigin,
      apiKey: api.key,
      dataDir: "/unused",
      public: {
        missing: [],
        apiReady: true,
        callbacksReady: true,
        sdkReady: true,
        hostOrigin,
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/webhooks/credits`;
  const send = (message: ReturnType<typeof signed>) =>
    fetch(url, {
      method: "POST",
      headers: message.headers,
      body: new Uint8Array(message.raw),
    });
  try {
    const debit = signed(keyId, secret);
    assert.equal((await send(debit)).status, 200);
    assert.equal(store.user("demo-a").credits, 0);
    assert.equal(store.platformCosts("demo-a").length, 1);
    assert.equal((await send(debit)).status, 200);
    assert.equal(store.user("demo-a").credits, 0);
    assert.equal(store.platformCosts("demo-a").length, 1);
    const bad = signed(keyId, `whsec_${"b".repeat(43)}`);
    assert.equal((await send(bad)).status, 401);
    assert.equal(store.user("demo-a").credits, 0);
    assert.equal(store.platformCosts("demo-a").length, 1);
    const refund = signed(keyId, secret, 5);
    assert.equal((await send(refund)).status, 200);
    assert.equal(store.user("demo-a").credits, 0);
    assert.equal(store.user("demo-b").credits, 0);
    store.addCredit("demo-a", 100, randomUUID());
    const quoteId = randomUUID(),
      itemId = randomUUID(),
      clientRequestId = randomUUID();
    store.sales.freeze(store.user("demo-a"), {
      quoteId,
      externalUserId: "demo-user-a",
      clientRequestId,
      estimatedCredits: 35,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      saleItems: [{ itemId, credits: 35 }],
    });
    const data = {
      quoteId,
      itemId,
      clientRequestId,
      taskNo: "AIinitial",
      amount: 35,
      settlementId: `sale:${itemId}:debit`,
    };
    const saleDebit = signed(keyId, secret, -20, undefined, {
      eventType: "credits.sale_debited",
      data,
    });
    assert.equal((await send(saleDebit)).status, 200);
    assert.equal((await send(saleDebit)).status, 200);
    assert.equal(store.user("demo-a").credits, 65);
    const saleBad = signed(keyId, `whsec_${"b".repeat(43)}`, -20, undefined, {
      eventType: "credits.sale_refunded",
      data: {
        ...data,
        settlementId: `sale:${itemId}:refund`,
        originalDebitId: `sale:${itemId}:debit`,
      },
    });
    assert.equal((await send(saleBad)).status, 401);
    assert.equal(store.user("demo-a").credits, 65);
    const saleRefund = signed(keyId, secret, 20, undefined, {
      eventType: "credits.sale_refunded",
      data: {
        ...data,
        taskNo: "AItransferred",
        settlementId: `sale:${itemId}:refund`,
        originalDebitId: `sale:${itemId}:debit`,
      },
    });
    assert.equal((await send(saleRefund)).status, 200);
    assert.equal((await send(saleRefund)).status, 200);
    assert.equal(store.user("demo-a").credits, 100);
    assert.equal(store.platformCosts("demo-a").length, 2);
    assert.equal(
      store.ledger("demo-a").filter((row) => row.kind.startsWith("SALE_"))
        .length,
      2,
    );
    assert.equal(lookups, 1);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/config`);
    const config = await response.text();
    assert(!config.includes(secret) && !config.includes("fixture-api-key"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
