import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  JsonObject,
  Ledger,
  MerchantEvent,
  RequestRecord,
  SavedFile,
  StoredResult,
  User,
} from "../shared/types.ts";
import { AppError, BusinessError } from "./errors.ts";
import { SaleLedger } from "./sale-ledger.ts";

const userColumns = "id, name, external_user_id AS externalUserId, credits";
export const digest = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
            )
          : item,
      ),
    )
    .digest("hex");
export class Store {
  db: DatabaseSync;
  sales: SaleLedger;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
      );
      this.transaction(() => {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, external_user_id TEXT UNIQUE NOT NULL, credits INTEGER NOT NULL DEFAULT 0 CHECK(credits BETWEEN -9007199254740991 AND 9007199254740991));
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, delta INTEGER NOT NULL, balance INTEGER NOT NULL, reference TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id, kind, reference));
      CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), digest TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), source TEXT NOT NULL, reference TEXT NOT NULL, submission_no TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, files TEXT NOT NULL, receipt_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(source, reference));
      CREATE TABLE IF NOT EXISTS requests(id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), operation TEXT NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, response TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,id));
      CREATE TABLE IF NOT EXISTS platform_credit_events(event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, delta INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors(user_id TEXT PRIMARY KEY REFERENCES users(id), event_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sdk_scan_cursors(user_id TEXT PRIMARY KEY REFERENCES users(id), event_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_event_cursors(user_id TEXT PRIMARY KEY REFERENCES users(id), event_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_request_modes(user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('direct','quote')), PRIMARY KEY(user_id,request_id));
    `);
        for (const [id, name] of [
          ["a", "测试用户 A"],
          ["b", "测试用户 B"],
        ]) {
          this.db
            .prepare(
              "INSERT OR IGNORE INTO users(id,name,external_user_id) VALUES(?,?,?)",
            )
            .run(`demo-${id}`, name, `demo-user-${id}`);
        }
      });
      this.sales = new SaleLedger(this);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  users() {
    return this.db
      .prepare(`SELECT ${userColumns} FROM users ORDER BY rowid`)
      .all() as User[];
  }
  user(id: string) {
    const row = this.db
      .prepare(`SELECT ${userColumns} FROM users WHERE id=?`)
      .get(id) as User | undefined;
    if (!row) throw new AppError(404, "用户不存在");
    return row;
  }
  userByExternal(externalId: string) {
    const row = this.db
      .prepare(`SELECT ${userColumns} FROM users WHERE external_user_id=?`)
      .get(externalId) as User | undefined;
    if (!row) throw new AppError(404, "回调用户未在本地建立");
    return row;
  }
  addUser(name: string) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO users(id,name,external_user_id) VALUES(?,?,?)")
      .run(id, name, `demo-user-${id}`);
    return this.user(id);
  }
  newSession(userId: string, oldToken?: string) {
    this.user(userId);
    const token = randomBytes(32).toString("base64url");
    this.transaction(() => {
      if (oldToken)
        this.db.prepare("DELETE FROM sessions WHERE token=?").run(oldToken);
      this.db
        .prepare("DELETE FROM sessions WHERE expires_at<?")
        .run(Date.now());
      this.db
        .prepare("INSERT INTO sessions VALUES(?,?,?)")
        .run(token, userId, Date.now() + 24 * 3600_000);
    });
    return token;
  }
  session(token?: string) {
    if (!token) return null;
    const row = this.db
      .prepare("SELECT user_id FROM sessions WHERE token=? AND expires_at>?")
      .get(token, Date.now());
    return row ? this.user(String(row.user_id)) : null;
  }
  selectSessionUser(token: string | undefined, userId: string) {
    const user = this.user(userId);
    if (
      !token ||
      this.db
        .prepare("UPDATE sessions SET user_id=? WHERE token=? AND expires_at>?")
        .run(userId, token, Date.now()).changes !== 1
    )
      throw new AppError(401, "会话已失效，请刷新页面重新选择用户");
    return user;
  }
  ledger(userId: string) {
    return this.db
      .prepare(
        "SELECT id,user_id AS userId,kind,delta,balance,reference,created_at AS createdAt FROM ledger WHERE user_id=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(userId) as Ledger[];
  }
  addCredit(userId: string, amount: number, requestId: string) {
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new AppError(400, "充值数量必须是正整数");
    this.transaction(() => {
      const old = this.db
        .prepare(
          "SELECT delta FROM ledger WHERE user_id=? AND kind='TOPUP' AND reference=?",
        )
        .get(userId, requestId);
      if (old) {
        if (old.delta !== amount)
          throw new AppError(409, "同一充值请求的数量已变化");
        return;
      }
      this.changeBalance(userId, amount, "TOPUP", requestId);
    });
    return this.user(userId);
  }
  changeBalance(
    userId: string,
    delta: number,
    kind: string,
    reference: string,
  ) {
    const balance = this.user(userId).credits + delta;
    if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(balance))
      throw new AppError(409, "算力超出安全整数范围");
    // 保留已发生的用户售价或历史许可扣款；负余额会阻止后续批准。
    this.db
      .prepare("UPDATE users SET credits=? WHERE id=?")
      .run(balance, userId);
    this.db
      .prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?)")
      .run(
        randomUUID(),
        userId,
        kind,
        delta,
        balance,
        reference,
        new Date().toISOString(),
      );
  }
  processed(eventId: string, userId: string, hash?: string) {
    const old = this.db
      .prepare("SELECT user_id,digest FROM events WHERE event_id=?")
      .get(eventId);
    if (!old) return false;
    if (old.user_id !== userId || (hash && old.digest !== hash))
      throw new AppError(409, "事件身份或内容与已保存记录不一致");
    return true;
  }
  creditEvent(event: MerchantEvent) {
    if (
      ![
        "credits.debited",
        "credits.refunded",
        "credits.license_debited",
      ].includes(event.eventType)
    )
      throw new AppError(400, "平台成本事件类型错误");
    const user = this.userByExternal(event.externalUserId),
      hash = digest(event);
    const delta = event.data.delta;
    if (
      typeof delta !== "number" ||
      !Number.isSafeInteger(delta) ||
      (event.eventType === "credits.refunded" ? delta <= 0 : delta >= 0)
    )
      throw new AppError(400, "算力事件金额无效");
    this.transaction(() => {
      if (this.processed(event.eventId, user.id, hash)) return;
      // AI 成本回调只记平台成本；模板许可沿用原行为，不属于生成售价结算。
      this.db
        .prepare("INSERT INTO platform_credit_events VALUES(?,?,?,?,?,?)")
        .run(
          event.eventId,
          user.id,
          event.eventType,
          delta,
          JSON.stringify(event.data),
          new Date().toISOString(),
        );
      if (event.eventType === "credits.license_debited")
        this.changeBalance(user.id, delta, event.eventType, event.eventId);
      this.db
        .prepare("INSERT INTO events VALUES(?,?,?,?)")
        .run(event.eventId, user.id, hash, new Date().toISOString());
    });
  }
  platformCosts(userId: string) {
    return this.db
      .prepare(
        "SELECT event_id AS eventId,kind,delta,payload,created_at AS createdAt FROM platform_credit_events WHERE user_id=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(userId)
      .map((row) => ({ ...row, payload: JSON.parse(String(row.payload)) }));
  }
  cursor(userId: string) {
    return this.db
      .prepare("SELECT event_id FROM cursors WHERE user_id=?")
      .get(userId)?.event_id as string | undefined;
  }
  apiEventCursor(userId: string) {
    return this.db
      .prepare("SELECT event_id FROM api_event_cursors WHERE user_id=?")
      .get(userId)?.event_id as string | undefined;
  }
  sdkScanCursor(userId: string) {
    return this.db
      .prepare("SELECT event_id FROM sdk_scan_cursors WHERE user_id=?")
      .get(userId)?.event_id as string | undefined;
  }
  saveSdkScanCursor(userId: string, cursor: string) {
    this.db
      .prepare(
        "INSERT INTO sdk_scan_cursors VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET event_id=excluded.event_id",
      )
      .run(userId, cursor);
  }
  saveApiEventCursor(userId: string, cursor: string) {
    this.db
      .prepare(
        "INSERT INTO api_event_cursors VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET event_id=excluded.event_id",
      )
      .run(userId, cursor);
  }
  // 新 API 请求固定直接生成；旧表仅用于保留历史请求恢复语义。
  apiRequestMode(userId: string, id: string) {
    return this.transaction(() => {
      const saved = this.db
        .prepare(
          "SELECT mode FROM api_request_modes WHERE user_id=? AND request_id=?",
        )
        .get(userId, id);
      if (saved) return saved.mode as "direct" | "quote";
      const prior = this.db
        .prepare("SELECT response FROM requests WHERE user_id=? AND id=?")
        .get(userId, id);
      const quoted = this.db
        .prepare(
          "SELECT 1 FROM sale_request_intents WHERE user_id=? AND request_id=?",
        )
        .get(userId, id);
      if (prior && !quoted && !prior.response)
        throw new AppError(
          409,
          "旧请求缺少明确的生成模式，请先核对原受理状态，不能改用直接生成重提",
        );
      const mode = prior || quoted ? "quote" : "direct";
      this.db
        .prepare("INSERT INTO api_request_modes VALUES(?,?,?)")
        .run(userId, id, mode);
      return mode;
    });
  }
  result(source: string, reference: string, userId: string) {
    const row = this.db
      .prepare("SELECT * FROM results WHERE source=? AND reference=?")
      .get(source, reference);
    if (!row) return undefined;
    if (row.user_id !== userId) throw new AppError(403, "结果不属于当前用户");
    return this.presentResult(row);
  }
  saveResult(
    user: User,
    source: string,
    reference: string,
    payload: JsonObject,
    files: SavedFile[],
    event?: MerchantEvent,
  ) {
    return this.transaction(() => {
      const old = this.result(source, reference, user.id);
      if (old) return old;
      const hash = event ? digest(event) : "";
      if (event) this.processed(event.eventId, user.id, hash);
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO results VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(
          id,
          user.id,
          source,
          reference,
          String(payload.submissionNo || ""),
          String(payload.status || "APPLIED"),
          JSON.stringify(payload),
          JSON.stringify(files),
          randomUUID(),
          new Date().toISOString(),
        );
      if (event)
        this.db
          .prepare("INSERT OR IGNORE INTO events VALUES(?,?,?,?)")
          .run(event.eventId, user.id, hash, new Date().toISOString());
      if (source === "SDK") {
        this.db
          .prepare(
            "INSERT INTO cursors VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET event_id=excluded.event_id",
          )
          .run(user.id, reference);
        this.saveSdkScanCursor(user.id, reference);
      }
      return this.result(source, reference, user.id) as StoredResult;
    });
  }
  private presentResult(row: Record<string, unknown>): StoredResult {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      source: String(row.source),
      reference: String(row.reference),
      submissionNo: String(row.submission_no),
      status: String(row.status),
      payload: JSON.parse(String(row.payload)),
      files: JSON.parse(String(row.files)),
      receiptId: String(row.receipt_id),
      createdAt: String(row.created_at),
    };
  }
  results(userId: string) {
    return this.db
      .prepare(
        "SELECT * FROM results WHERE user_id=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(userId)
      .map((row) => this.presentResult(row));
  }
  file(userId: string, id: string) {
    for (const row of this.db
      .prepare("SELECT files FROM results WHERE user_id=?")
      .all(userId)) {
      const file = (JSON.parse(String(row.files)) as SavedFile[]).find(
        (file) => file.id === id,
      );
      if (file) return file;
    }
    throw new AppError(404, "文件不存在或不属于当前用户");
  }
  startRequest(
    userId: string,
    id: string,
    operation: string,
    body: JsonObject,
  ) {
    const hash = digest({ operation, body });
    const old = this.db
      .prepare("SELECT * FROM requests WHERE user_id=? AND id=?")
      .get(userId, id);
    if (old) {
      if (old.digest !== hash)
        throw new BusinessError(
          "REQUEST_CONFLICT",
          "同一 clientRequestId 的参数已变化；新操作请生成新请求号",
        );
      return old.response ? JSON.parse(String(old.response)) : undefined;
    }
    this.db
      .prepare("INSERT INTO requests VALUES(?,?,?,?,?,NULL,'PENDING',?)")
      .run(
        id,
        userId,
        operation,
        JSON.stringify(body),
        hash,
        new Date().toISOString(),
      );
    return undefined;
  }
  finishRequest(userId: string, id: string, response: unknown, status: string) {
    this.db
      .prepare(
        "UPDATE requests SET response=?,status=? WHERE user_id=? AND id=?",
      )
      .run(
        response === undefined ? null : JSON.stringify(response),
        status,
        userId,
        id,
      );
  }
  requests(userId: string) {
    return this.db
      .prepare(
        "SELECT id,operation,body,response,status,created_at AS createdAt FROM requests WHERE user_id=? ORDER BY rowid DESC LIMIT 30",
      )
      .all(userId)
      .map((row) => ({
        ...row,
        body: JSON.parse(String(row.body)),
        response: row.response ? JSON.parse(String(row.response)) : null,
      })) as RequestRecord[];
  }
}
