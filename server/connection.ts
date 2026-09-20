import type { ConnectionReport } from "../shared/types.ts";
import { hostOrigin as defaultHostOrigin } from "./config.ts";
import { AppError, object, string } from "./errors.ts";
import type { MerchantClient } from "./merchant.ts";

function isUnauthorized(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    (error.status === 401 ||
      Boolean(
        error.details &&
          typeof error.details === "object" &&
          "code" in error.details &&
          error.details.code === 40100,
      ))
  );
}

function requireSdkOrigin(origin: string) {
  if (!origin.startsWith("https://"))
    throw new AppError(
      400,
      "SDK 启动要求 HTTPS 宿主页面。请先配置实际页面入口并在平台登记同一来源；公网回调地址不能代替页面入口。",
    );
}

// 手动检测或启动被拒绝时检测；不生成内容、不提交报价、不返回历史内容或启动签名。
export async function checkConnection(
  api: MerchantClient,
  userId: string,
  signatureFailure?: AppError,
  hostOrigin = defaultHostOrigin,
): Promise<ConnectionReport> {
  const report: ConnectionReport = {
    apiOrigin: api.apiOrigin,
    parentOrigin: hostOrigin,
    checks: [],
  };
  if (!/^sk-[A-Za-z0-9_-]{43}$/.test(api.key)) {
    report.checks.push({
      name: "商户 Key 格式",
      status: "failed",
      message:
        "请在本项目 .env.local填写完整商户 API Key（sk- 开头，共 46 个字符），不要附加 Bearer、空格、掩码或换行；保存后重启本项目。",
    });
    return report;
  }
  const steps = [
    {
      name: "商户 API 认证",
      run: () => api.request("/open/history", userId, { timeoutMs: 5000 }),
      success: "当前服务端 Key 已通过商户 API 请求。",
      unauthorized:
        "当前 API 服务拒绝此商户凭证。请检查完整 Key 是否属于下方 API 所在环境、是否已撤销，以及商户、所属会员与站点是否启用；修改 Key 后须重启本项目。",
    },
    {
      name: "SDK 启动授权",
      run: async () => {
        requireSdkOrigin(hostOrigin);
        // 已经失败的启动不再重复申请签名，只补一次独立 API 检查。
        if (signatureFailure) throw signatureFailure;
        const result = object(
          await api.request("/open/sdk/signature", userId, {
            body: { parentOrigin: hostOrigin },
            timeoutMs: 10000,
          }),
        );
        string(result.signature, 8192);
      },
      success:
        "服务端已成功取得 SDK 启动签名；浏览器证书、跨域连接与功能授权仍由实际打开 SDK 验证。",
      unauthorized: `商户 API 检测已通过，但 SDK 启动授权被拒绝。请先检查同一商户的 SDK 允许来源是否已保存为 ${hostOrigin}（无末尾斜杠，localhost 与 127.0.0.1 不等同）；若已正确保存，用此次 traceId 排查平台拒绝原因。`,
    },
  ];
  for (const step of steps) {
    try {
      await step.run();
      report.checks.push({
        name: step.name,
        status: "passed",
        message: step.success,
      });
    } catch (error) {
      const unauthorized = isUnauthorized(error);
      report.checks.push({
        name: step.name,
        status: "failed",
        message: unauthorized
          ? step.unauthorized
          : signatureFailure &&
              error instanceof AppError &&
              error.status === 502
            ? "补充检测无响应或响应异常，尚不能判断商户 API 认证是否通过；请检查下方后端地址与服务状态，原始 SDK 错误保留在 signatureError 中。"
            : error instanceof AppError
              ? error.message
              : "检测失败，请稍后重试",
        ...(error instanceof AppError && error.details
          ? { details: error.details }
          : {}),
      });
      break;
    }
  }
  return report;
}

// 【SDK 对接点 2】服务端申请 SDK 启动签名；parentOrigin 必须与平台登记的允许来源一致。
export async function sdkSignature(
  api: MerchantClient,
  userId: string,
  hostOrigin = defaultHostOrigin,
) {
  requireSdkOrigin(hostOrigin);
  try {
    const result = object(
      await api.request("/open/sdk/signature", userId, {
        body: { parentOrigin: hostOrigin },
      }),
    );
    return string(result.signature, 8192);
  } catch (error) {
    if (!isUnauthorized(error)) throw error;
    const report = await checkConnection(api, userId, error, hostOrigin);
    const failed = report.checks.find((check) => check.status === "failed");
    throw new AppError(
      401,
      `${failed?.name || "SDK 启动授权"}未通过：${failed?.message || "平台拒绝启动授权"}\n后端 API：${api.apiOrigin}\nSDK 允许来源应为：${hostOrigin}`,
      {
        signatureError: error.details,
        ...(failed?.details && failed.name !== "SDK 启动授权"
          ? { apiCheckError: failed.details }
          : {}),
      },
    );
  }
}
