import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MerchantClient } from "../server/merchant.ts";
import { Operations } from "../server/operations.ts";
import { Store } from "../server/store.ts";
import { examples } from "../shared/examples.ts";
import type { JsonObject } from "../shared/types.ts";
import { mainImageCredits, mainImageRequest } from "../src/api-test.ts";
import {
  imageCapability,
  imageOptions,
  videoOptions,
} from "../src/model-options.ts";

const models: JsonObject[] = JSON.parse(
  readFileSync(
    new URL("./fixtures/model-catalog-040.json", import.meta.url),
    "utf8",
  ),
);

test("latest model catalog produces an allowed image combination with an actual content language", () => {
  const body = mainImageRequest(
    models[0],
    { assetId: randomUUID(), name: "synthetic.png" },
    "synthetic request",
    randomUUID(),
  );
  assert.equal(body.modelId, models[0].id);
  assert.equal(body.parameterSchemaVersion, models[0].parameterSchemaVersion);
  assert.equal(body.contentLanguage, "zh-CN");
  assert.equal(body.resolution, "1K");
  assert.equal(body.ratio, "16:9");
  assert(!("quality" in body), "new requests must not inherit catalog quality");
  const capability = imageCapability(models[0]);
  assert.deepEqual(
    imageOptions(capability, {
      resolution: "2K",
      ratio: "1:1",
      quality: "high",
    }),
    { resolution: "2K", ratio: "1:1" },
  );
  assert.equal(
    examples.find((value) => value.id === "design")?.params.contentLanguage,
    "zh-CN",
  );
  assert.equal(
    examples.find((value) => value.id === "video")?.params.contentLanguage,
    "NONE",
  );
});

test("design-specific and coupled model options override generic defaults and reject unusable models", () => {
  const model = structuredClone(models[0]);
  const capabilities = model.capabilities as JsonObject;
  const design = capabilities.design as JsonObject;
  capabilities.designByFeature = { MAIN_IMAGE: design };
  delete capabilities.design;
  assert.equal(imageCapability(model), design);
  assert.throws(
    () =>
      imageOptions({
        ...design,
        resolutionRatios: { "1K": [], "2K": ["9:16"] },
      }),
    /组合/,
  );
  assert.deepEqual(
    imageOptions(
      { outputRatios: ["4:3"], resolutionOptions: [], qualityOptions: [] },
      { resolution: "old", quality: "old" },
    ),
    { ratio: "4:3" },
  );
  design.maxInputImages = 0;
  assert.throws(
    () =>
      mainImageRequest(
        model,
        { assetId: randomUUID(), name: "fixture" },
        "fixture",
        randomUUID(),
      ),
    /单张参考图/,
  );
  design.maxInputImages = 3;
  design.minInputImages = 2;
  assert.throws(
    () =>
      mainImageRequest(
        model,
        { assetId: randomUUID(), name: "fixture" },
        "fixture",
        randomUUID(),
      ),
    /单张参考图/,
  );
});

test("video catalog consumes duration/resolution/orientation without turning pricing V2 into user charges", () => {
  const capability = (models[1].capabilities as JsonObject).video as JsonObject;
  assert.deepEqual(videoOptions(capability), {
    ratio: "16:9",
    resolution: "720p",
    duration: "5",
    orientation: "landscape",
  });
  assert.equal(videoOptions(capability, { duration: "10" }).duration, "10");
  assert.throws(
    () => videoOptions({ ...capability, durations: [] }),
    /参数不完整/,
  );
  assert(!("unitCredit" in videoOptions(capability)));
});

test("pricing V3 reference input fees stay in the authoritative SDK quote, outside client generation parameters", async () => {
  const store = new Store(":memory:");
  const model = structuredClone(models[1]);
  model.pricing = {
    schemaVersion: "3.0",
    variants: [
      {
        key: "720p",
        resolution: "720p",
        unit: "SECOND",
        unitCredit: 3,
        referenceVideoUnitCredit: 7,
        referenceVideoInputUnitCredit: 2,
      },
    ],
  };
  const clientRequestId = randomUUID(),
    quoteId = randomUUID(),
    itemId = randomUUID();
  const quote = {
    quoteId,
    clientRequestId,
    externalUserId: "demo-user-a",
    // 合成服务端探测：ceil(4.2) * 2 输入费 + 5 * 7 生成费。
    estimatedCredits: 45,
    saleItems: [{ itemId, credits: 45 }],
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const calls: string[] = [];
  const api = new MerchantClient(
    "https://synthetic.invalid",
    "synthetic-sk",
    async (input, options) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      let data: unknown;
      if (url.pathname === "/api/v1/open/models") data = [model];
      else if (url.pathname === `/api/v1/open/sdk/generation-quotes/${quoteId}`)
        data = quote;
      else {
        assert.equal(
          url.pathname,
          `/api/v1/open/sdk/generation-quotes/${quoteId}/approve`,
        );
        assert.deepEqual(JSON.parse(String(options?.body)), {
          clientRequestId,
          estimatedCredits: 45,
          externalUserId: "demo-user-a",
        });
        data = { approvalId: randomUUID() };
      }
      return Response.json({ code: 0, data });
    },
    { version: "0.4.0", accessKey: `ak-${"a".repeat(32)}` },
  );
  try {
    const ops = new Operations(api, store),
      user = store.user("demo-a");
    assert.deepEqual(await ops.call(user, "videoModels", {}), [model]);
    assert.deepEqual(
      videoOptions((model.capabilities as JsonObject).video as JsonObject),
      {
        ratio: "16:9",
        resolution: "720p",
        duration: "5",
        orientation: "landscape",
      },
    );
    assert.equal(
      mainImageCredits(model, { resolution: "720p", outputCount: 1 }),
      undefined,
    );
    await ops.approve(user, {
      quoteId,
      clientRequestId,
      estimatedCredits: 0,
      referenceVideoDuration: 0,
    });
    assert.equal(
      store.sales.quote(user.id, clientRequestId)?.estimatedCredits,
      45,
    );
    assert.equal(store.user(user.id).credits, 0);
    assert.equal(store.sales.held(user.id), 0);
    assert.equal(calls.length, 3);
  } finally {
    store.close();
  }
});

test("disabled public models preserve HTTP 404 and business 47001 without suggesting credential expiry", async () => {
  const api = new MerchantClient(
    "https://synthetic.invalid",
    "synthetic-sk",
    async () =>
      Response.json(
        {
          code: 47001,
          messageKey: "model.unavailable",
          traceId: "disabled-model",
        },
        { status: 404 },
      ),
  );
  await assert.rejects(
    () => api.request("/open/models", "demo-user-a"),
    (error: unknown) => {
      assert(error instanceof Error && "status" in error && "details" in error);
      assert.equal(error.status, 404);
      assert.match(error.message, /AI 模型暂不可用/);
      assert.equal((error.details as JsonObject).code, 47001);
      return true;
    },
  );
});

test("NONE is rejected only for unsaved 0.4 design submissions; historical accepted requests and video are unchanged", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const api = new MerchantClient(
    "https://synthetic.invalid",
    "synthetic-sk",
    async (url, options) => {
      calls++;
      assert.equal(
        new URL(String(url)).pathname,
        "/api/v1/open/video-workflows",
      );
      assert.equal(JSON.parse(String(options?.body)).contentLanguage, "NONE");
      return Response.json({
        code: 0,
        data: { submission: { submissionNo: "GSvideo" } },
      });
    },
    { version: "0.4.0", accessKey: `ak-${"a".repeat(32)}` },
  );
  try {
    const ops = new Operations(api, store),
      user = store.user("demo-a");
    const body = { clientRequestId: randomUUID(), contentLanguage: "NONE" };
    await assert.rejects(() => ops.call(user, "design", body), /实际内容语言/);
    assert.equal(calls, 0);
    assert.equal(store.requests(user.id)[0].body.contentLanguage, "NONE");
    await assert.rejects(
      () => ops.call(user, "design", { ...body, contentLanguage: "zh-CN" }),
      /参数已变化/,
    );
    const cached = { submission: { submissionNo: "GSexisting" } };
    store.finishRequest(user.id, body.clientRequestId, cached, "ACCEPTED");
    assert.deepEqual(await ops.call(user, "design", body), cached);
    await ops.call(user, "video", {
      clientRequestId: randomUUID(),
      contentLanguage: "NONE",
    });
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});
