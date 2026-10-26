// 仅本地验收交互：两个出口均拒绝，不能复用线上自动批准函数。
export function localGenerationDecision(
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ approved: false; message: string }> {
  if (signal.aborted)
    return Promise.resolve({ approved: false, message: "已取消本地验收" });
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "本地报价验收");
    const title = document.createElement("h2");
    title.textContent = "本地报价验收";
    const summary = document.createElement("p");
    const amount = request.estimatedCredits;
    summary.textContent =
      typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0
        ? `本次报价 ${amount} 算力。此验收不会批准或提交生成。`
        : "已收到报价请求。此验收不会批准或提交生成。";
    const refuse = document.createElement("button");
    refuse.textContent = "拒绝本次报价";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    let done = false;
    const finish = (message: string) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", abort);
      dialog.remove();
      resolve({ approved: false, message });
    };
    const abort = () => finish("已取消本地验收");
    refuse.addEventListener("click", () => finish("已拒绝本次报价"));
    cancel.addEventListener("click", abort);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      abort();
    });
    signal.addEventListener("abort", abort, { once: true });
    dialog.append(title, summary, refuse, cancel);
    document.body.append(dialog);
    dialog.showModal();
  });
}
