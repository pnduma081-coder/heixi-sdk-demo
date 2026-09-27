const labels: Record<string, string> = {
  PENDING: "正在处理",
  NOT_SENT: "未发送",
  REJECTED: "已拒绝",
  UNCONFIRMED: "结果未确认",
  ACCEPTED: "已受理",
  APPROVED: "已批准",
};
export const requestStatusLabel = (status: string) => labels[status] || status;
