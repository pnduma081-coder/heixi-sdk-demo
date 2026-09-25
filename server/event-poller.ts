import type { User } from "../shared/types.ts";
import type { EventSyncReport } from "./results.ts";

// 每用户独立退避、全局最多两个同步；一个慢用户不阻塞其他用户。
export class EventPoller {
  private schedules = new Map<string, { due: number; delay: number }>();
  private running = new Map<string, Promise<void>>();
  private stopped = false;
  private users: () => User[];
  private sync: (user: User) => Promise<EventSyncReport>;
  private now: () => number;
  private active: (userId: string) => boolean;
  constructor(
    users: () => User[],
    sync: (user: User) => Promise<EventSyncReport>,
    now = Date.now,
    active: (userId: string) => boolean = () => false,
  ) {
    this.users = users;
    this.sync = sync;
    this.now = now;
    this.active = active;
  }
  wake(userId: string) {
    this.schedules.set(userId, { due: this.now(), delay: 0 });
  }
  tick() {
    if (this.stopped) return Promise.resolve();
    const due = this.users()
      .filter(
        (user) =>
          !this.running.has(user.id) &&
          (this.schedules.get(user.id)?.due || 0) <= this.now(),
      )
      .sort(
        (a, b) =>
          (this.schedules.get(a.id)?.due || 0) -
          (this.schedules.get(b.id)?.due || 0),
      );
    const tasks: Promise<void>[] = [];
    for (const user of due.slice(0, Math.max(0, 2 - this.running.size))) {
      const schedule = this.schedules.get(user.id) || { due: 0, delay: 0 };
      this.schedules.set(user.id, schedule);
      const task = Promise.resolve()
        .then(() => this.sync(user))
        .then(
          (report) => {
            const active =
              report.received > 0 ||
              report.processed > 0 ||
              report.hasMore ||
              this.active(user.id);
            return active
              ? 5000
              : Math.min(
                  report.pending ? 60_000 : 300_000,
                  Math.max(30_000, schedule.delay * 2),
                );
          },
          () => Math.min(60_000, Math.max(10_000, schedule.delay * 2)),
        )
        .then((delay) => {
          // 新请求在同步期间唤醒用户时，不能被旧轮次的退避覆盖。
          if (this.schedules.get(user.id) === schedule)
            this.schedules.set(user.id, { delay, due: this.now() + delay });
        })
        .finally(() => this.running.delete(user.id));
      this.running.set(user.id, task);
      tasks.push(task);
    }
    return Promise.all(tasks).then(() => {});
  }
  async stop() {
    this.stopped = true;
    await Promise.all(this.running.values());
  }
}
