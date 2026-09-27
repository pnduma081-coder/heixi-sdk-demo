import { randomUUID } from "node:crypto";
import { AppError } from "./errors.ts";
import type { Store } from "./store.ts";

// Persist each attempt: a later rejection cannot disprove an earlier lost response.
export class RequestAttempts {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS request_attempts(
        user_id TEXT NOT NULL, request_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        status TEXT NOT NULL, PRIMARY KEY(user_id,request_id,attempt_id),
        FOREIGN KEY(user_id,request_id) REFERENCES requests(user_id,id)
      );
      INSERT INTO request_attempts
        SELECT user_id,id,'legacy','UNCONFIRMED' FROM requests r
        WHERE response IS NULL AND status IN ('PENDING','UNCONFIRMED')
        AND NOT EXISTS(SELECT 1 FROM request_attempts a WHERE a.user_id=r.user_id AND a.request_id=r.id);
    `);
  }
  begin(userId: string, requestId: string) {
    const id = randomUUID();
    const update = (status: string) =>
      this.store.db
        .prepare(
          "UPDATE request_attempts SET status=? WHERE user_id=? AND request_id=? AND attempt_id=?",
        )
        .run(status, userId, requestId, id);
    this.store.db
      .prepare("INSERT INTO request_attempts VALUES(?,?,?,'NOT_SENT')")
      .run(userId, requestId, id);
    let accepted = false;
    return {
      send: async (work: () => Promise<unknown>) => {
        // Durable before transport; a process crash must remain uncertain.
        this.store.transaction(() => {
          update("UNCONFIRMED");
          this.store.finishRequest(userId, requestId, undefined, "PENDING");
        });
        try {
          const result = await work();
          accepted = true;
          return result;
        } catch (error) {
          if (
            !accepted &&
            error instanceof AppError &&
            error.code === "UPSTREAM_REJECTED"
          )
            update("REJECTED");
          throw error;
        }
      },
      failed: () =>
        this.store.transaction(() => {
          const statuses = this.store.db
            .prepare(
              "SELECT status FROM request_attempts WHERE user_id=? AND request_id=?",
            )
            .all(userId, requestId);
          const status = statuses.some(
            (row) => row.status === "UNCONFIRMED" || row.status === "ACCEPTED",
          )
            ? "UNCONFIRMED"
            : statuses.some((row) => row.status === "REJECTED")
              ? "REJECTED"
              : "NOT_SENT";
          this.store.finishRequest(userId, requestId, undefined, status);
        }),
      complete: () => update("ACCEPTED"),
    };
  }
}
