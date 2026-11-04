# F065 本地宿主验收

本文记录 2026-10-26 的历史验收：分支 `codex/f065-local-host`，基线 `eb448fde28827fc187dae65931b947719cb9ac1b`。当时用户批准双仓本地接线、验证及本地提交，未授权发布、推送或合入其他 SDK 分支；env 与独立 readiness 文档当时未纳入提交。后续分支整合见 [0.4.0 适配记录](0.4.0-documentation-update.md)，准备过程与阶段纠正见 [F065 历史准备与验收记录](f065-local-readiness.md)。历史操作范围不替代当前项目边界。

## 冻结 0.4 与运行入口

原 SDK 0.4 源码 `cf6a5246b3b97dd9039b3af0f29b96e0587f4381` 仅改变构建 base，未升级。当前批准制品 SHA256 为 `d854521c49d556f7dc3fe0ea8a9e232eb8f17a78be93aa67ce4547fed3d50d89`。本地 provider 固定 T022、member11、HTTP localhost:18080 服务端 API，浏览器平台为 `https://rhino-platform.laotangcode.shop`，宿主为 `https://rhino-demo.laotangcode.shop`。现有 AK/SK 仅正常应用内部加载，不输出、不复制。

在本 SDK 仓执行（仅在确认 3443 空闲后；已有正常服务不重复启动）：

```sh
node --disable-warning=ExperimentalWarning server/f065-local-entry.ts --local-env true --sdk-file /var/folders/v2/3lfg2n4s0mn91ftf93bghzrr0000gn/T/f065-sdk040-platform-xsKSWT/packages/sdk/dist/black-rhino-sdk.iife.js
```

制品为此前本机临时构建。按当前项目边界，失效时由对应项目提供冻结版本的已构建产物；用户明确指定后，本项目仅可只读校验并写入自己的目录，不负责构建或操作相邻项目，也不回退 CDN。另一无凭据合成模式支持 `--api-origin`、`--host-origin`、`--sdk-file`、`--sdk-sha256`，不可与 local-env 混用。每次入口创建自有临时 SQLite，SIGINT/SIGTERM 退出清理；不使用或维护现有用户账库。

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

## 冷启返工完成（2026-10-26）

本轮分支 `codex/f065-startup-followup`，精确基线 `0cced72fd52e480648e4b5d0708b0bf652237c1b`；主仓基线 `ecc9350009b36ed9207795b49124a0e90bcd8e01`。原冷启失败继续诊断后已定位当前可复现的验收干扰：绑定自动化调试连接的公开HTTPS iframe停在about:blank，原生Network显示Pending/Stalled、0bytes，但本地固定纯文本响应已于13:49:57.956完成200。取消当前诊断标签的自动化调试连接后，iframe立即于13:52:46.381完成load；先前已等待168653ms。相同文档的公网fetch、顶层导航、loopback与srcdoc对照均正常。

改用未绑定该调试连接的新原生Chrome标签后，冻结0.4完整真实旅程各执行一次：新标签冷启动iframe就绪14.191秒（整页21.405秒）、整页刷新13.887秒（整页19.662秒）、离开到我的作品再重入14.549秒；清除全部临时代码并重载SDK后，禁用缓存冷启iframe19.491秒（整页27.223秒）。四轮均捕获hello→initialize→exchange→navigate→mount→page-ready并显示完整主图表单。原生Security确认WE1可信证书/TLS1.3/所有资源安全加载；成功文档使用h3，刷新/embed HTTP200总445.88ms。

这是纠正验收环境干扰，没有产品网络或SDK协议代码修复，也未定位浏览器调试工具内部具体缺陷。没有延长timeout、修改origin、关闭HTTP3、改OS代理/信任或升级SDK。四个有限样本不是稳定性/容量测试；无缓存整页27.223秒含iframe创建前准备，不能直接等同SDK的iframe30秒计时，iframe19.491秒仍保留网络波动风险。既往530和未捕获的早期TIMEOUT不统一归因。

临时固定文本路由/请求时序/probe HTML及主仓early observer均已移除，源码、测试、依赖与原基线一致；本轮SDK只有此文档差异，原16项及类型/Biome证据匹配复用，diff检查通过。主仓只收口任务与CURRENT-STATE，focused文档/控制面检查通过。既有本地宿主安全阶段日志属于原实现，未新增秘密或持久权限。

14:06正常配置API再次确认credits version2/enabled=false、generation=null；14:06:20.729正常商户消耗API total0/returnedRows0。SDK PID23639归属及3443监听已复核、receiver关闭，既有服务保留。平台timeline开关删除、临时DNS不存在、DevTools缓存禁用恢复0、设备模拟关闭、控制台清空关闭。没有重新启用回调、批准/提交或付费。真实两笔20算力报价拒绝/取消保持前轮结果；真实扣费/退款/供应商/批准恢复/辅助未执行，合成幂等测试不冒充真实费用。

按授权本地提交本任务分支，不合入SDK其他分支，不push/PR/CI/deploy；既有env及未跟踪readiness文档原样保留、不提交。主仓本任务本地提交后合回codex/F065，实际commit/merge由Git及交付回执证明。证据见主仓T134最终节及本机 `/tmp/f065-t134-native-startup-proof.json`、`/tmp/f065-t134-final-consumption.json`、`/tmp/f065-t134-startup-closure-focused.log`。临时证据不是发布制品。
