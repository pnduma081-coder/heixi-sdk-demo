import assert from "node:assert/strict";
import test from "node:test";
import type { RequestRecord, StoredResult } from "../shared/types.ts";
import {
  mainImageChoices,
  mainImageCredits,
  mainImageParameters,
  mainImageRequest,
  submissionNumber,
  testRequests,
  testResults,
} from "../src/api-test.ts";

test("main image controls and payload respect coupled resolutions, ratios and model count limits", () => {
  const model = {
    id: "chosen-model",
    parameterSchemaVersion: "image-v2",
    capabilities: {
      design: {
        feature: "MAIN_IMAGE",
        maxOutputItems: 4,
        outputRatios: ["1:1", "16:9", "9:16"],
        resolutionOptions: ["1K", "2K", "4K"],
        resolutionRatios: { "1K": ["16:9"], "2K": ["1:1", "9:16"], "4K": [] },
        qualityOptions: ["standard", "high"],
      },
      image: { maxOutputItems: 10 },
    },
    pricing: {
      schemaVersion: "1.0",
      variants: [{ resolution: "2K", unit: "REQUEST", unitCredit: 12 }],
    },
  };
  assert.deepEqual(mainImageChoices(model, "2K"), {
    resolutions: ["1K", "2K"],
    ratios: ["1:1", "9:16"],
    counts: [1, 2, 3, 4],
  });
  const selection = {
    resolution: "2K",
    ratio: "9:16",
    outputCount: 3,
  };
  const request = mainImageRequest(
    model,
    { assetId: "product", name: "product.png" },
    "test",
    "stable-id",
    selection,
  );
  for (const [key, value] of Object.entries(selection))
    assert.equal(request[key], value);
  assert.equal(request.modelId, model.id);
  assert.equal(mainImageCredits(model, request), 36);
  for (const invalid of [
    { ...selection, ratio: "16:9" },
    { ...selection, resolution: "4K" },
    ...[0, 5, 1.5, "2", NaN].map((outputCount) => ({
      ...selection,
      outputCount,
    })),
  ])
    assert.throws(() => mainImageParameters(model, invalid));
  const oldParams = { ...selection, quality: "high" };
  const newRequest = mainImageRequest(
    model,
    { assetId: "product", name: "product.png" },
    "test",
    "new-id",
    oldParams,
  );
  assert(
    !("quality" in newRequest),
    "new requests omit even inherited quality",
  );
  assert.equal(
    oldParams.quality,
    "high",
    "historical parameters are not mutated",
  );
});

test("models without a resolution setting omit it and counts remain within the API limit", () => {
  const model = {
    capabilities: { image: { outputRatios: ["1:1"], maxOutputItems: 100 } },
  };
  assert.deepEqual(mainImageParameters(model, { outputCount: 20 }), {
    ratio: "1:1",
    outputCount: 20,
  });
  assert.equal(mainImageChoices(model).counts.length, 20);
  assert.throws(() => mainImageParameters(model, { outputCount: 21 }));
  assert(!("resolution" in mainImageParameters(model)));
});

test("image credit estimate matches the submitted resolution, including restored requests", () => {
  const model = {
    id: "image-model",
    parameterSchemaVersion: "image-v1",
    capabilities: {
      image: { outputRatios: ["1:1"], resolutionOptions: ["1K", "2K"] },
    },
    pricing: {
      schemaVersion: "1.0",
      variants: [
        { resolution: "2K", unit: "REQUEST", unitCredit: 24 },
        { resolution: "1K", unit: "REQUEST", unitCredit: 10 },
      ],
    },
  };
  const request = mainImageRequest(
    model,
    { assetId: "fixture", name: "fixture.png" },
    "fixture",
    "request-1",
  );
  assert.equal(mainImageCredits(model, request), 10);
  assert.equal(mainImageCredits(model, { ...request, resolution: "2K" }), 24);
  assert.equal(
    mainImageCredits(model, { ...request, resolution: "4K" }),
    undefined,
  );
  assert(!("credits" in request));
});

test("image credit estimate distinguishes zero from missing, ambiguous or unsupported prices", () => {
  const params = { resolution: "1K", outputCount: 1 };
  const variant = { resolution: "1K", unit: "REQUEST", unitCredit: 0 };
  const price = (variants: unknown[], schemaVersion = "1.0") => ({
    pricing: { schemaVersion, variants },
  });
  assert.equal(mainImageCredits(price([variant]), params), 0);
  for (const model of [
    {},
    price([]),
    price([variant, variant]),
    price([variant], "4.0"),
    price([{ ...variant, unit: "SECOND" }], "2.0"),
    price([{ ...variant, unitCredit: -1 }]),
    price([{ ...variant, unitCredit: "10" }]),
  ])
    assert.equal(mainImageCredits(model, params), undefined);
  assert.equal(
    mainImageCredits(price([variant]), { outputCount: 1 }),
    undefined,
  );
});

test("API test builds a single-image request using actual authorized model options", () => {
  const body = mainImageRequest(
    {
      id: "model-from-api",
      parameterSchemaVersion: "image-v1",
      capabilities: {
        image: {
          outputRatios: ["9:16", "1:1"],
          resolutionOptions: ["2K", "1K"],
        },
      },
    },
    { assetId: "uploaded-id", name: "product.png" },
    "  保留商品，生成白色背景主图  ",
    "stable-id",
  );
  assert.deepEqual(body.sourceAssetIds, ["uploaded-id"]);
  assert.deepEqual(body.sourceRoles, ["PRODUCT_MAIN"]);
  assert.equal(body.clientRequestId, "stable-id");
  assert.equal(body.outputCount, 1);
  assert.equal(body.feature, "MAIN_IMAGE");
  assert.equal(body.resolution, "1K");
  assert.equal(body.ratio, "1:1");
  assert(!("externalUserId" in body));
  assert.throws(() =>
    mainImageRequest({}, { assetId: "a", name: "a" }, "p", "r"),
  );
});

test("API test shows only persisted API results of current user and distinguishes accepted submissions", () => {
  const request = {
    id: "request-1",
    operation: "design",
    body: { feature: "MAIN_IMAGE", context: { example: "api-test" } },
    response: { submission: { submissionNo: "GSfixture-1" } },
    status: "ACCEPTED",
    createdAt: "2026-09-18T00:00:00Z",
  } satisfies RequestRecord;
  assert.equal(submissionNumber(request.response), "GSfixture-1");
  assert.equal(testRequests([request]).length, 1);
  assert.deepEqual(testResults([], [request], "demo-b"), []);
  const result = {
    id: "result-1",
    userId: "demo-b",
    source: "API",
    reference: "event-1",
    submissionNo: "GSfixture-1",
    status: "SUCCEEDED",
    payload: { clientRequestId: "request-1" },
    files: [
      {
        id: "local-file",
        name: "image.png",
        contentType: "image/png",
        bytes: 1200,
      },
    ],
    receiptId: "receipt-1",
    createdAt: request.createdAt,
  } satisfies StoredResult;
  assert.deepEqual(testResults([result], [request], "demo-b"), [result]);
  assert.deepEqual(testResults([result], [request], "demo-a"), []);
  assert.deepEqual(
    testResults([{ ...result, source: "SDK" }], [request], "demo-b"),
    [],
  );
  assert.deepEqual(
    testResults(
      [{ ...result, payload: { clientRequestId: "other" } }],
      [request],
      "demo-b",
    ),
    [],
  );
  const restored = JSON.parse(JSON.stringify(result)) as StoredResult;
  assert.equal(
    testResults([restored], [request], "demo-b")[0].files[0].id,
    "local-file",
  );
});
