// 浏览器只查询生成状态；后台事件消费独立运行，不因这里停止而中断结算或结果保存。
export function statusPollingDecision(input: {
  terminal: boolean;
  saved: boolean;
  elapsedMs: number;
  failures: number;
}): "continue" | "complete" | "paused" {
  if (input.terminal || input.saved) return "complete";
  if (input.elapsedMs >= 10 * 60_000 || input.failures >= 3) return "paused";
  return "continue";
}
