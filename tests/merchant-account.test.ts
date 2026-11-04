import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { resolveConfig } from "../server/config.ts";
import { AppError } from "../server/errors.ts";
import { createHandler } from "../server/http.ts";
import { MerchantClient } from "../server/merchant.ts";
import { Operations } from "../server/operations.ts";
import { ResultService } from "../server/results.ts";
import { Store } from "../server/store.ts";
import type { MerchantAccount } from "../shared/types.ts";

const auth = { version: "0.4.0", accessKey: `ak-${"a".repeat(32)}` } as const;
const sk = `sk-${"s".repeat(43)}`;
const snapshot: MerchantAccount = {
  credit: 12000,
  membershipActive: true,
  membershipLevel: "ADVANCED",
  membershipName: "高级版",
  membershipExpireTime: "2027-01-01T08:00:00.000Z",
};

test("merchant account sends only AK/SK headers and never external identity, query or body", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const api = new MerchantClient(
    "https://synthetic.invalid",
    sk,
    async (input, options) => {
      calls++;
      assert.equal(
        String(input),
        "https://synthetic.invalid/api/v1/open/account",
      );
      assert.equal(options?.method, "GET");
      assert.equal(options?.body, undefined);
      assert.equal(options?.redirect, "error");
      const headers = new Headers(options?.headers);
      assert.equal(headers.get("X-Merchant-Version"), "0.4.0");
      assert.equal(headers.get("X-Merchant-AK"), auth.accessKey);
      assert.equal(headers.get("Authorization"), `Bearer ${sk}`);
      return Response.json({ code: 0, data: snapshot });
    },
    auth,
  );
  try {
    const operations = new Operations(api, store);
    for (const id of ["demo-a", "demo-b"]) {
      assert.deepEqual(
        await operations.call(store.user(id), "account", {}),
        snapshot,
      );
      assert.equal(store.user(id).credits, 0);
      assert.equal(store.requests(id).length, 0);
      assert.equal(store.ledger(id).length, 0);
    }
    for (const key of [
      "externalUserId",
      "memberId",
      "siteId",
      "clientRequestId",
      "other",
    ]) {
      await assert.rejects(
        () =>
          operations.call(store.user("demo-a"), "account", {
            [key]: "forbidden",
          }),
        /不接受任何参数/,
      );
    }
    await assert.rejects(
      () => api.request("/open/account", "demo-user-a"),
      /account\(\)/,
    );
    assert.equal(calls, 2);
  } finally {
    store.close();
  }
});

test("account preserves zero credit, inactive membership and active legacy membership with null level", async () => {
  for (const membershipActive of [false, true]) {
    const expected = {
      credit: 0,
      membershipActive,
      membershipLevel: null,
      membershipName: membershipActive ? "历史有效套餐" : null,
      membershipExpireTime: membershipActive
        ? snapshot.membershipExpireTime
        : null,
    };
    const api = new MerchantClient(
      "https://synthetic.invalid",
      sk,
      async () =>
        Response.json({
          code: 0,
          data: { ...expected, privateExtra: "discard" },
        }),
      auth,
    );
    assert.deepEqual(await api.account(), expected);
  }
});

test("malformed account snapshots and upstream errors never become zero balance or empty membership", async () => {
  for (const patch of [
    { credit: -1 },
    { credit: 0.5 },
    { credit: "12000" },
    { credit: Number.MAX_SAFE_INTEGER + 1 },
    { membershipActive: undefined },
    { membershipLevel: undefined },
    { membershipName: 42 },
    { membershipExpireTime: "invalid-date" },
  ]) {
    const api = new MerchantClient(
      "https://synthetic.invalid",
      sk,
      async () => Response.json({ code: 0, data: { ...snapshot, ...patch } }),
      auth,
    );
    await assert.rejects(
      () => api.account(),
      (error: unknown) => error instanceof AppError && error.status === 502,
    );
  }
  for (const status of [401, 403, 500]) {
    const api = new MerchantClient(
      "https://synthetic.invalid",
      sk,
      async () =>
        Response.json(
          {
            code: status * 100,
            message: `secret ${sk}`,
            traceId: "account-fixture",
          },
          { status },
        ),
      auth,
    );
    await assert.rejects(
      () => api.account(),
      (error: unknown) => {
        assert(error instanceof AppError);
        assert.equal(error.status, status);
        assert.equal(
          (error.details as { traceId: string }).traceId,
          "account-fixture",
        );
        assert(!JSON.stringify(error).includes(sk));
        return true;
      },
    );
  }
});

test("HTTP account query requires local session and origin, returns no-store and never calls generation", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const api = new MerchantClient(
    "https://synthetic.invalid",
    sk,
    async (input) => {
      assert.equal(
        String(input),
        "https://synthetic.invalid/api/v1/open/account",
      );
      calls++;
      return Response.json({ code: 0, data: snapshot });
    },
    auth,
  );
  const config = resolveConfig({ env: {}, directory: "/not-used" });
  const handler = createHandler(
    config,
    store,
    api,
    new Operations(api, store),
    new ResultService(store, api, {
      save: async () => assert.fail("no media"),
    }),
  );
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (cookie: string, source = config.public.hostOrigin) =>
    fetch(`${origin}/api/call`, {
      method: "POST",
      headers: {
        cookie,
        origin: source,
        "Content-Type": "application/json",
        "X-Demo-User": "demo-a",
      },
      body: JSON.stringify({ operation: "account", params: {} }),
    });
  try {
    assert.equal((await post("")).status, 401);
    const cookie = `demo_session=${store.newSession("demo-a")}`;
    assert.equal((await post(cookie, "https://foreign.invalid")).status, 403);
    assert.equal(calls, 0);
    const response = await post(cookie);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), snapshot);
    assert.equal(calls, 1);
    assert.equal(store.requests("demo-a").length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
