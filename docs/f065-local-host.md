# F065 本地宿主验收

分支 `codex/f065-local-host`，基线 `eb448fde28827fc187dae65931b947719cb9ac1b`。本次用户明确批准双仓本地接线、验证及本地提交；不发布、不推送，不合入其他 SDK 分支。已有本任务改动逐项核对，env 与独立 readiness 文档不纳入本次提交。

## 冻结 0.4 与运行入口

原 SDK 0.4 源码 `cf6a5246b3b97dd9039b3af0f29b96e0587f4381` 仅改变构建 base，未升级。当前批准制品 SHA256 为 `d854521c49d556f7dc3fe0ea8a9e232eb8f17a78be93aa67ce4547fed3d50d89`。本地 provider 固定 T022、member11、HTTP localhost:18080 服务端 API，浏览器平台为 `https://rhino-platform.laotangcode.shop`，宿主为 `https://rhino-demo.laotangcode.shop`。现有 AK/SK 仅正常应用内部加载，不输出、不复制。

在本 SDK 仓执行（仅在确认 3443 空闲后；已有正常服务不重复启动）：

```sh
node --disable-warning=ExperimentalWarning server/f065-local-entry.ts --local-env true --sdk-file /var/folders/v2/3lfg2n4s0mn91ftf93bghzrr0000gn/T/f065-sdk040-platform-xsKSWT/packages/sdk/dist/black-rhino-sdk.iife.js
```

制品为本机临时构建，失效时须从上述冻结来源重新构建并核对，不回退 CDN。另一无凭据合成模式支持 `--api-origin`、`--host-origin`、`--sdk-file`、`--sdk-sha256`，不可与 local-env 混用。每次入口创建自有临时 SQLite，SIGINT/SIGTERM 退出清理；不使用或维护现有用户账库。

## 算力回调与拒绝取消

默认关闭接收。只有经预检及恢复准备后显式追加 `--credits-callback enabled` 才接收既有 `/webhooks/credits`。沿用五个 x-black-rhino 头、HMAC、±300 秒、事件内容冲突 409、SQLite 事务及幂等后 ACK；不是假 ACK 或新增生产结算规则。仅此模式允许从本地正常 signing-key API 领取 credits 密钥到内存。approve、submit、事件自动同步、generation 回调仍阻断。

本地 onBeforeGenerate 展示“拒绝本次报价”与“取消”；两个出口均 approved=false。原 normal SDK 自动批准行为未改，这个对话框只是本地测试适配，不是 SDK 协议修复。辅助功能未授权，不测试辅助或供应商生成。

主仓开发验收入口 `scripts/development/sdk-local-callback-acceptance.html` 经正常认证 API 保存非秘密原配置快照，读取 expectedVersion 后启用/恢复，不 rotate。原空配置测试后恢复 disabled，持久签名 key 保留。精确 callback DNS 例外仅 development 显式单 origin 开启，继续严格 SSRF、固定连接 IP 与原域名 TLS；不改系统网络、代理或信任。

## 2026-10-26 验收结果

- 真实正常 API 启用前全商户 events 为 0；11:33 复核仍为 0、hasMore=false。无旧事件重放。
- 两次真实报价各 20 算力，拒绝及取消分别显示预期结果；未批准、提交或生成。11:49 正常 site-admin 商户消耗 API total=0、returnedRows=0。
- SDK 通过真实 signing-key API 领取 key，向无效签名返回 401。没有伪造真实 debit/refund；有效签名、持久化幂等、冲突 409 与重启恢复由隔离 SQLite 合成测试覆盖。
- credits 已正常恢复为 version 2、enabled=false，generation=null；SDK 接收器关闭。浏览器 timeline 开关关闭、主仓临时 DNS 开关删除。既有 CORS、宿主/平台/回调/通知路由及正常服务保留。
- 16 项 local/provider/credits 聚焦测试、SDK vue-tsc、所有本次支持文件 Biome 通过；未重跑无关全套。主仓 API 18、bootstrap 9、相关类型及 focused 通过。

## 尚未通过的冷启验收

曾真实捕获 hello→initialize→exchange→navigate→mount→page-ready 完整链，也成功显示首屏及离开后重入；但整页冷启仍间歇 TIMEOUT。11:30 hello 接近 30 秒才到，11:32 另一轮没有 hello。Chrome Network 的 /embed Timing 显示 Initial connection=30.00s，body=0；不能据此确认 DNS、代理或传输协议根因。未延长 SDK 超时、放宽 origin、修改网络/信任或升级 SDK，不以偶发成功作为修复。稳定冷启与再次完整重入时间线仍待网络依赖排除；批准恢复/供应商/真实扣费未执行。此残余不影响已完成的配置恢复和零消费结论。

证据保存在主仓 T134 任务记录及本机 `/tmp/f065-t134-credits-*.log`、`/tmp/f065-t134-final-consumption.json`。临时文件不是可发布制品。
