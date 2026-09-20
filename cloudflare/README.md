# Cloudflare Tunnel 配置参考

本目录保存本项目的隧道配置。第一次配置请按 [本地开发使用 Cloudflare Tunnel](../docs/cloudflare-tunnel-local-development.md) 一步步操作；本文只汇总配置字段、控制台路由和命令，方便日后核对。

## tunnel.json

从模板复制一份，再填写自己的值。`tunnel.json` 已被 Git 忽略，不要提交。

```bash
cp -n cloudflare/tunnel.example.json cloudflare/tunnel.json
```

| 字段 | 含义 |
| --- | --- |
| `name` | 隧道名称，仅用于识别，例如 `black-rhino-sdk` |
| `tunnelId` | Cloudflare 隧道 UUID，`pnpm tunnel:token` 用它核对凭证归属 |
| `accountId` | Cloudflare 账号 ID，同上 |
| `publicOrigin` | 回调入口，例如 `https://rhino-callback.example.com`，只转发两条 webhook |
| `service` | 本机回源地址，默认 `http://127.0.0.1:3443` |
| `published` | 回调路由已在控制台发布并通过 `pnpm tunnel:check` 后设为 `true`；“接入设置”页会展示回调地址 |
| `appOrigin` | 可选：页面入口，例如 `https://rhino-demo.example.com`，必须与回调入口不同 |
| `appPublished` | 页面路由发布后设为 `true`；项目随即以 `appOrigin` 作为 SDK 宿主 origin |

所有 origin 都必须是精确的 HTTPS origin：不带路径，也不带末尾斜杠。该文件不保存 Token。

## 控制台路由

在 Cloudflare 隧道的 **路由 → 已发布的应用程序** 中添加。`pnpm tunnel:config` 会按 `tunnel.json` 输出同样的期望配置，供逐项核对；它不会修改 Cloudflare。

| 路由 | 主机名 | 路径 | 服务 URL | HTTP Host Header |
| --- | --- | --- | --- | --- |
| 回调（必需） | `publicOrigin` 的主机名 | `^/webhooks/(credits\|generation)$` | `http://127.0.0.1:3443` | `127.0.0.1:3443` |
| 页面（可选） | `appOrigin` 的主机名 | 留空 | `http://127.0.0.1:3443` | `appOrigin` 的主机名 |

- 回调主机只匹配两条 webhook，其他路径保持 404。不要添加覆盖所有路径的路由。
- 页面主机承载宿主页面、会话接口和 Vite 热更新 WebSocket，本机不需要开启 HTTPS。
- Host Header 必须按上表填写，否则本项目会以 403 拒绝回源请求。
- 页面入口没有登录保护，任何拿到地址的人都能操作示例账户。只在联调期间发布，结束后停止 `pnpm tunnel` 或删除页面路由。

发布页面入口后，在黑犀商户设置中把 **SDK 允许来源** 填成 `appOrigin`。回调地址仍使用 `publicOrigin`：

```text
https://<your-callback-origin>/webhooks/credits
https://<your-callback-origin>/webhooks/generation
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `pnpm tunnel:token` | 在隐藏输入中粘贴控制台的连接命令或 Token。脚本核对账号与隧道 ID 后保存到 `.local/cloudflare/token`（权限 0600） |
| `node scripts/cloudflare.mjs token-ui` | 同上，改用临时本机网页粘贴。页面只监听回环地址，保存成功或 10 分钟后自动关闭 |
| `pnpm tunnel` | 使用已保存的 Token 前台运行连接，Ctrl+C 停止；不安装系统服务 |
| `pnpm tunnel:config` | 输出期望的远程路由配置，用于核对 |
| `pnpm tunnel:check` | 向回调入口发送无签名请求：两条 webhook 应返回 401，`/` 和 `/api/session` 应返回 404。不会触发生成，也不会改动账本 |

`pnpm tunnel:check` 只检查回调入口。页面入口可以直接用浏览器打开 `appOrigin` 确认。

## 备用：本机 HTTPS 回源

一般不需要。如果改用 `pnpm dev:https`，需要：

1. 先停止 HTTP 服务。
2. 把 `service` 改为 `https://127.0.0.1:3443`。
3. 在控制台同步修改两条路由的服务 URL。

改完后，`pnpm tunnel:config` 会额外输出 `originServerName: localhost`、本项目 `.local/tls/cert.pem` 的路径和 `noTLSVerify: false`，请照此填写，保持证书校验开启。
