import type {
  JsonObject,
  RequestRecord,
  StoredResult,
} from "../shared/types.ts";
import { imageCapability, imageOptions } from "./model-options.ts";

export const asObject = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};

export function mainImageChoices(model: JsonObject, resolution?: unknown) {
  const capability = imageCapability(model);
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter(
          (item): item is string => typeof item === "string" && !!item,
        )
      : [];
  const allRatios = strings(capability.outputRatios);
  const mapping = capability.resolutionRatios;
  const ratiosFor = (value: unknown) =>
    mapping === undefined
      ? allRatios
      : strings(asObject(mapping)[String(value)]).filter((ratio) =>
          allRatios.includes(ratio),
        );
  const resolutions = strings(capability.resolutionOptions).filter(
    (value) => ratiosFor(value).length > 0,
  );
  const maximum = capability.maxOutputItems;
  const maxCount =
    typeof maximum === "number" && Number.isInteger(maximum) && maximum > 0
      ? Math.min(maximum, 20)
      : 1;
  return {
    resolutions,
    ratios: resolutions.length ? ratiosFor(resolution) : allRatios,
    counts: Array.from({ length: maxCount }, (_, index) => index + 1),
  };
}

export function mainImageParameters(
  model: JsonObject,
  preference: JsonObject = {},
): JsonObject {
  const options: JsonObject = imageOptions(imageCapability(model), preference);
  for (const key of ["resolution", "ratio"])
    if (preference[key] !== undefined && preference[key] !== options[key])
      throw new Error("所选分辨率或比例不受当前模型支持，请重新选择");
  const outputCount = preference.outputCount ?? 1;
  if (
    typeof outputCount !== "number" ||
    !mainImageChoices(model).counts.includes(outputCount)
  )
    throw new Error("生成张数超出当前模型支持范围，请重新选择");
  return { ...options, outputCount };
}

// 目录中的图片单价乘生成张数仅供预估，不替代平台的实际结算。
export function mainImageCredits(model: JsonObject, params: JsonObject) {
  const pricing = asObject(model.pricing);
  if (
    pricing.schemaVersion !== "1.0" ||
    !Array.isArray(pricing.variants) ||
    typeof params.outputCount !== "number" ||
    !Number.isInteger(params.outputCount) ||
    params.outputCount < 1 ||
    params.outputCount > 20 ||
    typeof params.resolution !== "string"
  )
    return undefined;
  const matches = pricing.variants
    .map(asObject)
    .filter((variant) => variant.resolution === params.resolution);
  if (matches.length !== 1) return undefined;
  const price = matches[0];
  const total =
    typeof price.unitCredit === "number"
      ? price.unitCredit * params.outputCount
      : NaN;
  return price.unit === "REQUEST" &&
    typeof price.unitCredit === "number" &&
    Number.isSafeInteger(price.unitCredit) &&
    price.unitCredit >= 0 &&
    Number.isSafeInteger(total)
    ? total
    : undefined;
}

export function mainImageRequest(
  model: JsonObject,
  asset: { assetId: string; name: string },
  prompt: string,
  clientRequestId: string,
  preference: JsonObject = {},
): JsonObject {
  const capability = imageCapability(model);
  if (
    typeof model.id !== "string" ||
    typeof model.parameterSchemaVersion !== "string"
  )
    throw new Error("模型配置不完整，请重新加载模型");
  if (!asset.assetId || !prompt.trim())
    throw new Error("请上传一张商品图片并填写需求");
  if (
    (typeof capability.minInputImages === "number" &&
      capability.minInputImages > 1) ||
    (typeof capability.maxInputImages === "number" &&
      capability.maxInputImages < 1)
  )
    throw new Error("此模型不支持单张参考图，请选择支持单图的主图模型");
  return {
    clientRequestId,
    feature: "MAIN_IMAGE",
    modelId: model.id,
    parameterSchemaVersion: model.parameterSchemaVersion,
    ...mainImageParameters(model, preference),
    language: "zh-CN",
    contentLanguage: "zh-CN",
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
