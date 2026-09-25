import type { User } from "../shared/types.ts";
import type { Store } from "./store.ts";

// 只追踪使用过平台的用户；持久化订阅与完成事实，重启不能丢失补偿同步。
export class EventSyncState {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS event_sync_users(user_id TEXT PRIMARY KEY REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS event_sync_completed(
        user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
        PRIMARY KEY(user_id,request_id)
      );
      CREATE INDEX IF NOT EXISTS requests_sync_user ON requests(user_id,created_at);
      CREATE INDEX IF NOT EXISTS results_sync_request ON results(user_id,json_extract(payload,'$.clientRequestId'));
    `);
  }
  watch(userId: string) {
    this.store.db
      .prepare("INSERT OR IGNORE INTO event_sync_users VALUES(?)")
      .run(userId);
  }
  complete(userId: string, requestId: string) {
    this.store.db
      .prepare("INSERT OR IGNORE INTO event_sync_completed VALUES(?,?)")
      .run(userId, requestId);
  }
  users() {
    return this.store.db
      .prepare(`SELECT id,name,external_user_id AS externalUserId,credits FROM users u WHERE
        EXISTS(SELECT 1 FROM event_sync_users s WHERE s.user_id=u.id) OR
        EXISTS(SELECT 1 FROM requests r WHERE r.user_id=u.id) OR
        EXISTS(SELECT 1 FROM api_event_cursors c WHERE c.user_id=u.id) OR
        EXISTS(SELECT 1 FROM events e WHERE e.user_id=u.id) OR
        EXISTS(SELECT 1 FROM sale_quotes q WHERE q.user_id=u.id)
        ORDER BY u.rowid`)
      .all() as User[];
  }
  active(userId: string, now = Date.now()) {
    // 老的未确认请求仍保留低频补偿；不会因缺失终态无限保持高频，也不会重新提交。
    return Boolean(
      this.store.db
        .prepare(`SELECT 1 FROM requests r WHERE r.user_id=?
          AND r.operation IN ('design','video','apparel','sdkApproval') AND r.created_at>=?
          AND (r.status IN ('ACCEPTED','APPROVED') OR r.created_at>=?)
          AND NOT EXISTS(SELECT 1 FROM event_sync_completed c WHERE c.user_id=r.user_id AND c.request_id=r.id)
          AND NOT EXISTS(SELECT 1 FROM results s WHERE s.user_id=r.user_id AND json_extract(s.payload,'$.clientRequestId')=r.id)
          LIMIT 1`)
        .get(
          userId,
          new Date(now - 24 * 3600_000).toISOString(),
          new Date(now - 600_000).toISOString(),
        ),
    );
  }
}
