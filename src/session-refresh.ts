// 示例自身的按需状态读取，不是 SDK 接入要求；不启动任何定时轮询。
export class SessionRefresh {
  private running: Promise<void> | undefined;
  private pending = false;
  private stopped = false;
  private read: () => Promise<void>;

  constructor(read: () => Promise<void>) {
    this.read = read;
  }

  // 操作发生时立即读；已有请求完成后再补读，避免返回操作前的旧状态。
  refresh() {
    if (this.stopped) return Promise.resolve();
    this.pending = true;
    return this.run();
  }

  private run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = Promise.resolve()
      .then(async () => {
        if (this.stopped) return;
        do {
          this.pending = false;
          try {
            await this.read();
          } catch (error) {
            if (!this.pending || this.stopped) throw error;
          }
        } while (this.pending && !this.stopped);
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  stop() {
    this.stopped = true;
    this.pending = false;
  }
}
