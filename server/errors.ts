import type { ApprovalRejectionCode } from "../shared/approval.ts";

export class AppError extends Error {
  status: number;
  details?: unknown;
  code?: string;
  constructor(
    status: number,
    message: string,
    details?: unknown,
    code?: string,
  ) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
  }
}
// 结果保存失败的原因可展示给用户；其他异常只显示通用提示。
export function resultSaveError(status: number, message: string) {
  return new AppError(status, message, undefined, "RESULT_SAVE");
}
export class BusinessError extends AppError {
  businessCode: ApprovalRejectionCode;
  constructor(code: ApprovalRejectionCode, message: string) {
    super(409, message);
    this.businessCode = code;
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError(400, "需要 JSON 对象");
  return value as Record<string, unknown>;
}
export function string(value: unknown, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new AppError(400, "参数缺失或格式错误");
  return value;
}
export function uuid(value: unknown): string {
  const text = string(value, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      text,
    )
  )
    throw new AppError(400, "ID 格式错误");
  return text;
}
