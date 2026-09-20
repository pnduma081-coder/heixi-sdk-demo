import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../server/store.ts";

const root = resolve(import.meta.dirname, "..");
const tls = resolve(root, ".local/tls"),
  cert = resolve(tls, "cert.pem"),
  key = resolve(tls, "key.pem");
mkdirSync(tls, { recursive: true, mode: 0o700 });
if (existsSync(cert) !== existsSync(key))
  throw new Error("证书和私钥必须成对存在；请人工检查 .local/tls");
if (!existsSync(cert)) {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "365",
      "-subj",
      "/CN=Black Rhino Local Demo",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { stdio: "ignore" },
  );
  chmodSync(key, 0o600);
  console.info(
    "示例本地证书已生成；首次浏览器访问示例 HTTPS 入口时需确认信任。",
  );
}
const store = new Store(resolve(root, ".local/demo.sqlite"));
store.close();
console.info(
  "示例准备完成。新用户初始算力为0，已有数据保留。配置.env.local后运行pnpm dev（HTTP）；证书保留供pnpm dev:https备用。SDK固定从正式CDN加载，不需要本地产物。",
);
