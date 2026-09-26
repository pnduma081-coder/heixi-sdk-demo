import type { User } from "../shared/types.ts";
import type { EventSyncReport } from "./results.ts";

type Schedule = { user: User; due: number; delay: number };

// Indexed min-heap: wake replaces one user's entry instead of retaining stale nodes.
class DueQueue {
  private items: Schedule[] = [];
  private indexes = new Map<string, number>();
  private compare(a: Schedule, b: Schedule) {
    return a.due - b.due || a.user.id.localeCompare(b.user.id);
  }
  peek() {
    return this.items[0];
  }
  put(item: Schedule) {
    const old = this.indexes.get(item.user.id);
    let index = old ?? this.items.length;
    this.items[index] = item;
    this.indexes.set(item.user.id, index);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.items[parent], this.items[index]) <= 0) break;
      this.swap(index, parent);
      index = parent;
    }
    this.down(index);
  }
  take() {
    const first = this.items[0];
    if (!first) return undefined;
    const last = this.items.pop();
    this.indexes.delete(first.user.id);
    if (this.items.length && last) {
      this.items[0] = last;
      this.indexes.set(last.user.id, 0);
      this.down(0);
    }
    return first;
  }
  private swap(a: number, b: number) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    this.indexes.set(this.items[a].user.id, a);
    this.indexes.set(this.items[b].user.id, b);
  }
  private down(start: number) {
    let index = start;
    while (index * 2 + 1 < this.items.length) {
      let child = index * 2 + 1;
      if (
        child + 1 < this.items.length &&
        this.compare(this.items[child + 1], this.items[child]) < 0
      )
        child++;
      if (this.compare(this.items[index], this.items[child]) <= 0) break;
      this.swap(index, child);
      index = child;
    }
  }
}

export class EventPoller {
  private schedules = new Map<string, Schedule>();
  private queue = new DueQueue();
  private running = new Map<string, Promise<void>>();
  private stopped = false;
  private nextDiscovery = -Infinity;
  private users: () => User[];
  private sync: (user: User) => Promise<EventSyncReport>;
  private now: () => number;
  private active: (userId: string) => boolean;
  private findUser?: (userId: string) => User;
  constructor(
    users: () => User[],
    sync: (user: User) => Promise<EventSyncReport>,
    now = Date.now,
    active: (userId: string) => boolean = () => false,
    findUser?: (userId: string) => User,
  ) {
    this.users = users;
    this.sync = sync;
    this.now = now;
    this.active = active;
    this.findUser = findUser;
  }
  wake(userId: string) {
    if (this.stopped) return;
    const user =
      this.findUser?.(userId) ||
      this.schedules.get(userId)?.user ||
      this.users().find((user) => user.id === userId);
    if (!user) return;
    const item = { user, due: this.now(), delay: 0 };
    this.schedules.set(userId, item);
    if (!this.running.has(userId)) this.queue.put(item);
  }
  tick() {
    if (this.stopped) return Promise.resolve();
    // Discover old or externally-created work periodically, not on every timer tick.
    if (this.now() >= this.nextDiscovery) {
      this.nextDiscovery = this.now() + 30_000;
      for (const user of this.users()) {
        if (this.schedules.has(user.id)) continue;
        const item = { user, due: this.now(), delay: 0 };
        this.schedules.set(user.id, item);
        this.queue.put(item);
      }
    }
    const tasks: Promise<void>[] = [];
    while (
      this.running.size < 2 &&
      this.queue.peek() &&
      this.queue.peek().due <= this.now()
    ) {
      const schedule = this.queue.take();
      if (!schedule) break;
      const user = schedule.user;
      const task = Promise.resolve()
        .then(async () => {
          let delay: number;
          try {
            const started = this.now();
            let report: EventSyncReport;
            let pages = 0;
            do {
              report = await this.sync(user);
              pages++;
            } while (
              !this.stopped &&
              report.hasMore &&
              pages < 3 &&
              this.now() - started < 5000
            );
            delay = report.hasMore
              ? 1000
              : report.received > 0 ||
                  report.processed > 0 ||
                  this.active(user.id)
                ? 5000
                : Math.min(
                    report.pending ? 60_000 : 300_000,
                    Math.max(30_000, schedule.delay * 2),
                  );
          } catch {
            delay = Math.min(60_000, Math.max(10_000, schedule.delay * 2));
          }
          if (this.schedules.get(user.id) === schedule)
            this.schedules.set(user.id, {
              user,
              delay,
              due: this.now() + delay,
            });
        })
        .finally(() => {
          this.running.delete(user.id);
          const next = this.schedules.get(user.id);
          if (!this.stopped && next) this.queue.put(next);
        });
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
