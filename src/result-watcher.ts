import type { StoredResult } from "../shared/types.ts";
import { api } from "./api.ts";
import { GenerationPoller, type PollingState } from "./generation-poller.ts";

// Only inspect the current task in the local store after platform completion.
// Never poll the whole session or restart a finished/paused watch implicitly.
export class ResultWatcher {
  private key = "";
  private poller: GenerationPoller<{ result: StoredResult | null }>;
  constructor(options: {
    userId: string;
    saved: (result: StoredResult) => void;
    state: (state: PollingState) => void;
    error: (error: unknown) => void;
  }) {
    this.poller = new GenerationPoller({
      read: (no, signal) =>
        api(`/api/results/status?submissionNo=${encodeURIComponent(no)}`, {
          userId: options.userId,
          signal,
        }),
      apply: ({ result }) => {
        if (!result) return false;
        options.saved(result);
        return true;
      },
      state: options.state,
      error: options.error,
      hidden: () => document.hidden,
      maxElapsedMs: 60_000,
      maxReads: 20,
    });
  }
  start(no: string) {
    if (!no || this.key === no) return;
    this.key = no;
    this.poller.start(no);
  }
  stop() {
    this.key = "";
    this.poller.stop();
  }
  visibilityChanged() {
    this.poller.visibilityChanged();
  }
  dispose() {
    this.poller.dispose();
  }
}
