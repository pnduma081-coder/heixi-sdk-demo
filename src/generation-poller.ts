import { statusPollingDecision } from "./status-polling.ts";

export type PollingState = "idle" | "running" | "paused" | "complete";

// 仅查询一个明确的生成请求；页面隐藏、终态、连续失败和总时限均能停止自动请求。
export class GenerationPoller<T> {
  private options: {
    read: (submissionNo: string, signal: AbortSignal) => Promise<T>;
    apply: (value: T, submissionNo: string) => boolean;
    error: (cause: unknown) => void;
    state: (state: PollingState) => void;
    hidden: () => boolean;
  };
  private key = "";
  private mode: PollingState = "idle";
  private revision = 0;
  private startedAt = 0;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private pending: { revision: number; promise: Promise<void> } | undefined;
  private disposed = false;

  constructor(options: GenerationPoller<T>["options"]) {
    this.options = options;
  }
  start(submissionNo: string) {
    this.stop();
    if (this.disposed || !submissionNo) return;
    this.key = submissionNo;
    this.startedAt = Date.now();
    this.failures = 0;
    this.setState("running");
    if (!this.options.hidden()) void this.run(this.revision);
  }
  refresh(submissionNo: string) {
    if (this.disposed || !submissionNo) return Promise.resolve();
    if (this.key !== submissionNo) {
      this.stop();
      this.key = submissionNo;
    }
    clearTimeout(this.timer);
    return this.run(this.revision);
  }
  visibilityChanged() {
    if (this.disposed || this.mode !== "running") return;
    clearTimeout(this.timer);
    if (this.options.hidden()) {
      this.revision++;
      this.controller?.abort();
    } else void this.run(this.revision);
  }
  stop() {
    this.revision++;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.key = "";
    this.setState("idle");
  }
  dispose() {
    this.stop();
    this.disposed = true;
  }
  private setState(state: PollingState) {
    this.mode = state;
    this.options.state(state);
  }
  private run(revision: number): Promise<void> {
    if (this.disposed || revision !== this.revision) return Promise.resolve();
    if (this.pending) {
      if (this.pending.revision === revision) return this.pending.promise;
      // 取消请求收尾后才查询新任务；旧响应无法更新新任务或再启动定时器。
      return this.pending.promise.then(() => this.run(revision));
    }
    if (this.mode === "running" && Date.now() - this.startedAt >= 600_000) {
      this.setState("paused");
      return Promise.resolve();
    }
    const key = this.key;
    const controller = new AbortController();
    this.controller = controller;
    const current = () => !this.disposed && revision === this.revision;
    const promise = Promise.resolve()
      .then(async () => {
        if (!current()) return;
        try {
          const value = await this.options.read(
            key,
            AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          );
          if (!current()) return;
          this.failures = 0;
          if (this.options.apply(value, key)) this.setState("complete");
        } catch (cause) {
          if (!current()) return;
          this.failures++;
          this.options.error(cause);
        }
        if (current() && this.mode === "running") {
          const decision = statusPollingDecision({
            terminal: false,
            saved: false,
            elapsedMs: Date.now() - this.startedAt,
            failures: this.failures,
          });
          if (decision === "paused") this.setState("paused");
        }
      })
      .finally(() => {
        this.pending = undefined;
        if (current() && this.mode === "running" && !this.options.hidden())
          this.timer = setTimeout(() => void this.run(revision), 3000);
      });
    this.pending = { revision, promise };
    return promise;
  }
}
