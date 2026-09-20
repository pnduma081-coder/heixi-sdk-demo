export async function api<T>(
  path: string,
  options: {
    body?: unknown;
    userId?: string;
    signal?: AbortSignal;
    form?: FormData;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.userId) headers["X-Demo-User"] = options.userId;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method: options.body !== undefined || options.form ? "POST" : "GET",
    headers,
    credentials: "same-origin",
    body:
      options.form ||
      (options.body === undefined ? undefined : JSON.stringify(options.body)),
    signal: options.signal,
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      `${value.error || `HTTP ${response.status}`}${value.details ? `\n${JSON.stringify(value.details, null, 2)}` : ""}`,
      typeof value.businessCode === "string" ? value.businessCode : undefined,
    );
  return value;
}
export const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export class ApiError extends Error {
  status: number;
  businessCode?: string;
  constructor(status: number, message: string, businessCode?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.businessCode = businessCode;
  }
}
