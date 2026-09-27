import type { User } from "../shared/types.ts";
import { AppError } from "./errors.ts";
import { digest, type Store } from "./store.ts";

const slowRetryMs = 3600_000;
const recoveryWindowMs = 24 * 3600_000;

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
      CREATE TABLE IF NOT EXISTS api_event_retry_cycles(
        user_id TEXT NOT NULL, event_key TEXT NOT NULL, baseline INTEGER NOT NULL,
        PRIMARY KEY(user_id,event_key),
        FOREIGN KEY(user_id,event_key) REFERENCES api_event_inbox(user_id,event_key)
      );
      CREATE TABLE IF NOT EXISTS api_event_retry_windows(
        user_id TEXT NOT NULL, event_key TEXT NOT NULL, deadline INTEGER NOT NULL,
        PRIMARY KEY(user_id,event_key),
        FOREIGN KEY(user_id,event_key) REFERENCES api_event_inbox(user_id,event_key)
      );
    `);
    // Historical age is unknown: never grant old rows a new recovery window.
    // This also quarantines rows reactivated by the previous release.
    this.expire(Date.now());
  }
  private expire(now: number, userId?: string) {
    this.store.db
      .prepare(`UPDATE api_event_inbox SET status='PAUSED'
      WHERE ${userId === undefined ? "" : "user_id=? AND"} status IN ('PENDING','RETRY_LATER')
      AND NOT EXISTS(SELECT 1 FROM api_event_retry_windows w
        WHERE w.user_id=api_event_inbox.user_id AND w.event_key=api_event_inbox.event_key AND w.deadline>?)`)
      .run(...(userId === undefined ? [] : [userId]), now);
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
        // Duplicate delivery must not extend the original deadline or revive DONE/PAUSED.
        if (!old)
          this.store.db
            .prepare("INSERT INTO api_event_retry_windows VALUES(?,?,?)")
            .run(user.id, key, Date.now() + recoveryWindowMs);
      }
      this.store.saveApiEventCursor(user.id, cursor);
    });
  }
  due(userId: string, now: number, limit = 20, retryLimit = 10) {
    this.expire(now, userId);
    // 给重试保留名额，持续流入的新事件不能让旧失败项永久饥饿；也给新事件留出处理容量。
    const retries = this.store.db
      .prepare(
        "SELECT event_key AS key,payload,attempts FROM api_event_inbox WHERE user_id=? AND status IN ('PENDING','RETRY_LATER') AND attempts>0 AND next_attempt<=? ORDER BY next_attempt,rowid LIMIT ?",
      )
      .all(userId, now, Math.min(limit, retryLimit));
    const fresh = this.store.db
      .prepare(
        "SELECT event_key AS key,payload,attempts FROM api_event_inbox WHERE user_id=? AND status='PENDING' AND attempts=0 ORDER BY rowid LIMIT ?",
      )
      .all(userId, limit - retries.length);
    return [...retries, ...fresh].map((row) => ({
      key: String(row.key),
      value: JSON.parse(String(row.payload)) as unknown,
      attempts: Number(row.attempts),
    }));
  }
  ready(userId: string, key: string, now: number) {
    return Boolean(
      this.store.db
        .prepare(`SELECT 1 FROM api_event_inbox i
      JOIN api_event_retry_windows w ON w.user_id=i.user_id AND w.event_key=i.event_key
      WHERE i.user_id=? AND i.event_key=? AND i.status IN ('PENDING','RETRY_LATER')
        AND i.next_attempt<=? AND w.deadline>?`)
        .get(userId, key, now, now),
    );
  }
  nextRetryAt(userId: string, now: number) {
    const row = this.store.db
      .prepare(`SELECT MIN(i.next_attempt) AS at FROM api_event_inbox i
      JOIN api_event_retry_windows w ON w.user_id=i.user_id AND w.event_key=i.event_key
      WHERE i.user_id=? AND i.status IN ('PENDING','RETRY_LATER') AND i.attempts>0
        AND w.deadline>? AND i.next_attempt<w.deadline`)
      .get(userId, now);
    return row?.at == null ? undefined : Number(row.at);
  }
  complete(userId: string, key: string) {
    this.store.db
      .prepare(
        "UPDATE api_event_inbox SET status='DONE',last_error=NULL WHERE user_id=? AND event_key=?",
      )
      .run(userId, key);
  }
  failed(
    userId: string,
    key: string,
    attempts: number,
    now: number,
    cause?: unknown,
  ) {
    const category =
      cause instanceof AppError
        ? cause.code === "RESULT_SAVE" && cause.status !== 400
          ? "MEDIA"
          : "CONTRACT"
        : "PROCESSING";
    const baseline = Number(
      this.store.db
        .prepare(
          "SELECT baseline FROM api_event_retry_cycles WHERE user_id=? AND event_key=?",
        )
        .get(userId, key)?.baseline || 0,
    );
    const cycleAttempts = Math.max(0, attempts - baseline);
    const deadline = Number(
      this.store.db
        .prepare(
          "SELECT deadline FROM api_event_retry_windows WHERE user_id=? AND event_key=?",
        )
        .get(userId, key)?.deadline || 0,
    );
    const deferred = category !== "CONTRACT" && cycleAttempts + 1 >= 8;
    const delay = deferred
      ? slowRetryMs
      : Math.min(300_000, 5000 * 2 ** Math.min(cycleAttempts, 6));
    const nextAttempt = now + delay;
    // The recovery interval is exclusive of its deadline. If the next normal
    // retry cannot fit, pause now instead of advertising an impossible retry.
    const paused =
      nextAttempt >= deadline ||
      (category === "CONTRACT" && cycleAttempts + 1 >= 3);
    this.store.db
      .prepare(
        "UPDATE api_event_inbox SET status=?,attempts=attempts+1,next_attempt=?,last_error=? WHERE user_id=? AND event_key=?",
      )
      .run(
        paused ? "PAUSED" : deferred ? "RETRY_LATER" : "PENDING",
        paused ? 0 : nextAttempt,
        category,
        userId,
        key,
      );
  }
  diagnostics(userId: string) {
    const labels: Record<string, string> = {
      MEDIA: "媒体下载或保存失败",
      CONTRACT: "事件格式、身份或结算关联不符",
      PROCESSING: "本地处理或存储失败",
    };
    return this.store.db
      .prepare(
        "SELECT event_key,payload,status,attempts,next_attempt,last_error FROM api_event_inbox WHERE user_id=? AND (status='PAUSED' OR (status IN ('PENDING','RETRY_LATER') AND attempts>0)) ORDER BY next_attempt,rowid LIMIT 20",
      )
      .all(userId)
      .map((row) => {
        const raw = JSON.parse(String(row.payload));
        const no = raw?.data?.submissionNo;
        const category = Object.hasOwn(labels, String(row.last_error))
          ? String(row.last_error)
          : "PROCESSING";
        return {
          eventKey: /^[a-f0-9-]{36}$/i.test(String(row.event_key))
            ? String(row.event_key)
            : digest(String(row.event_key)),
          category,
          reason: labels[category],
          attempts: Number(row.attempts),
          paused: row.status === "PAUSED",
          nextAttemptAt:
            row.status === "PAUSED"
              ? null
              : new Date(Number(row.next_attempt)).toISOString(),
          ...(typeof no === "string" && /^GS[A-Za-z0-9-]{1,62}$/.test(no)
            ? { submissionNo: no }
            : {}),
        };
      });
  }
  pending(userId: string) {
    return this.count(userId, "PENDING");
  }
  paused(userId: string) {
    return this.count(userId, "PAUSED");
  }
  deferred(userId: string) {
    return this.count(userId, "RETRY_LATER");
  }
  private count(userId: string, status: string) {
    return Number(
      this.store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM api_event_inbox WHERE user_id=? AND status=?",
        )
        .get(userId, status)?.count || 0,
    );
  }
  retry(userId: string) {
    this.store.transaction(() => {
      // Only this explicit user action can grant historical/expired events a new window.
      this.store.db
        .prepare(`INSERT INTO api_event_retry_windows(user_id,event_key,deadline)
        SELECT user_id,event_key,? FROM api_event_inbox WHERE user_id=? AND status IN ('PENDING','PAUSED','RETRY_LATER')
        ON CONFLICT(user_id,event_key) DO UPDATE SET deadline=excluded.deadline`)
        .run(Date.now() + recoveryWindowMs, userId);
      // Start a new bounded retry cycle without erasing lifetime failure counts.
      this.store.db
        .prepare(`INSERT INTO api_event_retry_cycles(user_id,event_key,baseline)
        SELECT user_id,event_key,attempts FROM api_event_inbox WHERE user_id=? AND status IN ('PAUSED','RETRY_LATER')
        ON CONFLICT(user_id,event_key) DO UPDATE SET baseline=excluded.baseline`)
        .run(userId);
      this.store.db
        .prepare(
          "UPDATE api_event_inbox SET status='PENDING',next_attempt=0 WHERE user_id=? AND status IN ('PENDING','RETRY_LATER','PAUSED')",
        )
        .run(userId);
    });
  }
}
