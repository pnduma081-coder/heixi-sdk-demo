import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localReadTransport } from "../server/f065-local.ts";
import { createHandler } from "../server/http.ts";
import { MerchantClient } from "../server/merchant.ts";
import { Operations } from "../server/operations.ts";
import { ResultService } from "../server/results.ts";
import { Store } from "../server/store.ts";
import { createSdkOptions } from "../src/sdk.ts";

test("explicit credits exception is local and does not admit other writes", async () => {
  const called: string[] = [];
  const transport = async (input: Parameters<typeof fetch>[0]) => {
    called.push(String(input));
    return Response.json({});
  };
  for (const enabled of [false, true]) {
    const request = localReadTransport(
      "http://localhost:18080",
      transport,
      enabled,
    );
    for (const path of [
      "/api/v1/open/webhooks/generation/signing-key",
      "/api/v1/open/events",
      "/api/v1/open/sdk/approve",
      "/api/v1/open/generations",
      "/api/v1/open/webhooks/credits/signing-key?x=1",
    ])
      await assert.rejects(
        request(`http://localhost:18080${path}`, {
          method: "POST",
          redirect: "error",
        }),
      );
    const valid = request(
      "http://localhost:18080/api/v1/open/webhooks/credits/signing-key",
      { method: "POST", redirect: "error" },
    );
    if (enabled) await valid;
    else await assert.rejects(valid);
  }
  assert.equal(called.length, 1);
});

test("real HTTP receiver verifies and persists before ACK; restart, duplicate and conflict", async () => {
  const directory = mkdtempSync(join(tmpdir(), "f065-credits-test-"));
  const path = join(directory, "test.sqlite");
  let store = new Store(path);
  const secret = `whsec_${"a".repeat(43)}`,
    keyId = randomUUID();
  let loads = 0;
  const api = new MerchantClient(
    "http://localhost:18080",
    "synthetic-key",
    localReadTransport(
      "http://localhost:18080",
      async (input) => {
        assert.equal(
          new URL(String(input)).pathname,
          "/api/v1/open/webhooks/credits/signing-key",
        );
        loads++;
        return Response.json({ code: 0, data: { keyId, secret } });
      },
      true,
    ),
  );
  const config = {
    apiOrigin: api.apiOrigin,
    apiKey: api.key,
    dataDir: directory,
    localCreditsEnabled: true,
    public: {
      sdkMode: "f065-local" as const,
      hostOrigin: "http://127.0.0.1",
      sdkApiOrigin: api.apiOrigin,
      apiReady: true,
      callbacksReady: true,
      sdkReady: true,
      missing: [],
    },
  };
  function handler() {
    return createHandler(
      config,
      store,
      api,
      new Operations(api, store),
      new ResultService(store, api, {
        save: async () => {
          throw Error("no media");
        },
      }),
    );
  }
  let handle = handler();
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const addr = server.address();
  assert(addr && typeof addr === "object");
  const url = `http://127.0.0.1:${addr.port}`;
  const event = {
    eventId: randomUUID(),
    eventVersion: "merchant-events/v1",
    externalUserId: "demo-user-a",
    eventType: "credits.debited",
    occurredAt: new Date().toISOString(),
    data: { delta: -1 },
  };
  async function post(
    value = event,
    time = Math.floor(Date.now() / 1000),
    bad = false,
  ) {
    const raw = JSON.stringify(value),
      delivery = randomUUID();
    const signature = createHmac("sha256", secret)
      .update(`${time}.${keyId}.${delivery}.${value.eventId}.${raw}`)
      .digest("hex");
    return fetch(`${url}/webhooks/credits`, {
      method: "POST",
      body: raw,
      headers: {
        "x-black-rhino-timestamp": String(time),
        "x-black-rhino-key-id": keyId,
        "x-black-rhino-delivery-id": delivery,
        "x-black-rhino-event-id": value.eventId,
        "x-black-rhino-signature": `v1=${bad ? "0".repeat(64) : signature}`,
      },
    });
  }
  try {
    assert.equal(
      (await post(event, Math.floor(Date.now() / 1000) - 301)).status,
      401,
    );
    assert.equal(loads, 0);
    assert.equal((await post(event, undefined, true)).status, 401);
    const first = await post();
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { received: true });
    assert.equal(store.platformCosts("demo-a").length, 1);
    assert.equal((await post()).status, 200);
    store.close();
    store = new Store(path);
    handle = handler();
    assert.equal((await post()).status, 200);
    assert.equal(store.platformCosts("demo-a").length, 1);
    assert.equal((await post({ ...event, data: { delta: -2 } })).status, 409);
    for (const endpoint of [
      "/webhooks/generation",
      "/api/sdk/approve",
      "/api/generate",
      "/api/events/sync",
    ])
      assert.equal(
        (await fetch(url + endpoint, { method: "POST" })).status,
        403,
      );
    config.localCreditsEnabled = false;
    assert.equal((await post()).status, 403);
    assert.equal(store.platformCosts("demo-a").length, 1);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test("local refusal, cancel and abort resolve false without an approval transport", async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "document");
  class Element extends EventTarget {
    textContent = "";
    children: Element[] = [];
    removed = false;
    setAttribute() {}
    append(...items: Element[]) {
      this.children.push(...items);
    }
    remove() {
      this.removed = true;
    }
    showModal() {}
  }
  const body = new Element();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => new Element(), body },
  });
  try {
    for (const action of ["refuse", "cancel", "abort"]) {
      const signal = new AbortController();
      const promise = createSdkOptions("synthetic", {
        localReadOnly: true,
        onRefresh() {},
        onRecharge() {},
        onError() {},
      }).onBeforeGenerate({ estimatedCredits: 60 }, signal.signal);
      const dialog = body.children.at(-1);
      assert(dialog);
      assert.match(dialog.children[1].textContent, /60 算力/);
      if (action === "abort") signal.abort();
      else
        dialog.children[action === "refuse" ? 2 : 3].dispatchEvent(
          new Event("click"),
        );
      const decision = await promise;
      assert("approved" in decision);
      assert.equal(decision.approved, false);
      assert.equal(dialog.removed, true);
      assert.match(decision.message, action === "refuse" ? /拒绝/ : /取消/);
    }
  } finally {
    if (old) Object.defineProperty(globalThis, "document", old);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
