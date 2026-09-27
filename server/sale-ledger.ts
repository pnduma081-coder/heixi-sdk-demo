import { randomUUID } from "node:crypto";
import type { JsonObject, MerchantEvent, User } from "../shared/types.ts";
import { AppError, BusinessError, object, string, uuid } from "./errors.ts";
import { digest, type Store } from "./store.ts";

export type SalePolicy = "AUDIT_ONLY" | "LEGACY_BALANCE";

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
      CREATE TABLE IF NOT EXISTS sdk_approval_policies(user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL, policy TEXT NOT NULL CHECK(policy IN ('AUDIT_ONLY','LEGACY_BALANCE')), PRIMARY KEY(user_id,request_id));
      CREATE TABLE IF NOT EXISTS sale_quote_policies(quote_id TEXT PRIMARY KEY REFERENCES sale_quotes(quote_id), policy TEXT NOT NULL CHECK(policy IN ('AUDIT_ONLY','LEGACY_BALANCE')));
      CREATE TABLE IF NOT EXISTS sale_reservations(quote_id TEXT PRIMARY KEY REFERENCES sale_quotes(quote_id), state TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sale_reservation_attempts(attempt_id TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES sale_quotes(quote_id), status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sale_attempts_quote ON sale_reservation_attempts(quote_id,status);
      CREATE INDEX IF NOT EXISTS sale_items_quote ON sale_items(quote_id);
      CREATE TABLE IF NOT EXISTS sale_settlements(settlement_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), quote_id TEXT NOT NULL, client_request_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>=0), original_debit_id TEXT, task_no TEXT NOT NULL, fact_digest TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sale_settlements_item ON sale_settlements(item_id,quote_id,kind,status);
    `);
    // Additive upgrade: old requests/quotes keep their original accounting policy.
    store.transaction(() => {
      store.db.exec(`INSERT OR IGNORE INTO sdk_approval_policies SELECT user_id,id,'LEGACY_BALANCE' FROM requests WHERE operation='sdkApproval';
        INSERT OR IGNORE INTO sale_quote_policies SELECT quote_id,'LEGACY_BALANCE' FROM sale_quotes;`);
    });
    // Upgrade outstanding old approvals conservatively; settled items contribute zero.
    store.db.exec(`INSERT OR IGNORE INTO sale_reservations
      SELECT q.quote_id,'HELD',q.created_at FROM sale_quotes q JOIN requests r
      ON r.user_id=q.user_id AND r.id=q.client_request_id
      WHERE r.status IN ('APPROVED','ACCEPTED','UNCONFIRMED','PENDING') AND EXISTS(SELECT 1 FROM sale_quote_policies p WHERE p.quote_id=q.quote_id AND p.policy='LEGACY_BALANCE')`);
    store.db.exec(`INSERT OR IGNORE INTO sale_reservation_attempts
      SELECT 'legacy:'||h.quote_id,h.quote_id,'UNKNOWN' FROM sale_reservations h
      WHERE h.state='HELD' AND NOT EXISTS(SELECT 1 FROM sale_reservation_attempts a WHERE a.quote_id=h.quote_id)`);
  }
  approvalPolicy(userId: string, requestId: string): SalePolicy {
    return this.store.transaction(() => {
      const old = this.store.db
        .prepare(
          "SELECT policy FROM sdk_approval_policies WHERE user_id=? AND request_id=?",
        )
        .get(userId, requestId);
      if (old) return old.policy as SalePolicy;
      const prior = this.store.db
        .prepare("SELECT 1 FROM requests WHERE user_id=? AND id=?")
        .get(userId, requestId);
      const policy: SalePolicy = prior ? "LEGACY_BALANCE" : "AUDIT_ONLY";
      this.store.db
        .prepare("INSERT INTO sdk_approval_policies VALUES(?,?,?)")
        .run(userId, requestId, policy);
      return policy;
    });
  }
  freezeAudit(user: User, input: SaleQuote) {
    return this.freeze(user, input, undefined, "AUDIT_ONLY");
  }
  records(userId: string) {
    return this.store.db
      .prepare(`SELECT s.settlement_id AS settlementId,s.quote_id AS quoteId,s.client_request_id AS requestId,s.kind,s.amount,s.status,s.created_at AS createdAt,p.policy
      FROM sale_settlements s LEFT JOIN sale_quote_policies p ON p.quote_id=s.quote_id
      WHERE s.user_id=? ORDER BY s.rowid DESC LIMIT 100`)
      .all(userId);
  }
  held(userId: string) {
    return Number(
      this.store.db
        .prepare(`SELECT COALESCE(SUM(i.credits),0) AS amount FROM sale_reservations h
      JOIN sale_quotes q ON q.quote_id=h.quote_id JOIN sale_items i ON i.quote_id=q.quote_id
      WHERE q.user_id=? AND h.state='HELD' AND NOT EXISTS(SELECT 1 FROM sale_settlements s
        WHERE s.item_id=i.item_id AND s.quote_id=q.quote_id AND s.kind='SALE_DEBIT' AND s.status='APPLIED')`)
        .get(userId)?.amount || 0,
    );
  }
  reservations(userId: string) {
    return this.store.db
      .prepare(`SELECT q.quote_id AS quoteId,q.client_request_id AS requestId,
      SUM(i.credits) AS amount,q.created_at AS createdAt FROM sale_reservations h
      JOIN sale_quotes q ON q.quote_id=h.quote_id JOIN sale_items i ON i.quote_id=q.quote_id
      WHERE q.user_id=? AND h.state='HELD' AND NOT EXISTS(SELECT 1 FROM sale_settlements s
        WHERE s.item_id=i.item_id AND s.quote_id=q.quote_id AND s.kind='SALE_DEBIT' AND s.status='APPLIED')
      GROUP BY q.quote_id HAVING SUM(i.credits)>0 ORDER BY q.created_at LIMIT 100`)
      .all(userId);
  }
  private reserve(user: User, quote: SaleQuote) {
    const old = this.store.db
      .prepare("SELECT state FROM sale_reservations WHERE quote_id=?")
      .get(quote.quoteId);
    if (old?.state === "HELD") return false; // Retry uses its original reservation, even after a debit.
    const unsettled = quote.saleItems
      .filter(
        (item) =>
          !this.store.db
            .prepare(
              "SELECT 1 FROM sale_settlements WHERE item_id=? AND kind='SALE_DEBIT' AND status='APPLIED'",
            )
            .get(item.itemId),
      )
      .reduce((sum, item) => sum + item.credits, 0);
    const available = this.store.user(user.id).credits - this.held(user.id);
    if ((unsettled > 0 && available < unsettled) || available < 0)
      throw new BusinessError(
        "INSUFFICIENT_CREDITS",
        "可用算力不足，部分额度可能正在等待生成结算",
      );
    this.store.db
      .prepare(
        "INSERT INTO sale_reservations VALUES(?,'HELD',?) ON CONFLICT(quote_id) DO UPDATE SET state='HELD'",
      )
      .run(quote.quoteId, new Date().toISOString());
    return true;
  }
  async withReservation(
    user: User,
    quote: SaleQuote,
    work: () => Promise<unknown>,
  ) {
    const attemptId = randomUUID();
    this.freeze(user, quote, () => {
      this.reserve(user, quote);
      this.store.db
        .prepare("INSERT INTO sale_reservation_attempts VALUES(?,?,'PENDING')")
        .run(attemptId, quote.quoteId);
    });
    try {
      const result = await work();
      this.store.db
        .prepare(
          "UPDATE sale_reservation_attempts SET status='ACCEPTED' WHERE attempt_id=?",
        )
        .run(attemptId);
      return result;
    } catch (cause) {
      const status =
        cause instanceof AppError && cause.code === "UPSTREAM_REJECTED"
          ? "REJECTED"
          : "UNKNOWN";
      this.store.transaction(() => {
        this.store.db
          .prepare(
            "UPDATE sale_reservation_attempts SET status=? WHERE attempt_id=?",
          )
          .run(status, attemptId);
        // All attempts must be explicitly rejected, including other processes.
        // A crash, unknown reply, successful approval or pending attempt keeps the hold.
        this.store.db
          .prepare(`UPDATE sale_reservations SET state='REJECTED' WHERE quote_id=?
          AND NOT EXISTS(SELECT 1 FROM sale_reservation_attempts a WHERE a.quote_id=sale_reservations.quote_id AND a.status!='REJECTED')
          AND NOT EXISTS(SELECT 1 FROM sale_settlements s WHERE s.quote_id=sale_reservations.quote_id)`)
          .run(quote.quoteId);
      });
      throw cause;
    }
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
  freeze(
    user: User,
    input: SaleQuote,
    reserve?: () => void,
    policy: SalePolicy = "LEGACY_BALANCE",
  ) {
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
      const priorPolicy = this.store.db
        .prepare("SELECT policy FROM sale_quote_policies WHERE quote_id=?")
        .get(quote.quoteId);
      if (priorPolicy && priorPolicy.policy !== policy)
        throw new BusinessError(
          "QUOTE_MISMATCH",
          "原报价的记账方式不能改变，请恢复原请求",
        );
      this.store.db
        .prepare("INSERT OR IGNORE INTO sale_quote_policies VALUES(?,?)")
        .run(quote.quoteId, policy);
      this.reconcile(user.id, quote.quoteId);
      reserve?.();
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
        "SELECT q.user_id,q.client_request_id,p.policy FROM sale_quotes q JOIN sale_quote_policies p ON p.quote_id=q.quote_id WHERE q.quote_id=?",
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
            "SELECT * FROM sale_settlements WHERE settlement_id=? AND status IN ('APPLIED','RECORDED')",
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
      if (quote.policy === "LEGACY_BALANCE")
        this.store.changeBalance(
          userId,
          row.kind === "SALE_DEBIT" ? -Number(row.amount) : Number(row.amount),
          String(row.kind),
          String(row.settlement_id),
        );
      this.store.db
        .prepare("UPDATE sale_settlements SET status=? WHERE settlement_id=?")
        .run(
          quote.policy === "LEGACY_BALANCE" ? "APPLIED" : "RECORDED",
          String(row.settlement_id),
        );
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
