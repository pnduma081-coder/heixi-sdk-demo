import { examples } from "../shared/examples.ts";
import type { JsonObject, User } from "../shared/types.ts";
import { AppError, BusinessError, string, uuid } from "./errors.ts";
import type { MerchantClient } from "./merchant.ts";
import { type SaleQuote, saleQuote } from "./sale-ledger.ts";
import type { Store } from "./store.ts";

export class Operations {
  api: MerchantClient;
  store: Store;
  pending = new Map<string, Promise<unknown>>();
  constructor(api: MerchantClient, store: Store) {
    this.api = api;
    this.store = store;
  }
  // 【SDK 对接点 3】批准 SDK 报价：重读平台报价、校验归属与余额、冻结售价后再批准。
  async approve(user: User, input: JsonObject) {
    const quoteId = uuid(input.quoteId),
      clientRequestId = string(input.clientRequestId, 64);
    return this.saved(
      user,
      clientRequestId,
      "sdkApproval",
      { quoteId, clientRequestId },
      async () => {
        const quote = this.confirmQuote(
          user,
          await this.api.request(
            `/open/sdk/generation-quotes/${quoteId}`,
            user.externalUserId,
          ),
          clientRequestId,
          quoteId,
        );
        return this.api.request(
          `/open/sdk/generation-quotes/${quoteId}/approve`,
          user.externalUserId,
          {
            body: { clientRequestId, estimatedCredits: quote.estimatedCredits },
          },
        );
      },
    );
  }
  async call(user: User, operation: string, params: JsonObject) {
    const example = examples.find((item) => item.id === operation);
    if (!example) throw new AppError(400, "不支持的示例操作");
    const body = { ...params };
    if ("externalUserId" in body)
      throw new AppError(400, "身份由后端会话确定，请删除 externalUserId 字段");
    let path: string = example.path;
    if (path.includes("{submissionNo}")) {
      const no = string(body.submissionNo, 64);
      if (!/^GS[A-Za-z0-9-]{1,62}$/.test(no))
        throw new AppError(400, "请填写真实 GS 受理号");
      path = path.replace("{submissionNo}", no);
      delete body.submissionNo;
    }
    if (example.method === "GET")
      return this.api.request(path, user.externalUserId, { query: body });
    const id = string(body.clientRequestId, 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(id))
      throw new AppError(400, "clientRequestId 格式错误");
    this.store.sales.prepareApiRequest(user.id, id);
    return this.saved(user, id, operation, body, async () => {
      let quote = this.store.sales.quote(user.id, id);
      if (!quote) {
        let value: unknown;
        try {
          value = await this.api.request(
            "/open/generation-quotes",
            user.externalUserId,
            { body: { path, input: body } },
          );
        } catch (error) {
          if (error instanceof AppError && [404, 405].includes(error.status))
            throw new AppError(
              503,
              "平台尚未提供商户售价报价接口，暂不能提交生成",
            );
          throw error;
        }
        quote = this.confirmQuote(user, value, id);
      } else this.checkBalance(user, quote);
      await this.api.request(
        `/open/generation-quotes/${quote.quoteId}/approve`,
        user.externalUserId,
        {
          body: {
            clientRequestId: id,
            estimatedCredits: quote.estimatedCredits,
          },
        },
      );
      return this.api.request(
        `/open/generation-quotes/${quote.quoteId}/submit`,
        user.externalUserId,
        { body: {} },
      );
    });
  }
  private checkBalance(user: User, quote: SaleQuote) {
    // 既有扣费回调证明任务已开始，网络超时恢复原受理不能被扣费后的余额拦住。
    if (this.store.sales.started(user.id, quote.quoteId)) return;
    const balance = this.store.user(user.id).credits;
    if (balance < 0 || balance < quote.estimatedCredits)
      throw new BusinessError(
        "INSUFFICIENT_CREDITS",
        "本地用户算力不足，请先增加测试算力",
      );
  }
  private confirmQuote(
    user: User,
    value: unknown,
    requestId: string,
    quoteId?: string,
  ) {
    const quote = saleQuote(value, user, requestId);
    if (quoteId && quote.quoteId !== quoteId)
      throw new BusinessError("QUOTE_MISMATCH", "报价与当前请求不匹配");
    this.checkBalance(user, quote);
    return this.store.sales.freeze(user, quote);
  }

  private saved(
    user: User,
    id: string,
    operation: string,
    body: JsonObject,
    work: () => Promise<unknown>,
  ) {
    const old = this.store.startRequest(user.id, id, operation, body);
    if (old !== undefined) {
      if (operation === "sdkApproval" && !this.store.sales.quote(user.id, id))
        throw new BusinessError(
          "QUOTE_MISMATCH",
          "旧批准缺少商户售价快照，请核对原请求状态后重新发起",
        );
      return Promise.resolve(old);
    }
    const key = `${user.id}:${id}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const promise = work()
      .then((result) => {
        this.store.finishRequest(
          user.id,
          id,
          result,
          operation === "sdkApproval" ? "APPROVED" : "ACCEPTED",
        );
        return result;
      })
      .catch((error) => {
        this.store.finishRequest(user.id, id, undefined, "UNCONFIRMED");
        throw error;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
