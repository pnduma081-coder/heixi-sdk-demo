import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { MerchantEvent } from "../shared/types.ts";
import { AppError, object, string, uuid } from "./errors.ts";

export function webhookHeaders(
  raw: Buffer,
  headers: IncomingHttpHeaders,
  now = Date.now(),
) {
  const timestamp = headers["x-black-rhino-timestamp"],
    keyId = headers["x-black-rhino-key-id"],
    deliveryId = headers["x-black-rhino-delivery-id"],
    eventId = headers["x-black-rhino-event-id"],
    signature = headers["x-black-rhino-signature"];
  if (
    typeof timestamp !== "string" ||
    !/^\d{10,12}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    typeof keyId !== "string" ||
    typeof deliveryId !== "string" ||
    typeof eventId !== "string" ||
    typeof signature !== "string" ||
    !/^v1=[a-f0-9]{64}$/.test(signature) ||
    raw.length > 2 * 1024 * 1024
  )
    throw new AppError(401, "回调签名无效或已过期");
  uuid(keyId);
  uuid(deliveryId);
  uuid(eventId);
  return { timestamp, keyId, deliveryId, eventId, signature };
}

// 【SDK 对接点 5】回调验签：HMAC 覆盖时间戳、keyId、投递号、事件号与原始字节。
export function verifyWebhook(
  raw: Buffer,
  headers: IncomingHttpHeaders,
  keys: Map<string, string>,
  now = Date.now(),
): MerchantEvent {
  const { timestamp, keyId, deliveryId, eventId, signature } = webhookHeaders(
    raw,
    headers,
    now,
  );
  const key = keys.get(keyId);
  if (!key) throw new AppError(401, "回调签名密钥不可用");
  // 签名绑定原始字节与投递标识；不能先 JSON.parse 后重新序列化。
  const expected = createHmac("sha256", key)
    .update(`${timestamp}.${keyId}.${deliveryId}.${eventId}.`)
    .update(raw)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex")))
    throw new AppError(401, "回调签名错误");
  let event: Record<string, unknown>;
  try {
    event = object(JSON.parse(raw.toString("utf8")));
  } catch {
    throw new AppError(400, "回调 JSON 无效");
  }
  if (event.eventId !== eventId || event.eventVersion !== "merchant-events/v1")
    throw new AppError(400, "回调事件格式错误");
  return {
    eventId: uuid(eventId),
    eventVersion: "merchant-events/v1",
    externalUserId: string(event.externalUserId),
    eventType: string(event.eventType),
    occurredAt: string(event.occurredAt),
    data: object(event.data),
  };
}
