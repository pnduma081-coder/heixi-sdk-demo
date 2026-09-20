// 仅这些明确业务拒绝可作为 SDK 用户提示；不使用状态码或异常文案猜测原因。
export const approvalRejections = {
  INSUFFICIENT_CREDITS: "算力不足，请充值",
  QUOTE_MISMATCH: "报价已变化，请重新发起生成",
  REQUEST_CONFLICT: "请求已变化，请重新发起生成",
} as const;
export type ApprovalRejectionCode = keyof typeof approvalRejections;

export function approvalRejectionMessage(code: string | undefined) {
  return code && Object.hasOwn(approvalRejections, code)
    ? approvalRejections[code as ApprovalRejectionCode]
    : undefined;
}
