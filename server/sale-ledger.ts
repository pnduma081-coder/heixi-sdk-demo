import type { JsonObject, MerchantEvent, User } from "../shared/types.ts";
import { AppError, BusinessError, object, string, uuid } from "./errors.ts";
import { digest, type Store } from "./store.ts";

export type SaleQuote = {
  quoteId: string;
  externalUserId: string;
  clientRequestId: string;
  estimatedCredits: number;
  expiresAt: string;
  saleItems: Array<{ itemId: string; credits: number }>;
};
export function saleQuote(
  value: unknown,
  user: User,
  clientRequestId: string,
): SaleQuote {
  const input = object(value);
  if (
    input.externalUserId !== user.externalUserId ||
    input.clientRequestId !== clientRequestId ||
    !Array.isArray(input.saleItems) ||
    !input.saleItems.length ||
    input.saleItems.length > 1000
  )
    throw new BusinessError(
      "QUOTE_MISMATCH",
      "平台未提供完整的商户售价报价，暂不能提交生成",
    );
  const saleItems = input.saleItems.map((raw) => {
    const item = object(raw);
    if (!Number.isSafeInteger(item.credits) || Number(item.credits) < 0)
      throw new BusinessError("QUOTE_MISMATCH", "商户售价分项无效");
    return { itemId: uuid(item.itemId), credits: Number(item.credits) };
  });
  const total = saleItems.reduce((sum, item) => sum + item.credits, 0);
  if (
    new Set(saleItems.map((item) => item.itemId)).size !== saleItems.length ||
    !Number.isSafeInteger(total) ||
    input.estimatedCredits !== total ||
    typeof input.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(input.expiresAt))
  )
    throw new BusinessError("QUOTE_MISMATCH", "商户售价总额或报价有效期无效");
  return {
    quoteId: uuid(input.quoteId),
    externalUserId: user.externalUserId,
    clientRequestId,
    estimatedCredits: total,
    expiresAt: input.expiresAt,
    saleItems,
  };
}

type Settlement = {
  settlementId: string;
  quoteId: string;
  clientRequestId: string;
  itemId: string;
  taskNo: string;
  amount: number;
  kind: "SALE_DEBIT" | "SALE_REFUND";
  originalDebitId: string | null;
};
function settlement(event: MerchantEvent): Settlement {
  const input = object(event.data);
  const kind =
    event.eventType === "credits.sale_debited"
      ? "SALE_DEBIT"
      : event.eventType === "credits.sale_refunded"
        ? "SALE_REFUND"
        : undefined;
  if (!kind || !Number.isSafeInteger(input.amount) || Number(input.amount) < 0)
    throw new AppError(400, "用户售价结算事件无效");
  const itemId = uuid(input.itemId),
    debitId = `sale:${itemId}:debit`;
  const settlementId = `sale:${itemId}:${kind === "SALE_DEBIT" ? "debit" : "refund"}`;
  if (
    input.settlementId !== settlementId ||
    (kind === "SALE_REFUND" && input.originalDebitId !== debitId)
  )
    throw new AppError(400, "用户售价结算引用无效");
  return {
    settlementId,
    itemId,
    quoteId: uuid(input.quoteId),
    clientRequestId: string(input.clientRequestId, 64),
    taskNo: string(input.taskNo, 128),
    amount: Number(input.amount),
    kind,
    originalDebitId: kind === "SALE_REFUND" ? debitId : null,
  };
}

export class SaleLedger {
  store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS sale_request_intents(user_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,PRIMARY KEY(user_id,request_id));
      CREATE TABLE IF NOT EXISTS sale_quotes(quote_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), client_request_id TEXT NOT NULL, snapshot TEXT NOT NULL, price_digest TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id,client_request_id));
      CREATE TABLE IF NOT EXISTS sale_items(item_id TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES sale_quotes(quote_id), credits INTEGER NOT NULL CHECK(credits>=0));
      CREATE TABLE IF NOT EXISTS sale_settlements(settlement_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), quote_id TEXT NOT NULL, client_request_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>=0), original_debit_id TEXT, task_no TEXT NOT NULL, fact_digest TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
  }
  started(userId: string, quoteId: string) {
    return Boolean(
      this.store.db
        .prepare(
          "SELECT 1 FROM sale_settlements WHERE user_id=? AND quote_id=? AND kind='SALE_DEBIT' LIMIT 1",
        )
        .get(userId, quoteId),
    );
  }
  quote(userId: string, requestId: string): SaleQuote | undefined {
    const row = this.store.db
      .prepare(
        "SELECT snapshot FROM sale_quotes WHERE user_id=? AND client_request_id=?",
      )
      .get(userId, requestId);
    return row ? JSON.parse(String(row.snapshot)) : undefined;
  }
  freeze(user: User, input: SaleQuote) {
    const quote = saleQuote(input, user, input.clientRequestId);
    return this.store.transaction(() => {
      const priceDigest = digest({
        ...quote,
        saleItems: [...quote.saleItems].sort((a, b) =>
          a.itemId.localeCompare(b.itemId),
        ),
      });
      const old = this.store.db
        .prepare(
          "SELECT * FROM sale_quotes WHERE quote_id=? OR (user_id=? AND client_request_id=?)",
        )
        .get(quote.quoteId, user.id, quote.clientRequestId);
      if (old) {
        if (old.user_id !== user.id || old.price_digest !== priceDigest)
          throw new BusinessError(
            "QUOTE_MISMATCH",
            "原请求已冻结不同的商户售价，请新建请求",
          );
      } else {
        this.store.db
          .prepare("INSERT INTO sale_quotes VALUES(?,?,?,?,?,?)")
          .run(
            quote.quoteId,
            user.id,
            quote.clientRequestId,
            JSON.stringify(quote),
            priceDigest,
            new Date().toISOString(),
          );
        const insert = this.store.db.prepare(
          "INSERT INTO sale_items VALUES(?,?,?)",
        );
        for (const item of quote.saleItems)
          insert.run(item.itemId, quote.quoteId, item.credits);
      }
      this.reconcile(user.id, quote.quoteId);
      return quote;
    });
  }
  receive(event: MerchantEvent) {
    const user = this.store.userByExternal(event.externalUserId),
      item = settlement(event),
      eventDigest = digest(event);
    return this.store.transaction(() => {
      if (this.store.processed(event.eventId, user.id, eventDigest)) return;
      const factDigest = digest({ userId: user.id, ...item });
      const old = this.store.db
        .prepare(
          "SELECT fact_digest FROM sale_settlements WHERE settlement_id=?",
        )
        .get(item.settlementId);
      if (old && old.fact_digest !== factDigest)
        throw new AppError(409, "同一用户售价结算的内容或身份已变化");
      if (!old)
        this.store.db
          .prepare(
            "INSERT INTO sale_settlements VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            item.settlementId,
            user.id,
            item.quoteId,
            item.clientRequestId,
            item.itemId,
            item.kind,
            item.amount,
            item.originalDebitId,
            item.taskNo,
            factDigest,
            "PENDING",
            new Date().toISOString(),
          );
      this.reconcile(user.id, item.quoteId);
      this.store.db
        .prepare("INSERT INTO events VALUES(?,?,?,?)")
        .run(event.eventId, user.id, eventDigest, new Date().toISOString());
    });
  }
  private reconcile(userId: string, quoteId: string) {
    const quote = this.store.db
      .prepare(
        "SELECT user_id,client_request_id FROM sale_quotes WHERE quote_id=?",
      )
      .get(quoteId);
    if (!quote) return; // 回调先到：已持久化，待本地确认报价后再核对，绝不猜价。
    if (quote.user_id !== userId)
      throw new AppError(409, "售价报价不属于回调用户");
    const pending = this.store.db
      .prepare(
        "SELECT * FROM sale_settlements WHERE user_id=? AND quote_id=? AND status='PENDING' ORDER BY CASE kind WHEN 'SALE_DEBIT' THEN 0 ELSE 1 END,rowid",
      )
      .all(userId, quoteId);
    for (const row of pending) {
      const frozen = this.store.db
        .prepare(
          "SELECT credits FROM sale_items WHERE item_id=? AND quote_id=?",
        )
        .get(String(row.item_id), quoteId);
      if (
        !frozen ||
        row.client_request_id !== quote.client_request_id ||
        row.amount !== frozen.credits
      )
        throw new AppError(409, "结算与该次冻结的商户售价不匹配");
      if (row.kind === "SALE_REFUND") {
        const debit = this.store.db
          .prepare(
            "SELECT * FROM sale_settlements WHERE settlement_id=? AND status='APPLIED'",
          )
          .get(String(row.original_debit_id));
        if (!debit) continue;
        if (
          debit.kind !== "SALE_DEBIT" ||
          debit.user_id !== userId ||
          debit.item_id !== row.item_id ||
          debit.quote_id !== quoteId ||
          debit.amount !== row.amount
        )
          throw new AppError(409, "退款不匹配原用户售价扣费");
        // 分镜预付允许 taskNo 转移；退款以不可变 itemId / originalDebitId 为准。
      }
      this.store.changeBalance(
        userId,
        row.kind === "SALE_DEBIT" ? -Number(row.amount) : Number(row.amount),
        String(row.kind),
        String(row.settlement_id),
      );
      this.store.db
        .prepare(
          "UPDATE sale_settlements SET status='APPLIED' WHERE settlement_id=?",
        )
        .run(String(row.settlement_id));
    }
  }
  pending(userId: string) {
    return this.store.db
      .prepare(
        "SELECT settlement_id AS settlementId,quote_id AS quoteId,client_request_id AS clientRequestId,kind,amount FROM sale_settlements WHERE user_id=? AND status='PENDING' ORDER BY rowid DESC LIMIT 100",
      )
      .all(userId) as JsonObject[];
  }
}
