# SDK/API 0.4.0 开发接入说明

当前 development 已按重新发布的线上 0.4.0 文档适配并校验资源。真实商户验收由用户执行；见[发布记录](development-release.md)。旧版保留在 release-0.3.0。

本项目演示商户如何接入正式黑犀 SDK 和开放 API。SDK 与 API 地址已固定在代码中，本地只需要填写商户 API Key。

## 1. 只填写商户 Key

在项目根目录首次创建环境文件（已有文件不要覆盖）：

```bash
cp -n .env.example .env.local
```

编辑 `.env.local`：

```dotenv
BLACK_RHINO_API_KEY=填写商户完整SK
BLACK_RHINO_ACCESS_KEY=填写同一商户固定AK
```

AK 和 SK 为必填项；后端请求同时发送版本 0.4.0、AK 和 Bearer SK。SK 以 `sk-` 开头，填写完整值，不加 `Bearer`、空格或换行；改完后重启服务。Key 只在服务端使用，不会下发到浏览器。

可选变量 `BLACK_RHINO_HOST_ORIGIN` 不在模板中。用 Cloudflare 发布页面入口时，宿主 origin 会从 `cloudflare/tunnel.json` 自动读取；只有使用自己的 HTTPS 反向代理转发到本机时，才需要手动添加这一行，填写该入口的 origin。

程序只读取 `.env.local`。其中已不再生效的 `BLACK_RHINO_*` 变量会在启动时列出提示。

固定地址：

| 用途 | 值 |
| --- | --- |
| SDK JS | `https://cdn.heixi.com/online/merchant-sdk/0.4.0/black-rhino-sdk.iife.js` |
| 后端 API origin | `https://api.heixi.com` |
| 完整 API 基址 | `https://api.heixi.com/api/v1`，由代码自动拼接 |
| SDK 文档 | `https://cdn.heixi.com/online/merchant-sdk/docs/0.4.0/sdk.html` |
| API 文档 | `https://cdn.heixi.com/online/merchant-sdk/docs/0.4.0/api.html` |

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

纯 API 0.4.0 可不配回调，由后端轮询 `/open/events` 保存结果和商户实际消费事件；SDK 仍须保留原回调配置与宿主批准。

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

`/api/session` 仅用于读取本示例的本地用户、余额和作品等状态，不属于黑犀 SDK 接口，商户无需照搬。页面没有全局状态轮询：首次进入、换号、进入本地数据页、业务操作及 SDK 回调后读取一次，也可点击右上角“刷新账户数据”。异步结算或媒体保存晚于这次读取时，手动刷新查看；生产项目可使用自身的消息推送或有明确起止条件的查询。API 测试页仅在查询具体生成任务时按原有终态、失败次数和时限规则查询，仅在终态自动读取本地状态；两个 API 页均在隐藏时暂停，连续失败 3 次或满 10 分钟暂停，可手动恢复。

需要从头开始时，停止服务后删除 `.local/demo.sqlite*` 和 `.local/media/`，下次启动会重新创建。

## 5. 接入链路

**身份和签名：** 商户后端根据自己的会话确定 `externalUserId`，用商户 Key 调用 `POST /api/v1/open/sdk/signature`，传入 `{externalUserId,parentOrigin}`。前端只拿到短期签名，每次打开或续期都重新获取，不做持久缓存，也不写入日志。

**生成批准：** SDK 发起生成前，后端重读报价，核对用户与请求号，检查余额，并保存冻结的 `saleItems`。各分项合计等于 `estimatedCredits`，售价为 0 也是有效报价。纯 API 直接提交生成并查询商户实际消耗，不要求本地充值，不提供报价模式开关。批准本身不扣款；请求超时时先查询原请求，再用同一请求号恢复。

**售价结算：** 示例余额只按 `credits.sale_debited` / `credits.sale_refunded` 中的冻结分项增减，按 `settlementId` 去重，退款通过 `originalDebitId` 关联原扣款。平台成本事件只做审计，不会重复扣用户。测试充值只增加示例用户的余额，不会增加商户在平台上的真实余额。

**SDK 结果：** 按 2026-09-25 线上合同，结果由内嵌页面直接展示，刷新后通过其历史功能恢复；不再传 `onResult/resultCursor`，也不在 SDK 启动前请求本地结果游标。商户无需保存确认。需要自行归档时可在服务端按正式文档查询事件和权威结果；旧归档数据及服务端恢复接口保留，但不默认启动 SDK 结果复制。新内嵌页同样影响旧版宿主，不能把 0.3.0 代码归档等同于旧自动保存行为保证。

**API 结果：** 后端按用户自适应轮询 `/open/events`，从 `generation.finished` 保存完整结果与媒体。可选回调仍按原始字节验签，两者按同一事件号去重。整页原始事件和接收游标同事务落盘后，再逐项处理。失败项独立退避重试，后续有效事件继续处理；接收成功不等于结算成功，失败重放不会重复扣退。查询最终结果中的 `credits.charged/refunded/net` 是商户实际消费，不是用户售价。验签密钥由后端按 topic/keyId 用商户 Key 领取，商户不需要手工填写 Secret。

两类 webhook 都会检查时间窗和用户身份，并按 `eventId` 持久去重。只有可靠保存后才返回 HTTP 2xx 和 `{"received":true}`，媒体保存失败不会确认成功。余额变化通过宿主调用 `sdk.update({credits})` 同步到 SDK 页面。

## 6. 验收清单

1. 填写正式 Key，确认商户及所属站点有效、相关功能已授权，启动项目。
2. 在“接入设置”中检测 SDK 文件加载、API 认证和启动签名。SDK 文件加载成功不代表 iframe 握手已完成。
3. 从 HTTPS 页面入口打开 SDK，验证换页、切换用户和旧实例销毁。
4. 对售价非零的功能，验证零余额时被拒绝。售价为 0 的功能仍可能消耗平台成本。
5. 各执行一次最小规模的 SDK 生成和 API 生成，核对 SDK 页面结果/售价结算，以及 API 结果本地保存。
6. 核对退款、重复回调、刷新和重启后的余额、结果与游标是否正确。

项目自带的测试（`pnpm test`、`node tests/ui-server.ts --verify`）只使用模拟接口和临时数据，不会访问正式 CDN 或 API。真实的线上联通需要按上面的清单实际验证。

## 错误与版本文档

此处新版状态语义仅适用于明确发送 `X-Merchant-Version: 0.4.0` 与匹配 AK/SK 的 `/open/*` 请求：401 表示凭据问题；缺 externalUserId 为 400，缺功能或 SDK 来源授权为 403。示例后端不会把新版 Open API 的 403 当作 401 再触发凭据诊断；其他业务拒绝结合安全文案、messageKey 与 traceId 判断。

未声明版本或显式 0.3.0 的 Open API 继续原 SK 接入；缺 externalUserId、缺功能授权、SDK 来源未授权仍是 401/40100，并保留明确安全文案。不能把所有旧版 401 都判断为 Key 失效，也不要求旧商户迁移。

`/sdk/client/*` 的 iframe 会话目前没有独立版本协商，继续由平台 SDK 按旧 401/403 清理行为处理。宿主加载 0.4.0 JS、后端申请 0.4.0 签名，并不意味着 iframe 接口升级了错误协议；本示例不改写或绕过 iframe 的会话清理。

接入设置可选择 0.3.0 / 0.4.0 文档，链接固定到 `docs/<version>/sdk.html`、`api.html`，可下载同目录 `sdk.md`、`api.md`、`openapi.json`。文档选择只改变阅读版本，不改变运行协议。对应资源须由主项目按部署顺序发布后才可使用。

后台最多两路并发，同一用户不重叠；有活动时 5 秒、空闲时 30 秒逐步退避到 5 分钟，网络错误最多退避 60 秒，新生成请求唤醒。未知或畸形事件保留原文、显示待处理提示，不标记已完成；修复后可在 API 测试页点击“重试待处理事件”。分页格式、用户身份或同一事件内容冲突仍停止该页接收，保留原游标，不猜测账务。浏览器终态后停止自动查询；连续 3 次失败或 10 分钟也暂停，可手动继续，后台保存不受影响。

## 最新 0.4.0 文档适配（2026-09-24）

- 主图、详情、电商套图及图片翻译的纯 API 设计请求必须填写实际 `contentLanguage`，示例默认 `zh-CN`。0.4.0 不接受 `NONE`；图片翻译还需与 `spec.targetLanguage` 一致。视频接口、0.3.0 API 和未分版本的 SDK 各自保留原合同，不批量改写。
- 模型目录已明确公开 `parameterSchemaVersion`、`parameterContract`、`publicModelCode` 与 image/video/text/design 能力。示例将模型 `id`、`parameterSchemaVersion` 原样带入生成请求，按功能能力选择合法比例、分辨率和质量，不猜测规格。视频目录按其时长、方向等字段填参。
- 报价目录支持 pricing 1.0/2.0；2.0 视频价格含 `referenceVideoUnitCredit`。本示例不根据目录价格扣示例用户余额，纯 API 仍直接调用并查询实际商户消耗。
- 新回调投递最多首次发送加 6 次自动重试，间隔 1、2、4、8、16、32 分钟；策略切换前的投递沿用原时间窗口。商户接收端不根据尝试次数重复记账，只在持久处理成功后 ACK；重复投递/重放按 eventId 幂等。平台停止重试后，API 结果仍可通过本示例后台事件同步恢复；SDK 原回调责任不变。
- 同版本更新后应刷新已打开的宿主页面和文档页；资源可达不等于真实商户签名、生成和回调已经验收。
