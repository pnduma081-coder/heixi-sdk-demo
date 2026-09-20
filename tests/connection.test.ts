import assert from "node:assert/strict";
import test from "node:test";
import { httpsHostOrigin as hostOrigin } from "../server/config.ts";
import { checkConnection, sdkSignature } from "../server/connection.ts";
import { AppError } from "../server/errors.ts";
import { MerchantClient } from "../server/merchant.ts";

const key = `sk-${"a".repeat(43)}`;
const userId = "isolated-test-user";
const origin = "http://127.0.0.1:18001";

test("HTTP page origin is rejected before obtaining an SDK signature", async () => {
  const client = new MerchantClient(origin, key, async () =>
    assert.fail("must not request a signature"),
  );
  await assert.rejects(
    () => sdkSignature(client, userId, "http://127.0.0.1:3443"),
    /HTTPS/,
  );
});

test("online signature keeps the exact API path and HTTPS parent without caching", async () => {
  let calls = 0;
  const client = new MerchantClient(
    "https://api.heixi.com",
    key,
    async (url, options) => {
      calls++;
      assert.equal(
        String(url),
        "https://api.heixi.com/api/v1/open/sdk/signature",
      );
      assert.deepEqual(JSON.parse(String(options?.body)), {
        externalUserId: userId,
        parentOrigin: "https://merchant.example",
      });
      return Response.json({
        code: 0,
        data: { signature: `synthetic-${calls}` },
      });
    },
  );
  assert.equal(
    await sdkSignature(client, userId, "https://merchant.example"),
    "synthetic-1",
  );
  assert.equal(
    await sdkSignature(client, userId, "https://merchant.example"),
    "synthetic-2",
  );
});

test("connection check rejects copied tokens or masked keys without sending them", async () => {
  for (const value of [
    "",
    `Bearer ${key}`,
    `${key} `,
    "sk-****",
    "ey.fake.jwt",
  ]) {
    const client = new MerchantClient(origin, value, async () => {
      assert.fail("invalid credentials must not be sent");
    });
    const report = await checkConnection(client, userId, undefined, hostOrigin);
    assert.equal(report.checks[0].status, "failed");
    assert.equal(report.checks.length, 1);
    assert.match(report.checks[0].message, /46/);
    if (value) assert(!JSON.stringify(report).includes(value));
  }
});

test("API auth failure keeps trace ID, redacts the key and skips SDK signature", async () => {
  let calls = 0;
  const client = new MerchantClient(origin, key, async (url) => {
    calls++;
    assert.equal(new URL(String(url)).pathname, "/api/v1/open/history");
    return Response.json(
      {
        code: 40100,
        message: `unauthorized ${key}`,
        traceId: "fixture-api-trace",
      },
      { status: 401 },
    );
  });
  const report = await checkConnection(client, userId, undefined, hostOrigin);
  assert.equal(calls, 1);
  assert.equal(report.checks[0].status, "failed");
  assert.match(report.checks[0].message, /商户凭证/);
  assert(JSON.stringify(report).includes("fixture-api-trace"));
  assert(!JSON.stringify(report).includes(key));
});

test("API success followed by SDK rejection points to exact origin without claiming a proven cause", async () => {
  const paths: string[] = [];
  const client = new MerchantClient(origin, key, async (input, options) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    assert.equal(
      new Headers(options?.headers).get("Authorization"),
      `Bearer ${key}`,
    );
    if (options?.method === "GET") {
      assert.equal(url.searchParams.get("externalUserId"), userId);
      return Response.json({ code: 0, data: { items: ["private-history"] } });
    }
    assert.deepEqual(JSON.parse(String(options?.body)), {
      parentOrigin: hostOrigin,
      externalUserId: userId,
    });
    return Response.json(
      {
        code: 40100,
        message: "未登录或登录已过期",
        traceId: "fixture-sdk-trace",
      },
      { status: 401 },
    );
  });
  const report = await checkConnection(client, userId, undefined, hostOrigin);
  assert.deepEqual(paths, [
    "/api/v1/open/history",
    "/api/v1/open/sdk/signature",
  ]);
  assert.deepEqual(
    report.checks.map((item) => item.status),
    ["passed", "failed"],
  );
  assert.match(report.checks[1].message, /允许来源/);
  assert(report.checks[1].message.includes(hostOrigin));
  assert(!JSON.stringify(report).includes("private-history"));
});

test("connection success never exposes signature/history; non-auth errors remain distinct", async () => {
  const client = new MerchantClient(origin, key, async () =>
    Response.json({
      code: 0,
      data: { signature: "private-signature", items: ["private-history"] },
    }),
  );
  const report = await checkConnection(client, userId, undefined, hostOrigin);
  assert.deepEqual(
    report.checks.map((item) => item.status),
    ["passed", "passed"],
  );
  assert(!JSON.stringify(report).includes("private-"));
  const unavailable = new MerchantClient(origin, key, async () => {
    throw new Error("network failure");
  });
  const failed = await checkConnection(unavailable, userId);
  assert.match(failed.checks[0].message, /无响应/);
  assert.equal(failed.checks.length, 1);
});

test("SDK auth failure automatically probes API once and preserves the original trace", async () => {
  for (const apiStatus of [200, 401, 502]) {
    const paths: string[] = [];
    const client = new MerchantClient(origin, key, async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith("/signature"))
        return Response.json(
          {
            code: 40100,
            message: `denied ${key}`,
            traceId: "original-sdk-trace",
          },
          { status: 401 },
        );
      assert.equal(path, "/api/v1/open/history");
      if (apiStatus === 502) throw new Error("offline");
      return Response.json(
        apiStatus === 200
          ? { code: 0, data: { items: ["private-history"] } }
          : { code: 40100, traceId: "api-auth-trace" },
        { status: apiStatus },
      );
    });
    await assert.rejects(
      () => sdkSignature(client, userId, hostOrigin),
      (error: unknown) => {
        assert(error instanceof AppError);
        assert.equal(error.status, 401);
        assert.match(
          error.message,
          apiStatus === 200
            ? /SDK 启动授权未通过/
            : apiStatus === 401
              ? /商户 API 认证未通过/
              : /尚不能判断/,
        );
        assert(error.message.includes(origin));
        assert(JSON.stringify(error.details).includes("original-sdk-trace"));
        assert(!JSON.stringify(error).includes(key));
        assert(!JSON.stringify(error).includes("private-history"));
        return true;
      },
    );
    assert.deepEqual(paths, [
      "/api/v1/open/sdk/signature",
      "/api/v1/open/history",
    ]);
  }
});

test("successful SDK startup and non-auth failures do not run extra probes", async () => {
  for (const status of [200, 503]) {
    let calls = 0;
    const client = new MerchantClient(origin, key, async () => {
      calls++;
      return Response.json(
        status === 200
          ? { code: 0, data: { signature: "sdk-signature" } }
          : { code: 50300, message: "unavailable" },
        { status },
      );
    });
    if (status === 200)
      assert.equal(
        await sdkSignature(client, userId, hostOrigin),
        "sdk-signature",
      );
    else
      await assert.rejects(
        () => sdkSignature(client, userId, hostOrigin),
        (error: unknown) => error instanceof AppError && error.status === 503,
      );
    assert.equal(calls, 1);
  }
});
