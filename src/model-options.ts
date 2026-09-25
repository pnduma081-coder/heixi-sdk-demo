import type { JsonObject } from "../shared/types.ts";

const object = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
const preferred = (values: string[], value: unknown) =>
  typeof value === "string" && values.includes(value) ? value : values[0];

export function imageCapability(model: JsonObject, feature = "MAIN_IMAGE") {
  const capabilities = object(model.capabilities),
    design = object(capabilities.design);
  if (design.feature === feature) return design;
  const byFeature = object(object(capabilities.designByFeature)[feature]);
  return Object.keys(byFeature).length ? byFeature : object(capabilities.image);
}

// 分辨率与比例是组合约束；不能把两个列表的默认值任意拼接。
export function imageOptions(
  capability: JsonObject,
  preference: JsonObject = {},
) {
  const ratios = strings(capability.outputRatios),
    resolutions = strings(capability.resolutionOptions);
  if (!ratios.length) throw new Error("模型没有可用的图片比例，请重新选择模型");
  const quality = preferred(
    strings(capability.qualityOptions),
    preference.quality,
  );
  if (!resolutions.length)
    return {
      ratio: preferred(ratios, preference.ratio ?? "1:1"),
      ...(quality ? { quality } : {}),
    };
  const firstResolution = preferred(resolutions, preference.resolution ?? "1K");
  const mapping =
    capability.resolutionRatios === undefined
      ? undefined
      : object(capability.resolutionRatios);
  for (const resolution of [
    firstResolution,
    ...resolutions.filter((value) => value !== firstResolution),
  ]) {
    const allowed = mapping
      ? strings(mapping[resolution]).filter((ratio) => ratios.includes(ratio))
      : ratios;
    if (allowed.length)
      return {
        ratio: preferred(allowed, preference.ratio ?? "1:1"),
        resolution,
        ...(quality ? { quality } : {}),
      };
  }
  throw new Error("模型没有可用的分辨率与比例组合，请重新选择模型");
}

export function videoOptions(
  capability: JsonObject,
  preference: JsonObject = {},
) {
  const ratio = preferred(strings(capability.ratios), preference.ratio);
  const resolution = preferred(
    strings(capability.resolutions),
    preference.resolution,
  );
  const duration = preferred(
    strings(capability.durations),
    preference.duration,
  );
  if (!ratio || !resolution || !duration)
    throw new Error("视频模型参数不完整，请重新选择模型");
  const orientation = preferred(
    strings(capability.orientations),
    preference.orientation,
  );
  return {
    ratio,
    resolution,
    duration,
    ...(orientation ? { orientation } : {}),
  };
}
