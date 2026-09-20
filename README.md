# 黑犀 SDK / API 示例项目

Vue 3 + TypeScript + Vite + Node.js 内置 SQLite。这个项目演示商户自己的菜单、用户、算力和结果管理，创作页面由黑犀 SDK 装载。

固定使用正式 **SDK 0.3.0** 和 `https://api.heixi.com`。没有本地平台接入模式、商户数据空间配置或多套账本；不需要构建、导入或启动相邻项目。

## 快速启动

需要 Node.js 24+ 和 pnpm 11。在本项目根目录执行：

```bash
pnpm install --frozen-lockfile --ignore-scripts
cp -n .env.example .env.local  # 首次创建，已有文件不要覆盖
pnpm dev
```

只需在 `.env.local` 填写正式商户 `BLACK_RHINO_API_KEY`。不填 Key 也能打开用户管理、算力记录等示例页面，SDK/API 调用会提示待配置。

打开 [本机页面](http://127.0.0.1:3443)。`pnpm dev` 默认 HTTP，保留 Vite 热更新和 Node 源码监听。**SDK 要求 HTTPS 宿主页面**；本机 HTTP 可用于管理页面和 API 调试，完整 SDK 测试请从你配置的 HTTPS 页面入口打开（见下方 Cloudflare 一节）。

页面代理启用后宿主 origin 自动读取，无需额外填写。`.env.example` 只列必填项；可选的 `BLACK_RHINO_HOST_ORIGIN` 仅在自建其他 HTTPS 入口转发到本机时手动添加，留空跟随监听地址。回调域名不是宿主页面地址。

备用 HTTPS 方案仍保留，暂不默认启用：需要时先停止 HTTP，缺少证书再运行 `pnpm setup:local`，然后执行 `pnpm dev:https`，打开 `https://127.0.0.1:3443`。证书需自行信任，程序不会关闭 TLS 校验。两种方式使用同一端口，不能同时运行。

## SDK 对接最小路径

整个示例里，真正属于"对接黑犀"的只有下面 5 处，代码中都标有 `【SDK 对接点 N】` 注释，全局搜索即可串起整条链路：

```text
浏览器（宿主页）                 商户后端                         黑犀平台
  │ 1 loadSdk + openSdk             │                                 │
  │── 2 getSignature ─────────────▶│── POST /open/sdk/signature ───▶│
  │                                 │◀──────────── signature ─────────│
  │   （用户在 iframe 内发起生成）   │                                 │
  │── 3 onBeforeGenerate ─────────▶│── 读报价 → 校验余额 → approve ─▶│
  │── 4 onResult(eventId) ────────▶│── GET /open/events、generations ▶│
  │                                 │◀── 5 Webhook（验签后记账/存结果）│
```

| # | 对接点 | 前端 | 后端 |
| --- | --- | --- | --- |
| 1 | 加载脚本并打开页面 | `src/sdk.ts` `loadSdk`、`src/SdkPanel.vue` `openSdk` | – |
| 2 | `getSignature` 启动签名 | `src/sdk.ts` `createSdkOptions` | `server/connection.ts` `sdkSignature` |
| 3 | `onBeforeGenerate` 批准报价 | `src/sdk-approval.ts` | `server/operations.ts` `approve` |
| 4 | `onResult` 保存结果 | `src/sdk.ts` `createSdkOptions` | `server/results.ts` `sdk` |
| 5 | Webhook 验签 | – | `server/webhook.ts`、`server/webhook-keys.ts` |

其余模块是"示例商户自己的业务"，接入时应换成你自己的系统：`server/store.ts`（用户、会话、流水）、`server/sale-ledger.ts`（售价冻结与结算）、`server/media.ts`（结果落盘），以及用户管理、充值等页面。它们演示了幂等、去重、先回调后报价等边界该如何处理，但具体实现不属于 SDK 协议本身。

## Cloudflare 本地快速调试

本地开发可以使用 Cloudflare Tunnel，将公网 HTTPS 回调转发到本机 HTTP。回调域名仅公开两条回调；示例页面可另配一个独立 HTTPS 入口，本机仍使用 HTTP 回源。首次使用先复制 `cloudflare/tunnel.example.json` 为 `cloudflare/tunnel.json`（已被 Git 忽略）并填写自己的隧道信息。

复用已配置的隧道（已有进程无需重复启动）：

```bash
pnpm dev           # 终端一：本项目 HTTP 服务
pnpm tunnel        # 终端二：隧道连接
pnpm tunnel:check  # 终端三：验证回调可达性和路径限制
```

完整教程：[本地开发使用 Cloudflare Tunnel](docs/cloudflare-tunnel-local-development.md)，包括已有账号和域名的固定隧道，以及无账号和域名的临时隧道。配置字段和控制台路由速查见 [cloudflare/README.md](cloudflare/README.md)。

## 商户配置

| 项目 | 配置 |
| --- | --- |
| SDK JS | `https://cdn.heixi.com/online/merchant-sdk/0.3.0/black-rhino-sdk.iife.js`，代码已固定 |
| 后端 API origin | `https://api.heixi.com`，代码已固定；请求自动拼接 `/api/v1` |
| API Key | 用户填写到 `.env.local`，只留服务端 |
| SDK 允许来源 | `https://<your-app-origin>`，与浏览器地址栏 origin 完全一致，不带末尾斜杠 |
| 算力回调 | `https://<your-callback-origin>/webhooks/credits` |
| API 结果回调 | `https://<your-callback-origin>/webhooks/generation` |

回调地址指向你的 Tunnel 或公网服务，需在平台商户设置中保存。商户、所属会员和站点需有效，相关创作能力已授权。SDK 自行取得商户所属分站的 iframe 地址，不从 CDN 域名猜测。

两类验签密钥由后端使用 API Key 按 topic/keyId 自动获取，不需要商户手工填写 Secret。不要把商户 Key、Tunnel Token 或签名放进前端。

详细配置和验收步骤见 [正式 SDK 接入说明](docs/online-sdk-integration.md)。程序只读取 `.env.local`。

## 示例功能

- 自有侧栏和路由：设计、服装、视频、AIGC 共 20 个入口，调用 SDK 打开和切换创作页面。
- 用户管理：首次创建测试用户 A、B，余额为零；支持新增、切换用户。
- 测试充值：增加示例用户余额，不增加平台商户的真实余额；余额变化通过 `sdk.update()` 同步。
- 算力记录：批准生成前查权威报价、检查示例余额并冻结售价分项；批准不扣款。用户实际扣费/退款以售价回调结算，成本事件只作审计。
- 我的作品：SDK 结果通过 `onResult` 自动保存；后端按用户核对权威结果并保存媒体，成功后推进持久游标。没有手动应用结果流程。
- API 调试：模型/配置查询、图片上传、首图、换背景、文生视频、受理状态、最终结果和历史查询。超时保留原请求号恢复。
- API 测试：上传一张图并填写需求，通过报价 → 批准 → 提交生成，区分“已受理”“已完成”和“回调已保存”。
- 换用户或离开创作页会取消宿主未完成操作并销毁旧实例；已受理的平台任务仍可能继续执行。

## 数据与结果

只有一份 `.local/demo.sqlite`，保存用户、会话、报价、流水、请求、结果和游标；媒体在 `.local/media/`。首次启动生成测试用户，后续重启保留数据。示例用户的 `externalUserId` 自动生成，无需商户配置身份前缀或数据目录。

SDK/API 使用同一会话确定的用户身份。SDK `onResult` 由后端重读权威内容；API `generation.finished` 回调验签后直接保存载荷，不重复查结果接口。SDK 任务不会发送 API 生成结果 webhook。

服务端回调校验原始字节、时间窗和身份，以 `eventId` 去重；售价扣退还按冻结分项和 `settlementId` 幂等。只有媒体落盘及事务保存成功才返回 `{"received":true}`。

媒体使用平台提供的完整 HTTPS 地址，不维护 IP 枚举、CDN 白名单或自定义 DNS；保留证书验证、不自动跟随重定向。失败不会伪报保存成功。

本项目没有正式登录或支付系统，用户切换和充值仅用于示例。页面代理没有登录限制，只应在联调期间开启；结束后停止 `pnpm tunnel` 或关闭该页面路由。

## 本机文件与提交范围

以下内容每位开发者各自一份，已写入 `.gitignore`，不要提交：

| 路径 | 内容 | 如何获得 |
| --- | --- | --- |
| `.env.local` | 商户 API Key | 从 `.env.example` 复制后填写 |
| `.local/` | 示例数据库、结果媒体、TLS 证书、隧道 Token | 运行时自动生成；证书用 `pnpm setup:local`，Token 用 `pnpm tunnel:token` |
| `cloudflare/tunnel.json` | 自己的隧道 ID、账号 ID 和域名 | 从 `cloudflare/tunnel.example.json` 复制后填写 |
| `docs/internal/` | 个人的联调与排障记录 | 按需自建 |

需要团队共享的配置，请修改对应的模板文件（`.env.example`、`tunnel.example.json`），不要提交个人文件。

## 验证

```bash
pnpm typecheck
pnpm check
pnpm test
node tests/ui-server.ts --verify
node tests/ui-server.ts --verify --https
```

测试仅使用合成接口、内存或临时 SQLite。最后两条命令临时占用 3443；运行前应停止示例服务。验证页面编译、用户初始化、会话和私有源码访问限制，不访问正式 CDN/API，不代表线上联通已验收。

参考：[正式 SDK 文档](https://cdn.heixi.com/online/merchant-sdk/sdk.html)、[正式 API 文档](https://cdn.heixi.com/online/merchant-sdk/api.html)。
