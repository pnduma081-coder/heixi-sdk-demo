import assert from "node:assert/strict";
import test from "node:test";
import { createSdkOptions } from "../src/sdk.ts";

test("current SDK host supplies signature and approval without the retired result subscription", async (t) => {
  const calls: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      assert.equal(
        new Headers(init?.headers).get("X-Demo-User"),
        "isolated-user",
      );
      return Response.json({ signature: "synthetic-signature" });
    },
  );
  const options = createSdkOptions("isolated-user", {
    onRefresh: () => {},
    onRecharge: () => {},
    onError: () => {},
  });
  assert.equal("onResult" in options, false);
  assert.equal(typeof options.onBeforeGenerate, "function");
  assert.equal(
    await options.getSignature({
      parentOrigin: "https://fixture.invalid",
      signal: new AbortController().signal,
    }),
    "synthetic-signature",
  );
  assert.deepEqual(calls, ["/api/sdk/signature"]);
});
