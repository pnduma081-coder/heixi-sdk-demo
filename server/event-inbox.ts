import type { User } from "../shared/types.ts";
import { AppError } from "./errors.ts";
import { digest, type Store } from "./store.ts";

// 游标表示已可靠接收；处理成功单独标记。异常事件保留原文，不伪装为已结算。
export class EventInbox {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS api_event_inbox(
        user_id TEXT NOT NULL REFERENCES users(id), event_key TEXT NOT NULL,
        payload TEXT NOT NULL, digest TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        PRIMARY KEY(user_id,event_key)
      );
      CREATE INDEX IF NOT EXISTS api_event_inbox_due ON api_event_inbox(user_id,status,next_attempt);
    `);
  }
  receive(user: User, items: unknown[], cursor: string) {
    this.store.transaction(() => {
      for (const raw of items) {
        const value =
          raw && typeof raw === "object"
            ? (raw as Record<string, unknown>)
            : {};
        if (
          value.externalUserId !== undefined &&
          value.externalUserId !== user.externalUserId
        )
          throw new AppError(403, "平台返回其他用户事件，停止接收并保留原游标");
        const hash = digest(raw);
        const key =
          typeof value.eventId === "string"
            ? value.eventId
            : `malformed:${hash}`;
        const old = this.store.db
          .prepare(
            "SELECT digest FROM api_event_inbox WHERE user_id=? AND event_key=?",
          )
          .get(user.id, key);
        if (old && old.digest !== hash)
          throw new AppError(409, "同一事件内容变化，停止接收并保留原游标");
        this.store.db
          .prepare(
            "INSERT OR IGNORE INTO api_event_inbox(user_id,event_key,payload,digest) VALUES(?,?,?,?)",
          )
          .run(user.id, key, JSON.stringify(raw), hash);
      }
      this.store.saveApiEventCursor(user.id, cursor);
    });
  }
  due(userId: string, now: number) {
    // 给重试保留名额，持续流入的新事件不能让旧失败项永久饥饿；也给新事件留出处理容量。
    const retries = this.store.db
      .prepare(
        "SELECT event_key AS key,payload,attempts FROM api_event_inbox WHERE user_id=? AND status='PENDING' AND attempts>0 AND next_attempt<=? ORDER BY next_attempt,rowid LIMIT 10",
      )
      .all(userId, now);
    const fresh = this.store.db
      .prepare(
        "SELECT event_key AS key,payload,attempts FROM api_event_inbox WHERE user_id=? AND status='PENDING' AND attempts=0 ORDER BY rowid LIMIT ?",
      )
      .all(userId, 20 - retries.length);
    return [...retries, ...fresh].map((row) => ({
      key: String(row.key),
      value: JSON.parse(String(row.payload)) as unknown,
      attempts: Number(row.attempts),
    }));
  }
  complete(userId: string, key: string) {
    this.store.db
      .prepare(
        "UPDATE api_event_inbox SET status='DONE',last_error=NULL WHERE user_id=? AND event_key=?",
      )
      .run(userId, key);
  }
  failed(userId: string, key: string, attempts: number, now: number) {
    const delay = Math.min(300_000, 5000 * 2 ** Math.min(attempts, 6));
    this.store.db
      .prepare(
        "UPDATE api_event_inbox SET attempts=attempts+1,next_attempt=?,last_error=? WHERE user_id=? AND event_key=?",
      )
      .run(
        now + delay,
        "事件尚未处理成功；原文已保存，待重试或修复对应协议/存储问题。",
        userId,
        key,
      );
  }
  pending(userId: string) {
    return Number(
      this.store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM api_event_inbox WHERE user_id=? AND status='PENDING'",
        )
        .get(userId)?.count || 0,
    );
  }
  retry(userId: string) {
    this.store.db
      .prepare(
        "UPDATE api_event_inbox SET next_attempt=0 WHERE user_id=? AND status='PENDING'",
      )
      .run(userId);
  }
}
