import type {
  JsonObject,
  MerchantEvent,
  SavedFile,
  SessionState,
  StoredResult,
  User,
} from "../shared/types.ts";
import { AppError, object, resultSaveError, string, uuid } from "./errors.ts";
import { EventInbox } from "./event-inbox.ts";
import { EventSyncState } from "./event-sync-state.ts";
import type { MediaStore } from "./media.ts";
import type { MerchantClient } from "./merchant.ts";
import { digest, type Store } from "./store.ts";

export type EventSyncReport = {
  received: number;
  processed: number;
  pending: number;
  hasMore: boolean;
};

export class ResultService {
  store: Store;
  api: MerchantClient;
  media: Pick<MediaStore, "save">;
  pending = new Map<string, Promise<StoredResult>>();
  private sdkScans = new Map<string, Promise<StoredResult>>();
  private eventPolls = new Map<string, Promise<EventSyncReport>>();
  inbox: EventInbox;
  syncState: EventSyncState;
  onActivity?: (userId: string) => void;
  eventSyncErrors = new Map<string, string>();
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
    this.inbox = new EventInbox(store);
    this.syncState = new EventSyncState(store);
  }
  // API 接收游标与 SDK onResult 游标独立；账务以成功处理的事件为准。
  syncEvents(user: User): Promise<EventSyncReport> {
    this.syncState.watch(user.id);
    const pending = this.eventPolls.get(user.id);
    if (pending) return pending;
    const work = this.synchronize(user).finally(() =>
      this.eventPolls.delete(user.id),
    );
    this.eventPolls.set(user.id, work);
    return work;
  }
  syncIssue(userId: string) {
    const count = this.inbox.pending(userId);
    return (
      [
        this.eventSyncErrors.get(userId),
        count
          ? `${count} 条事件已保存在本地但尚未处理成功；后续事件继续同步，请重试或排查，勿视为已结算。`
          : "",
      ]
        .filter(Boolean)
        .join("\n") || undefined
    );
  }
  private async synchronize(user: User): Promise<EventSyncReport> {
    let report = { received: 0, hasMore: false };
    let fetchError: unknown;
    try {
      report = await this.pullEvents(user);
      this.eventSyncErrors.delete(user.id);
    } catch (error) {
      fetchError = error;
      this.eventSyncErrors.set(
        user.id,
        "事件接收未完成，接收游标保留在上次成功页；本地已接收事件仍会重试处理，请检查凭据、网络与事件身份。",
      );
    }
    let processed = 0;
    for (const item of this.inbox.due(user.id, Date.now())) {
      try {
        await this.processEvent(user, item.value);
        this.inbox.complete(user.id, item.key);
        processed++;
      } catch {
        this.inbox.failed(user.id, item.key, item.attempts, Date.now());
      }
    }
    if (fetchError) throw fetchError;
    return { ...report, processed, pending: this.inbox.pending(user.id) };
  }
  private async pullEvents(user: User) {
    const cursor = this.store.apiEventCursor(user.id);
    const data = object(
      await this.api.request("/open/events", user.externalUserId, {
        query: { limit: 20, ...(cursor ? { cursor } : {}) },
        timeoutMs: 10_000,
      }),
    );
    if (
      !Array.isArray(data.items) ||
      data.items.length > 20 ||
      typeof data.hasMore !== "boolean"
    )
      throw new AppError(502, "平台事件分页格式错误");
    if (!data.items.length) {
      if (data.hasMore) throw new AppError(502, "平台事件空页不能继续翻页");
      return { received: 0, hasMore: false };
    }
    const next = uuid(data.nextCursor);
    if (next === cursor || object(data.items.at(-1)).eventId !== next)
      throw new AppError(502, "平台事件游标未前进或与分页不匹配");
    // 原文和接收游标同一事务落盘；即使未知事件或媒体保存失败，也不会丢失待处理事实。
    this.inbox.receive(user, data.items, next);
    return { received: data.items.length, hasMore: data.hasMore };
  }
  private async processEvent(user: User, raw: unknown) {
    const event = object(raw) as unknown as MerchantEvent;
    uuid(event.eventId);
    object(event.data);
    if (
      event.eventVersion !== "merchant-events/v1" ||
      event.externalUserId !== user.externalUserId
    )
      throw new AppError(403, "事件版本或用户不匹配");
    if (
      ["credits.sale_debited", "credits.sale_refunded"].includes(
        event.eventType,
      )
    )
      this.store.sales.receive(event);
    else if (
      [
        "credits.debited",
        "credits.refunded",
        "credits.license_debited",
      ].includes(event.eventType)
    )
      this.store.creditEvent(event);
    else if (event.eventType === "generation.finished") {
      if (event.data.requestChannel === "API") await this.generation(event);
      else if (event.data.requestChannel !== "SDK")
        throw new AppError(502, "未知生成渠道");
      if (
        typeof event.data.clientRequestId !== "string" ||
        !event.data.clientRequestId.trim() ||
        !["SUCCEEDED", "PARTIAL", "FAILED"].includes(String(event.data.status))
      )
        throw new AppError(502, "生成终态事件格式错误");
      this.syncState.complete(user.id, event.data.clientRequestId);
    } else if (
      !["submission.status_changed", "task.status_changed"].includes(
        event.eventType,
      )
    )
      throw new AppError(502, "未知平台事件类型，请检查协议版本");
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
  // 【SDK 对接点 4】扫描进度与结果确认分开持久化；同一用户串行核对结果顺序。
  async sdk(user: User, eventId: string) {
    uuid(eventId);
    return this.once(user, "SDK", eventId, () => {
      const prior = this.sdkScans.get(user.id);
      const scan = (
        prior ? prior.catch(() => undefined) : Promise.resolve()
      ).then(() => this.scanSdk(user, eventId));
      this.sdkScans.set(user.id, scan);
      return scan.finally(() => {
        if (this.sdkScans.get(user.id) === scan) this.sdkScans.delete(user.id);
      });
    });
  }
  private async scanSdk(user: User, eventId: string) {
    const saved = this.store.result("SDK", eventId, user.id);
    if (saved) return saved;
    let cursor =
      this.store.sdkScanCursor(user.id) ?? this.store.cursor(user.id);
    const started = Date.now();
    for (let page = 0; page < 100 && Date.now() - started < 20_000; page++) {
      const data = object(
        await this.api.request("/open/events", user.externalUserId, {
          query: { limit: 20, ...(cursor ? { cursor } : {}) },
          timeoutMs: 10_000,
        }),
      );
      if (
        !Array.isArray(data.items) ||
        data.items.length > 20 ||
        typeof data.hasMore !== "boolean"
      )
        throw new AppError(502, "平台事件列表格式错误");
      if (!data.items.length) {
        if (data.hasMore) throw new AppError(502, "平台事件空页不能继续翻页");
        throw new AppError(404, "未找到当前用户的 SDK 结果事件");
      }
      const next = uuid(data.nextCursor);
      if (next === cursor || object(data.items.at(-1)).eventId !== next)
        throw new AppError(502, "平台事件游标未前进或与分页不匹配");
      for (const raw of data.items) {
        const event = object(raw) as unknown as MerchantEvent;
        uuid(event.eventId);
        object(event.data);
        if (
          event.externalUserId !== user.externalUserId ||
          event.eventVersion !== "merchant-events/v1"
        )
          throw new AppError(403, "事件用户或版本不匹配");
        if (
          event.eventType !== "generation.finished" ||
          event.data.requestChannel !== "SDK"
        )
          continue;
        if (event.eventId !== eventId)
          throw new AppError(409, "请先处理更早的 SDK 结果事件");
        // 结果落盘失败时不越过该 SDK 事件；成功时与确认游标在同一事务推进。
        return this.saveGeneration(user, "SDK", event);
      }
      // 此页没有 SDK 结果，记住扫描位置；不改变给浏览器的 resultCursor 或 API 接收游标。
      this.store.saveSdkScanCursor(user.id, next);
      cursor = next;
      if (!data.hasMore)
        throw new AppError(404, "未找到当前用户的 SDK 结果事件");
    }
    throw new AppError(409, "SDK 历史事件仍在补拉，扫描进度已保存，请重试");
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
