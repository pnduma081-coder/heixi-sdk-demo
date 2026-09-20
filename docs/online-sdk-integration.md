# 正式 SDK 0.3.0 接入说明

本项目演示商户如何接入正式黑犀 SDK 和开放 API。SDK 与 API 地址已固定在代码中，本地只需要填写商户 API Key。

## 1. 只填写商户 Key

在项目根目录首次创建环境文件（已有文件不要覆盖）：

```bash
cp -n .env.example .env.local
```

编辑 `.env.local`：

```dotenv
BLACK_RHINO_API_KEY=填写正式商户完整APIKey
```

这是唯一必填项。Key 以 `sk-` 开头，填写完整值，不加 `Bearer`、空格或换行；改完后重启服务。Key 只在服务端使用，不会下发到浏览器。

可选变量 `BLACK_RHINO_HOST_ORIGIN` 不在模板中。用 Cloudflare 发布页面入口时，宿主 origin 会从 `cloudflare/tunnel.json` 自动读取；只有使用自己的 HTTPS 反向代理转发到本机时，才需要手动添加这一行，填写该入口的 origin。

程序只读取 `.env.local`。其中已不再生效的 `BLACK_RHINO_*` 变量会在启动时列出提示。

固定地址：

| 用途 | 值 |
| --- | --- |
| SDK JS | `https://cdn.heixi.com/online/merchant-sdk/0.3.0/black-rhino-sdk.iife.js` |
| 后端 API origin | `https://api.heixi.com` |
| 完整 API 基址 | `https://api.heixi.com/api/v1`，由代码自动拼接 |
| SDK 文档 | `https://cdn.heixi.com/online/merchant-sdk/sdk.html` |
| API 文档 | `https://cdn.heixi.com/online/merchant-sdk/api.html` |

SDK 直接从 CDN 加载，加载失败会报错，不会回退到本地文件。iframe 地址由 SDK 的授权响应决定。

## 2. 本机启动与 HTTPS 页面

```bash
pnpm dev
```

默认监听 `http://127.0.0.1:3443`。没有 Key 也能打开管理页面和查看参数示例。首次启动会创建两个零余额测试用户，重启后数据保留。

SDK 要求宿主页面为 HTTPS，以下三项必须完全一致：

1. 浏览器地址栏中的 HTTPS origin。
2. 项目“接入设置”页显示的宿主页 origin（也会打印在启动日志中）。
3. 黑犀商户设置中保存的 SDK 允许来源。

origin 不包含路径、末尾斜杠或通配符；`localhost` 与 `127.0.0.1` 视为不同的 origin。

获得 HTTPS 页面有两种方式：

- **推荐：Cloudflare 页面入口。** 本机保持 HTTP，按 [Tunnel 教程第 3.6 节](cloudflare-tunnel-local-development.md#36-可选发布-https-页面入口) 发布页面主机名即可。
- **备用：本机 HTTPS。** 先停止 HTTP 服务，缺少证书时运行 `pnpm setup:local`，再运行 `pnpm dev:https`，打开 `https://127.0.0.1:3443` 并自行信任证书。两种协议共用同一端口和同一份示例数据。

## 3. 配置回调

在黑犀商户设置中保存并启用：

| 用途 | 地址 |
| --- | --- |
| 算力回调 | `https://<your-callback-origin>/webhooks/credits` |
| API 生成结果回调 | `https://<your-callback-origin>/webhooks/generation` |

回调域名只转发这两条路径，首页返回 404，所以不能把它填成 SDK 允许来源。本地开发如何获得回调域名，见 [Cloudflare Tunnel 教程](cloudflare-tunnel-local-development.md)；字段和路由速查见 [cloudflare/README.md](../cloudflare/README.md)。

## 4. 示例数据

- `.local/demo.sqlite`：用户、会话、余额、报价、流水、请求、结果、游标。
- `.local/media/`：已保存的结果媒体。
- 用户标识：测试用户为 `demo-user-a`、`demo-user-b`；新增用户会自动分配稳定标识，SDK 与 API 共用。
- 会话 Cookie：`demo_session`。

需要从头开始时，停止服务后删除 `.local/demo.sqlite*` 和 `.local/media/`，下次启动会重新创建。

## 5. 接入链路

**身份和签名：** 商户后端根据自己的会话确定 `externalUserId`，用商户 Key 调用 `POST /api/v1/open/sdk/signature`，传入 `{externalUserId,parentOrigin}`。前端只拿到短期签名，每次打开或续期都重新获取，不做持久缓存，也不写入日志。

**生成批准：** SDK 发起生成前，后端重读报价，核对用户与请求号，检查余额，并保存冻结的 `saleItems`。各分项合计等于 `estimatedCredits`，售价为 0 也是有效报价。API 调用走“报价 → 批准 → 提交”。批准本身不扣款；请求超时时先查询原请求，再用同一请求号恢复。

**售价结算：** 示例余额只按 `credits.sale_debited` / `credits.sale_refunded` 中的冻结分项增减，按 `settlementId` 去重，退款通过 `originalDebitId` 关联原扣款。平台成本事件只做审计，不会重复扣用户。测试充值只增加示例用户的余额，不会增加商户在平台上的真实余额。

**SDK 结果：** 通过 `onResult` 接收。后端按用户核对事件和权威结果，媒体和数据库都保存成功后才返回成功并推进游标。失败可以重试，刷新或重新打开页面也能继续接收。

**API 结果：** 通过服务端 `generation.finished` 回调接收。按原始请求字节验签后，直接处理完整载荷。验签密钥由后端按 topic/keyId 用商户 Key 领取，商户不需要手工填写 Secret。

两类 webhook 都会检查时间窗和用户身份，并按 `eventId` 持久去重。只有可靠保存后才返回 HTTP 2xx 和 `{"received":true}`，媒体保存失败不会确认成功。余额变化通过宿主调用 `sdk.update({credits})` 同步到 SDK 页面。

## 6. 验收清单

1. 填写正式 Key，确认商户及所属站点有效、相关功能已授权，启动项目。
2. 在“接入设置”中检测 SDK 文件加载、API 认证和启动签名。SDK 文件加载成功不代表 iframe 握手已完成。
3. 从 HTTPS 页面入口打开 SDK，验证换页、切换用户和旧实例销毁。
4. 对售价非零的功能，验证零余额时被拒绝。售价为 0 的功能仍可能消耗平台成本。
5. 各执行一次最小规模的 SDK 生成和 API 生成，核对售价结算和结果保存。
6. 核对退款、重复回调、刷新和重启后的余额、结果与游标是否正确。

项目自带的测试（`pnpm test`、`node tests/ui-server.ts --verify`）只使用模拟接口和临时数据，不会访问正式 CDN 或 API。真实的线上联通需要按上面的清单实际验证。
