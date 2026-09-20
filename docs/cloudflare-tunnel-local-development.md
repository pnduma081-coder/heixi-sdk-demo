# 本地开发使用 Cloudflare Tunnel 快速教程

示例命令使用 macOS 的 zsh/bash。

本地开发时，Tunnel 解决两个问题，本机全程保持 HTTP 即可：

1. **回调入口（必需）**：平台通过公网 HTTPS 把算力和生成结果回调投递到本机。
2. **页面入口（可选，完整测试 SDK 时需要）**：SDK 要求宿主页面是 HTTPS。给同一条隧道再加一个页面主机名，浏览器就能以 HTTPS 打开本机示例。

无需开放路由器入站端口。Cloudflare 与本机 `cloudflared` 之间使用加密隧道，HTTP 只用于本机回环回源。[官方原理](https://developers.cloudflare.com/tunnel/)

两个入口必须使用不同的主机名，下文分别记为 `https://<your-callback-origin>` 和 `https://<your-app-origin>`。字段和路由速查见 [cloudflare/README.md](../cloudflare/README.md)。

## 1. 先选一种方式

| 情况 | 方式 | 公网地址 | 日常启动 |
| --- | --- | --- | --- |
| 已有 Cloudflare 账号，域名已接入并激活 | 固定隧道，见第 3 节 | 自己的固定子域名 | `pnpm dev` + `pnpm tunnel` |
| 没有账号、没有域名，或只想临时测试 | Quick Tunnel，见第 4 节 | 随机 `https://….trycloudflare.com` | 本机服务 + 回调转发器 + Quick Tunnel |
| 已有账号但还没有域名 | 先用 Quick Tunnel；需要固定地址时再接入域名 | 同上 | 同上 |

Quick Tunnel 无需 Cloudflare 账号。[官方入门](https://developers.cloudflare.com/tunnel/get-started/#quick-tunnels-development)

页面入口需要固定域名，Quick Tunnel 只适合调试回调。

已经配置好固定隧道（`cloudflare/tunnel.json` 已填写，`.local/cloudflare/token` 已保存）时，每天只需开两个终端分别运行 `pnpm dev`、`pnpm tunnel`，再运行 `pnpm tunnel:check`。进程已在运行时不要重复启动。

## 2. 公共准备

### 2.1 安装 cloudflared

macOS 已有 Homebrew 时：

```bash
brew install cloudflared
cloudflared --version
```

Windows、Linux 按 [Cloudflare 官方下载页](https://developers.cloudflare.com/tunnel/downloads/) 安装。本教程前台运行进程，不需要安装系统后台服务。

### 2.2 启动本项目

在 `black-rhino-sdk` 项目根目录执行：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev
```

Node.js 需 24+，pnpm 需 11。首次配置 API Key 参见 [项目 README](../README.md#商户配置)。已有 `.env.local` 时不要覆盖；Key 只保留在服务端。

打开 [本机页面](http://127.0.0.1:3443)。另开终端检查一条无签名回调：

```bash
curl -i -X POST http://127.0.0.1:3443/webhooks/credits \
  -H 'Content-Type: application/json' --data '{}'
```

预期：HTTP `401`，JSON 的 `error` 提示回调签名无效或已过期。这证明接收入口能响应，不代表真实签名验收通过，也不会增加流水或扣费。

本机 HTTP 不需要证书。`pnpm dev:https` 和 `.local/tls/` 仍保留作为备用，本教程默认不启用。

## 3. 方式一：已有账号和域名，配置固定隧道

### 3.1 确认域名已激活

登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，确认目标域名状态为 Active／有效。

域名不必从 Cloudflare 购买。若目前只在其他注册商购买、尚未接入 Cloudflare，按常见的完整 DNS 接入方式：

1. 在 Cloudflare 添加根域名，例如 `example.com`，选择适合的计划。
2. 导入并核对现有 DNS 记录，尤其是网站、邮箱相关记录。
3. 到域名注册商，把权威 Nameservers 改为 Cloudflare 分配的值；这一步不是添加一条普通 A 记录。
4. 等待 Cloudflare 显示域名已激活；原来启用 DNSSEC 的域名，按官方迁移步骤处理后再启用。

已有 Active 域名可跳过以上步骤。[官方域名接入步骤](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)

### 3.2 创建隧道并取得连接凭证

1. 在控制台打开 **Networking／联网 → Tunnels → 创建隧道**。某些界面也可从 Zero Trust 的 Networks／Connectors 进入。
2. 选择 `cloudflared`（若界面要求选择），命名，例如 `black-rhino-sdk`。
3. 选择本机操作系统，复制 **手动运行／Run tunnel (manual)** 命令。
4. 记录当前账号 ID、隧道 ID。命令中的 Token 是连接凭证，不是黑犀商户 API Key，也不是 Cloudflare 管理 API Token。

控制台的名称可能随版本变化，以当前的 Tunnels 页面为准。[官方隧道创建流程](https://developers.cloudflare.com/tunnel/get-started/)

### 3.3 填写项目配置，再保存凭证

从模板创建 `cloudflare/tunnel.json`（已被 Git 忽略）：

```bash
cp -n cloudflare/tunnel.example.json cloudflare/tunnel.json
```

替换尖括号内容，例如：

```json
{
  "name": "black-rhino-sdk",
  "tunnelId": "<隧道 UUID>",
  "accountId": "<Cloudflare 账号 ID>",
  "publicOrigin": "https://rhino-callback.example.com",
  "service": "http://127.0.0.1:3443",
  "published": false,
  "appOrigin": "https://rhino-demo.example.com",
  "appPublished": false
}
```

路由发布前，`published` 和 `appPublished` 都保持 `false`。不需要页面入口时，可以删除 `appOrigin` 和 `appPublished` 两个字段。origin 不包含路径或末尾斜杠。此 JSON 不保存 Token。

运行：

```bash
pnpm tunnel:token
```

在隐藏输入提示中粘贴刚复制的完整命令或 Token，回车。脚本只提取并保存凭证，不执行粘贴的命令；会核对账号和隧道 ID，保存到 `.local/cloudflare/token`（权限 `0600`，目录已被 Git 忽略）。不要把真实 Token 写进文档、命令参数或聊天。

需要通过浏览器粘贴时，也可运行 `node scripts/cloudflare.mjs token-ui`，打开它输出的临时本机页面。保存成功后接收服务会关闭。

### 3.4 启动连接，再发布回调路由

保持 `pnpm dev` 运行，在另一个终端执行：

```bash
pnpm tunnel
```

等控制台显示 **健康／Healthy**。进入隧道的 **路由 → 添加路由 → 已发布的应用程序**，填写：

| 字段 | 示例值 |
| --- | --- |
| 子域名 | `rhino-callback` |
| 域名 | 自己已激活的域名，例如 `example.com` |
| 路径正则 | 使用下方完整可复制值，仅匹配两条回调 |
| 服务 URL | `http://127.0.0.1:3443` |
| 附加应用设置 → HTTP → HTTP Host Header | `127.0.0.1:3443` |

路径字段直接复制这一行：

```text
^/webhooks/(credits|generation)$
```

保留未匹配路径返回 `404`，不要另加覆盖所有路径的路由。HTTP Host Header 必须与本机服务匹配，否则本项目会拒绝回源请求。

保存后，控制台会为新主机名创建指向 `<隧道 ID>.cfargotunnel.com` 的 DNS 记录；若提示同名记录已存在，先检查是否属于其他服务，不要直接覆盖。[官方 DNS 路由说明](https://developers.cloudflare.com/tunnel/concepts/routing/)

项目中的：

```bash
pnpm tunnel:config
```

只输出期望配置供核对，**不会自动把 JSON 推送到 Cloudflare**。修改回源地址或路径时，控制台配置也要同步修改。

### 3.5 检查并填写平台回调地址

```bash
pnpm tunnel:check
```

预期两条无签名 POST 回调返回应用的 `401`；`/api/session` 和 `/` 返回 `404`。检查通过后，把 `cloudflare/tunnel.json` 中的 `published` 改为 `true`，重启本项目；“接入设置”会展示公网回调地址。

把以下地址填入黑犀商户设置：

| 用途 | 地址 |
| --- | --- |
| 算力回调 | `https://<your-callback-origin>/webhooks/credits` |
| 生成结果回调 | `https://<your-callback-origin>/webhooks/generation` |

保留这两个路径不变。回调验签密钥由本项目后端用商户 API Key 按需获取，不需要手工填写 Secret。

### 3.6 可选：发布 HTTPS 页面入口

完整测试 SDK 时需要这一步。在同一隧道再添加一条 **已发布的应用程序** 路由：

| 字段 | 示例值 |
| --- | --- |
| 子域名 | `rhino-demo`（必须与回调子域名不同） |
| 域名 | 同一个已激活域名 |
| 路径 | 留空 |
| 服务 URL | `http://127.0.0.1:3443` |
| 附加应用设置 → HTTP → HTTP Host Header | 页面主机名，例如 `rhino-demo.example.com` |

保存后：

1. 确认 `cloudflare/tunnel.json` 中的 `appOrigin` 与该主机名一致，把 `appPublished` 改为 `true`，然后重启 `pnpm dev`。启动日志中的“打开黑犀示例页面”应显示这个 HTTPS 地址。
2. 在黑犀商户设置中把 **SDK 允许来源** 填为 `https://<your-app-origin>`。它必须与浏览器地址栏中的 origin 完全一致。
3. 用浏览器打开 `https://<your-app-origin>`，在“接入设置”中运行检测，再进入任意创作页面。

本机 `http://127.0.0.1:3443` 仍可用于账户管理和 API 调试；SDK 创作页面会提示改从 HTTPS 入口打开。

页面入口没有登录保护，拿到地址的人都能操作示例账户和充值。只在联调期间发布；结束后停止 `pnpm tunnel`，或在控制台删除这条路由并把 `appPublished` 改回 `false`。

## 4. 方式二：没有账号和域名，使用 Quick Tunnel

Quick Tunnel 会生成临时 HTTPS 域名，不需要注册账号、配置 DNS、登录 `cloudflared` 或填写隧道 Token。地址以每次启动输出为准；仅用于开发测试，无可用性承诺，目前最多 200 个并发在途请求，不支持 SSE（Server-Sent Events）。[官方 Quick Tunnel 说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

通用形式是 `cloudflared tunnel --url http://localhost:端口`。**它会把该端口的服务整体转发出去**。本项目端口上还有自动创建测试会话、充值和管理接口，因此这里先用一个只接受两条回调的本机转发器。

### 4.1 终端一：运行本项目

```bash
pnpm dev
```

若已经运行，直接复用。

### 4.2 终端二：启动临时回调转发器

以下命令可整体复制到 zsh/bash，使用 Node 内置模块，无需安装依赖，不写文件。它监听 `127.0.0.1:3445`，仅将两条 POST 回调转发到项目的 `3443`；请求体按原始字节传递，验签仍由本项目完成。

```bash
node --input-type=module <<'NODE'
import { createServer, request } from 'node:http';

const paths = new Set(['/webhooks/credits', '/webhooks/generation']);
const server = createServer((req, res) => {
  if (req.method !== 'POST' || !paths.has(req.url)) {
    res.writeHead(404).end();
    req.resume();
    return;
  }
  const upstream = request({
    hostname: '127.0.0.1',
    port: 3443,
    path: req.url,
    method: 'POST',
    headers: { ...req.headers, host: '127.0.0.1:3443' },
  }, (reply) => {
    res.writeHead(reply.statusCode || 502, reply.headers);
    reply.on('error', () => res.destroy());
    reply.pipe(res);
  });
  upstream.setTimeout(120000, () => upstream.destroy());
  upstream.on('error', () => {
    if (res.headersSent) res.destroy();
    else res.writeHead(502).end('Local callback service unavailable');
  });
  req.on('aborted', () => upstream.destroy());
  req.on('error', () => upstream.destroy());
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
  });
  req.pipe(upstream);
});
server.listen(3445, '127.0.0.1', () => {
  console.log('Callback proxy ready: http://127.0.0.1:3445');
});
NODE
```

保持此终端运行。若 `3445` 被占用，选择空闲端口，同时修改下面 Quick Tunnel 的目标端口。

### 4.3 终端三：创建临时隧道

```bash
cloudflared tunnel --url http://127.0.0.1:3445
```

留意输出中的 HTTPS 地址，例如 `https://random-words.trycloudflare.com`。复制实际地址，不要使用示例字符串。

### 4.4 检查临时入口

在项目根目录另开终端，替换下面的示例域名：

```bash
node --input-type=module -e '
import { checkPublicRoutes } from "./scripts/cloudflare.mjs";
await checkPublicRoutes(process.argv[1]);
' 'https://实际分配的名称.trycloudflare.com'
```

预期同固定隧道：两个 POST 回调返回应用的 `401`，首页和 `/api/session` 返回 `404`。此命令直接检查传入地址；`pnpm tunnel:check` 仍读取固定隧道清单，不能拿来检查另一条临时隧道。

### 4.5 更新平台回调并开始联调

在黑犀商户设置中填写实际临时地址：

```text
https://实际分配的名称.trycloudflare.com/webhooks/credits
https://实际分配的名称.trycloudflare.com/webhooks/generation
```

- 临时方式不需要修改 `cloudflare/tunnel.json` 的账号、隧道 ID 或 Token，也不运行 `pnpm tunnel`。
- “接入设置”仍按固定隧道清单显示地址；临时联调以终端输出和商户实际保存的地址为准。
- Quick Tunnel 重启后重新复制地址，并在平台更新两条回调；旧地址不能视为继续有效。
- 回到固定隧道时，把平台两条回调恢复成第 3.5 节的固定地址。
- 结束测试后，在 Quick Tunnel 和临时转发器终端分别按 `Ctrl+C`。不要关闭其他项目进程。

若已有 `~/.cloudflared/config.yaml`，官方提示它可能阻碍 Quick Tunnel。先确认该文件是否被其他隧道使用；需要临时改名时保留备份并在测试后恢复，不能直接删除其他隧道配置。[官方说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/#use-trycloudflare)

## 5. HTTPS、SDK 页面与回调地址的区别

```text
平台发送回调
  → 公网 HTTPS（固定域名或 trycloudflare.com）
  → Cloudflare 加密隧道
  → 本机 cloudflared
  → 本机 HTTP 回源
  → /webhooks/credits 或 /webhooks/generation
  → 验签、去重、持久化后返回 received: true
```

| 地址 | 用途 | 本教程是否提供 |
| --- | --- | --- |
| 本机 `http://127.0.0.1:3443` | 账户、流水、API 调试页面 | 是 |
| 公网回调 HTTPS 地址 | 平台把事件投递到本机 | 是，仅两条路径 |
| SDK 宿主页面的 HTTPS origin | 浏览器打开商户页面，SDK 用它申请启动授权 | 需要独立配置；回调域名不等于页面入口 |
| SDK 产物中平台地址、后端 API origin | 本项目主动访问黑犀 | 隧道不会自动修改这些配置 |

**SDK 要求宿主页面为 HTTPS。** 本机 HTTP 页面可以管理账户和测试 API，但不能启动 SDK；请按第 3.6 节发布页面入口。回调域名首页返回 `404` 是预期行为，回调域名也不能当作页面入口。

`appPublished: true` 时，项目会自动把 Host 校验、Origin 校验、Cookie、SDK 签名的 `parentOrigin` 和 Vite 热更新都对齐到 `appOrigin`。如果不用 Cloudflare 页面入口，而是用自己的 HTTPS 反向代理，可以在 `.env.local` 中手动设置 `BLACK_RHINO_HOST_ORIGIN`。

本示例固定使用正式 API 与 CDN SDK 0.3.0，其余配置见[正式接入说明](online-sdk-integration.md)。

如需使用本机 HTTPS（`pnpm dev:https`），先停止同端口的 HTTP 服务，再按 [备用 HTTPS 回源说明](../cloudflare/README.md#备用本机-https-回源) 同步修改回源并验证证书。不能让 HTTP 回源的隧道连到已改为 HTTPS 的端口。

## 6. 常见问题

| 现象 | 先检查 |
| --- | --- |
| 无签名 POST 回调返回 JSON `401` | 正常；看 `error` 是否为应用的签名拒绝。浏览器直接 GET 回调不能代替此检查 |
| 真实回调 `401` | 签名头、原始字节、时间窗及商户/事件对应的验签配置；不要关闭验签 |
| 真实回调 `503`，提示获取验签配置失败 | 服务端 API Key、当前配置的黑犀 API 是否可达、平台是否提供 signing-key 接口；先看应用错误内容 |
| 首页或 `/api/session` 返回 `404` | 正常；本教程只公开两条回调 |
| 两条 POST 回调也 `404` | 固定隧道的域名/路径正则是否保存正确；临时转发器是否收到完全一致的路径 |
| 回源 `403` | 固定隧道 HTTP Host Header 是否为 `127.0.0.1:3443` |
| `502` 或 “Local callback service unavailable” | `pnpm dev` 是否运行、端口是否正确、回源 HTTP/HTTPS 是否匹配；临时方式还需检查转发器 |
| Cloudflare `1033` | 检查本机 `cloudflared` 是否仍运行、网络是否正常、控制台是否健康，电脑是否休眠 |
| 返回 HTML 登录页或挑战页面 | 查看该回调域名是否套用了交互式 Access 登录或 WAF 挑战；机器回调无法像浏览器一样操作 |
| Quick Tunnel 返回 `429` | 检查并发限制，减少并发或改用固定隧道 |
| 页面入口返回 `403` | 页面路由的 HTTP Host Header 是否为页面主机名；`appOrigin` 是否一致；`appPublished` 改后是否已重启 `pnpm dev` |
| SDK 提示来源不匹配或授权失败 | 浏览器地址栏、启动日志中的页面地址、商户“SDK 允许来源”三者是否完全一致 |

路由检查通过只代表请求能到达正确入口。最终验收仍需平台发送真实签名事件，并确认本地流水／结果已保存；文件保存失败时应用不会返回成功回执。

## 7. 每天开发的最短流程

**固定隧道：**

1. `pnpm dev`。
2. `pnpm tunnel`。
3. `pnpm tunnel:check`。
4. 确认平台两条回调仍是固定地址；测试 SDK 时从 `https://<your-app-origin>` 打开页面。

**无账号临时隧道：**

1. `pnpm dev`。
2. 启动第 4.2 节回调转发器。
3. `cloudflared tunnel --url http://127.0.0.1:3445`。
4. 检查新地址，将两条新回调保存到平台，再联调。
