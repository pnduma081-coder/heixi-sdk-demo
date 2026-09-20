import type {
  JsonObject,
  RequestRecord,
  StoredResult,
} from "../shared/types.ts";

export const asObject = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && Boolean(item),
      )
    : [];
export function mainImageRequest(
  model: JsonObject,
  asset: { assetId: string; name: string },
  prompt: string,
  clientRequestId: string,
): JsonObject {
  const image = asObject(asObject(model.capabilities).image);
  const ratios = strings(image.outputRatios),
    resolutions = strings(image.resolutionOptions);
  if (
    typeof model.id !== "string" ||
    typeof model.parameterSchemaVersion !== "string" ||
    !ratios.length
  )
    throw new Error("模型配置不完整，请重新加载模型");
  if (!asset.assetId || !prompt.trim())
    throw new Error("请上传一张商品图片并填写需求");
  return {
    clientRequestId,
    feature: "MAIN_IMAGE",
    modelId: model.id,
    parameterSchemaVersion: model.parameterSchemaVersion,
    ratio: ratios.includes("1:1") ? "1:1" : ratios[0],
    ...(resolutions.length
      ? { resolution: resolutions.includes("1K") ? "1K" : resolutions[0] }
      : {}),
    outputCount: 1,
    language: "zh-CN",
    contentLanguage: "NONE",
    platform: "TAOBAO",
    sourceAssetIds: [asset.assetId],
    sourceRoles: ["PRODUCT_MAIN"],
    spec: { kind: "MAIN_IMAGE", productDescription: prompt.trim() },
    context: { example: "api-test", fileName: asset.name },
  };
}
export function testRequests(requests: RequestRecord[]) {
  return requests.filter(
    (item) =>
      item.operation === "design" &&
      item.body.feature === "MAIN_IMAGE" &&
      asObject(item.body.context).example === "api-test",
  );
}
export function testResults(
  results: StoredResult[],
  requests: RequestRecord[],
  userId: string,
) {
  const ids = new Set(testRequests(requests).map((item) => item.id));
  return results.filter(
    (item) =>
      item.userId === userId &&
      item.source === "API" &&
      (asObject(item.payload.context).example === "api-test" ||
        ids.has(String(item.payload.clientRequestId))),
  );
}
export function submissionNumber(value: unknown) {
  const result = asObject(value);
  const no = asObject(result.submission).submissionNo ?? result.submissionNo;
  return typeof no === "string" && /^GS[A-Za-z0-9-]{1,62}$/.test(no) ? no : "";
}
