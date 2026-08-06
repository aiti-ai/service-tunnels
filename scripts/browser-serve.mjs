/**
 * 浏览器验证用后台：mock IdP + oauth2-proxy expose（proxy 模式），保持运行。
 * 运行：node --experimental-strip-types scripts/browser-serve.mjs
 * 输出 localUrl 后保持进程存活，Ctrl+C 退出。
 */
import { startMockIdp } from "./mock-idp.mjs";
import { createServiceTunnels } from "../src/index.ts";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = join(tmpdir(), `st-browser-${process.pid}`);

const idp = await startMockIdp();
console.log(`IDP=${idp.issuer}`);

const st = createServiceTunnels({
  cacheDir: join(TMP, "cache"),
  configDir: join(TMP, "config"),
  log: (m) => process.stderr.write(`[st] ${m}\n`),
});

const app = createServer((req, res) => {
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(`app-ok (pid ${process.pid})`);
});
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const appPort = app.address().port;
console.log(`APP=${appPort}`);

const res = await st.auth.expose(appPort, {
  mode: "proxy",
  auth: "oauth2-proxy",
  providerParams: {
    "oidc.issuerUrl": idp.issuer,
    "oidc.clientId": "test-client",
    "oidc.clientSecret": "test-secret",
    "oidc.cookieSecret": "0123456789abcdef0123456789abcdef",
    "oidc.setup.infoPage": true,
    "oidc.setup.verification.0.path": idp.verificationPath,
    "oidc.setup.verification.0.content": idp.verificationContent,
  },
});
console.log(`URL=${res.localUrl}`);
console.log(`VERIFY_PATH=${idp.verificationPath}`);
console.log(`VERIFY_CONTENT=${idp.verificationContent}`);

// 模拟用户已在 IdP 填好回调（动态域名）→ 后续授权时域名验证也会通过
const cbUrl = `${new URL(res.localUrl).origin}/oauth2/callback`;
idp.registerCallback(cbUrl);
console.log(`CALLBACK_REGISTERED=${cbUrl}`);

// 保持存活
process.on("SIGINT", async () => {
  await st.shutdown().catch(() => {});
  app.close();
  idp.close();
  process.exit(0);
});
await new Promise(() => {}); // 常驻
