import type {
  JsonObject,
  MerchantEvent,
  SavedFile,
  SessionState,
  StoredResult,
  User,
} from "../shared/types.ts";
import { AppError, object, resultSaveError, string, uuid } from "./errors.ts";
import type { MediaStore } from "./media.ts";
import type { MerchantClient } from "./merchant.ts";
import { digest, type Store } from "./store.ts";

export class ResultService {
  store: Store;
  api: MerchantClient;
  media: Pick<MediaStore, "save">;
  pending = new Map<string, Promise<StoredResult>>();
  generationFailures = new Map<
    string,
    NonNullable<SessionState["generationFailure"]>
  >();
  constructor(
    store: Store,
    api: MerchantClient,
    media: Pick<MediaStore, "save">,
  ) {
    this.store = store;
    this.api = api;
    this.media = media;
  }
  private once(
    user: User,
    source: string,
    id: string,
    work: () => Promise<StoredResult>,
  ) {
    const old = this.store.result(source, id, user.id);
    if (old) return Promise.resolve(old);
    const key = `${user.id}:${source}:${id}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const operation = work().finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }
  // 【SDK 对接点 4】保存 SDK 结果：按持久游标读取平台事件，重读权威结果并落盘媒体。
  async sdk(user: User, eventId: string) {
    uuid(eventId);
    return this.once(user, "SDK", eventId, async () => {
      // 浏览器只传事件号；从已保存游标继续读取平台事件，不能让任意事件号跳过旧结果。
      let cursor = this.store.cursor(user.id);
      for (let page = 0; page < 100; page++) {
        const data = object(
          await this.api.request("/open/events", user.externalUserId, {
            query: cursor ? { cursor } : {},
          }),
        );
        if (!Array.isArray(data.items))
          throw new AppError(502, "平台事件列表格式错误");
        for (const raw of data.items) {
          const event = object(raw) as unknown as MerchantEvent;
          if (event.externalUserId !== user.externalUserId)
            throw new AppError(403, "事件用户不匹配");
          if (
            event.eventType !== "generation.finished" ||
            event.data.requestChannel !== "SDK"
          )
            continue;
          if (event.eventId !== eventId)
            throw new AppError(409, "请先处理更早的 SDK 结果事件");
          return this.saveGeneration(user, "SDK", event);
        }
        if (
          !data.hasMore ||
          typeof data.nextCursor !== "string" ||
          data.nextCursor === cursor
        )
          break;
        cursor = data.nextCursor;
      }
      throw new AppError(404, "未找到当前用户的 SDK 结果事件");
    });
  }
  async generation(event: MerchantEvent) {
    if (
      event.eventType !== "generation.finished" ||
      event.data.requestChannel !== "API"
    )
      throw new AppError(400, "生成回调只接收 API 终态事件");
    const user = this.store.userByExternal(event.externalUserId);
    this.store.processed(event.eventId, user.id, digest(event));
    try {
      const saved = await this.once(user, "API", event.eventId, () =>
        this.saveGeneration(user, "API", event),
      );
      if (
        this.generationFailures.get(user.id)?.submissionNo ===
        saved.submissionNo
      )
        this.generationFailures.delete(user.id);
      return saved;
    } catch (error) {
      const submissionNo = event.data.submissionNo;
      if (
        typeof submissionNo === "string" &&
        /^GS[A-Za-z0-9-]{1,62}$/.test(submissionNo)
      ) {
        const oldest = this.generationFailures.keys().next().value;
        if (this.generationFailures.size >= 100 && oldest !== undefined)
          this.generationFailures.delete(oldest);
        this.generationFailures.set(user.id, {
          submissionNo,
          reason:
            error instanceof AppError && error.code === "RESULT_SAVE"
              ? error.message
              : "结果保存失败，请检查服务端处理状态",
          at: new Date().toISOString(),
        });
      }
      throw error;
    }
  }
  private async saveGeneration(
    user: User,
    source: string,
    event: MerchantEvent,
  ) {
    const submissionNo = string(event.data.submissionNo, 64);
    if (!/^GS[A-Za-z0-9-]{1,62}$/.test(submissionNo))
      throw new AppError(400, "受理号格式错误");
    // API 回调已由 HTTP 入口验签，完整结果直接取签名覆盖的 data。
    // SDK 浏览器只提交事件号，仍需服务端核对平台结果。
    const payload =
      source === "API"
        ? object(event.data)
        : object(
            await this.api.request(
              `/open/generations/${submissionNo}`,
              user.externalUserId,
            ),
          );
    if (
      source === "API" &&
      (typeof payload.clientRequestId !== "string" ||
        !payload.clientRequestId.trim() ||
        !["SUCCEEDED", "PARTIAL", "FAILED"].includes(String(payload.status)) ||
        !Array.isArray(payload.tasks))
    )
      throw resultSaveError(400, "生成回调结果格式错误或尚未终态");
    if (
      payload.submissionNo !== submissionNo ||
      payload.clientRequestId !== event.data.clientRequestId ||
      (source !== "API" && payload.terminal !== true) ||
      !Array.isArray(payload.tasks)
    )
      throw resultSaveError(409, "权威生成结果尚未就绪或请求不匹配");
    const media: JsonObject[] = [];
    for (const raw of payload.tasks) {
      const task = object(raw);
      if (task.role !== "OUTPUT") continue;
      if (!Array.isArray(task.results))
        throw new AppError(502, "任务结果格式错误");
      for (const asset of task.results) media.push(object(asset));
    }
    const files = await this.saveFiles(user, source, event.eventId, media);
    return this.store.saveResult(
      user,
      source,
      event.eventId,
      payload,
      files,
      event,
    );
  }
  private async saveFiles(
    user: User,
    source: string,
    reference: string,
    items: JsonObject[],
  ) {
    const files: SavedFile[] = [];
    for (const [index, item] of items.entries()) {
      if (item.available === false || typeof item.url !== "string")
        throw resultSaveError(409, "结果媒体已失效，尚未保存成功");
      files.push(
        await this.media.save(
          item.url,
          `${user.id}:${source}:${reference}:${index}`,
          String(item.type),
        ),
      );
    }
    return files;
  }
}
