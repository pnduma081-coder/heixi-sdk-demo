import { approvalRejectionMessage } from "../shared/approval.ts";
import { ApiError, api } from "./api.ts";
import type { GenerationDecision } from "./sdk.ts";

export async function approveGeneration(
  userId: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<GenerationDecision> {
  try {
    const approval = await api<{ approvalId: string }>("/api/sdk/approve", {
      body: {
        quoteId: request.quoteId,
        clientRequestId: request.clientRequestId,
      },
      userId,
      signal,
    });
    signal.throwIfAborted();
    return approval;
  } catch (error) {
    signal.throwIfAborted();
    const message =
      error instanceof ApiError && error.status === 409
        ? approvalRejectionMessage(error.businessCode)
        : undefined;
    if (message) return { approved: false, message };
    // 未知失败仍走 SDK 的安全异常处理，内部详情不进入跨窗口响应。
    throw new Error("生成失败，请稍后重试");
  }
}
