import type { SdkInstance } from "./sdk.ts";

export type WorkspaceTarget = { page: string; resourceId?: string };
export type WorkspaceState = {
  status: "loading" | "navigating" | "ready" | "error";
  error?: unknown;
  retainPage?: boolean;
};
const sameTarget = (a?: WorkspaceTarget, b?: WorkspaceTarget) =>
  a?.page === b?.page && a?.resourceId === b?.resourceId;

export class SdkWorkspace {
  private instance?: SdkInstance;
  private current?: WorkspaceTarget;
  private desired?: WorkspaceTarget;
  private opening?: AbortController;
  private connection?: AbortController;
  private revision = 0;
  private disposed = false;
  private failed = false;
  private queue: Promise<void> = Promise.resolve();
  private open: (
    target: WorkspaceTarget,
    signal: AbortSignal,
  ) => Promise<SdkInstance>;
  private notify: (state: WorkspaceState) => void;
  constructor(open: SdkWorkspace["open"], notify: SdkWorkspace["notify"]) {
    this.open = open;
    this.notify = notify;
  }
  show(target: WorkspaceTarget): Promise<void> {
    if (
      this.disposed ||
      (sameTarget(target, this.current) &&
        sameTarget(target, this.desired) &&
        this.instance &&
        !this.failed)
    )
      return this.queue;
    this.desired = target;
    const revision = ++this.revision;
    this.opening?.abort();
    this.failed = false;
    this.notify({ status: this.instance ? "navigating" : "loading" });
    this.queue = this.queue.then(async () => {
      if (this.disposed || revision !== this.revision) return;
      try {
        if (this.instance) await this.instance.navigate(target);
        else {
          const opening = new AbortController();
          this.opening = opening;
          this.connection = opening;
          const instance = await this.open(target, opening.signal);
          // 换页、换号或退出后迟到的实例必须销毁，不能覆盖当前页面。
          if (
            this.disposed ||
            revision !== this.revision ||
            opening.signal.aborted
          ) {
            instance.destroy();
            return;
          }
          this.instance = instance;
        }
        this.current = target;
        if (revision === this.revision && !this.disposed)
          this.notify({ status: "ready" });
      } catch (error) {
        if (revision === this.revision && !this.disposed) {
          this.failed = true;
          // 普通导航失败保留已显示的页面；SDK 致命错误由 fail() 清理。
          if (!this.instance) {
            this.connection?.abort();
            this.current = undefined;
          }
          this.notify({
            status: "error",
            error,
            retainPage: Boolean(this.instance),
          });
        }
      } finally {
        if (revision === this.revision) this.opening = undefined;
      }
    });
    return this.queue;
  }
  retry() {
    if (this.disposed) return Promise.resolve();
    this.failed = true;
    return this.desired ? this.show(this.desired) : Promise.resolve();
  }
  fail(error: unknown) {
    if (this.disposed) return;
    this.revision++;
    this.opening?.abort();
    this.opening = undefined;
    this.connection?.abort();
    const instance = this.instance;
    this.instance = undefined;
    this.current = undefined;
    instance?.destroy();
    this.failed = true;
    this.notify({ status: "error", error });
  }
  async update(patch: Record<string, unknown>) {
    if (!this.disposed && this.instance) await this.instance.update(patch);
  }
  dispose() {
    this.disposed = true;
    this.revision++;
    this.opening?.abort();
    this.connection?.abort();
    this.instance?.destroy();
    this.instance = undefined;
  }
}

export function sdkFailureMessage(error: unknown) {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "";
  const messages: Record<string, string> = {
    SDK_LOAD_FAILED:
      "创作组件加载失败，请在接入设置核对 SDK 地址和网络后重试。",
    HOST_ORIGIN_MISMATCH: "请从接入设置中配置的 HTTPS 页面地址打开创作服务。",
    INITIALIZATION_FAILED: "页面暂时无法打开，请稍后重试。",
    TIMEOUT: "页面加载超时，请重试。",
    INVALID_ARGUMENT: "此功能暂不可用，请稍后重试。",
    PROTOCOL_ERROR: "页面暂时无法打开，请稍后重试。",
    FRAME_RELOADED: "页面已中断，请重新打开。",
    IDENTITY_CHANGED: "账户状态已变化，请重新打开页面。",
    OPERATION_FAILED: "未能切换页面，请重试。",
  };
  return Object.hasOwn(messages, code)
    ? messages[code]
    : "页面暂时无法打开，请稍后重试。";
}
