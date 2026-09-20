import assert from "node:assert/strict";
import test from "node:test";
import type { RequestRecord, StoredResult } from "../shared/types.ts";
import {
  mainImageRequest,
  submissionNumber,
  testRequests,
  testResults,
} from "../src/api-test.ts";

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
