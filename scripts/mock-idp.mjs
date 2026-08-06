/**
 * 最小 OIDC IdP（RS256）—— 够 oauth2-proxy 用：discovery + jwks + authorize + token + userinfo。
 *
 * 额外模拟真实 IdP 的联动校验（Google site-verification 风格）：
 *  - 随机生成「域名所有权验证」文件：{ verificationPath, verificationContent }
 *  - 回调白名单：/authorize 前必须已注册 redirect_uri（/api/register-callback 注册）
 *  - 授权前主动抓取 http://<host><verificationPath> 校验内容，不匹配则返回配置提示页
 *    （页面显示需要 proxy 在哪个路径返回哪个随机串）
 */
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import crypto from "node:crypto";

export async function startMockIdp(opts = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "mock-key-1";
  const jwk = publicKey.export({ format: "jwk" });
  const codes = new Map();   // code -> sub
  const tokens = new Map();  // access_token -> sub

  // 域名所有权验证：随机串 + 路径（模拟真实 IdP 的验证文件机制）
  const verificationPath = opts.verification?.path ?? "/.well-known/service-tunnels-verify.txt";
  const verificationContent = opts.verification?.content ?? crypto.randomBytes(12).toString("hex");
  const allowedCallbacks = new Set(opts.callbacks ?? []);

  /** .localhost → 127.0.0.1（测试机 *.st.localhost 不解析）。 */
  const resolveHost = (host) => {
    const [h, port] = host.split(":");
    const ip = /(^|\.)localhost$/.test(h ?? "") ? "127.0.0.1" : h;
    return { host: ip, port: Number(port || 80) };
  };

  /** 抓取 vhost 上的验证文件并比较内容。 */
  const fetchVerification = (host) =>
    new Promise((resolve) => {
      const { host: ip, port } = resolveHost(host);
      const r = httpRequest({ host: ip, port, path: verificationPath, headers: { host } }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve(res.statusCode === 200 ? b : null));
      });
      r.on("error", () => resolve(null));
      r.setTimeout(3000, () => {
        r.destroy();
        resolve(null);
      });
      r.end();
    });

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const issuer = `http://127.0.0.1:${server.address().port}`;
    const json = (o) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    const html = (o) => {
      res.writeHead(o.status ?? 200, { "content-type": "text/html; charset=utf-8" });
      res.end(o.body);
    };
    if (u.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (u.pathname === "/jwks") return json({ keys: [{ kty: "RSA", kid, use: "sig", alg: "RS256", n: jwk.n, e: jwk.e }] });
    if (u.pathname === "/api/setup") {
      return json({ verificationPath, verificationContent, callbacks: [...allowedCallbacks], issuer });
    }
    if (u.pathname === "/api/register-callback") {
      const cb = u.searchParams.get("cb");
      if (cb) allowedCallbacks.add(cb);
      return json({ ok: true, callbacks: [...allowedCallbacks] });
    }
    if (u.pathname === "/api/verify-check") {
      const host = u.searchParams.get("host") ?? "";
      const got = await fetchVerification(host);
      return json({ host, verificationPath, expected: verificationContent, got, ok: got === verificationContent });
    }
    if (u.pathname === "/authorize") {
      const cb = u.searchParams.get("redirect_uri") ?? "";
      // 1. 回调白名单（模拟用户需要在 IdP 应用里填入回调地址）
      if (!allowedCallbacks.has(cb)) {
        return html({
          body: `<h2>回调地址未注册</h2><p>请到 OAuth2 应用里填入回调地址：</p>
<code>${cb}</code>
<p><a href="/api/register-callback?cb=${encodeURIComponent(cb)}">一键注册（模拟填好回调）→</a></p>
<p>当前已注册：${[...allowedCallbacks].map((c) => `<br><code>${c}</code>`).join("")}</p>`,
        });
      }
      // 2. 域名所有权验证（模拟真实 IdP 主动抓取）
      const host = new URL(cb).host;
      const got = await fetchVerification(host);
      if (got !== verificationContent) {
        return html({
          body: `<h2>域名所有权验证失败</h2>
<p>请让反向代理在 <code>http://${host}${verificationPath}</code> 返回以下随机串：</p>
<code>${verificationContent}</code>
<p>当前返回：<code>${got === null ? "（无法访问）" : got}</code></p>`,
        });
      }
      // 3. 通过 → 免真登录，直接发 code
      const code = crypto.randomBytes(8).toString("hex");
      codes.set(code, "u-1001");
      const loc = `${cb}?code=${code}&state=${u.searchParams.get("state") ?? ""}`;
      res.writeHead(302, { location: loc });
      return res.end();
    }
    if (u.pathname === "/token" && req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      // oauth2-proxy 可能用 Basic Auth 或 body 传 client 凭据
      const basic = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
      const clientId = p.get("client_id") ?? basic.split(":")[0] ?? "test-client";
      const sub = codes.get(p.get("code") ?? "") ?? "u-1001";
      codes.delete(p.get("code") ?? "");
      const now = Math.floor(Date.now() / 1000);
      const at = crypto.randomBytes(16).toString("hex");
      tokens.set(at, sub);
      const idToken = signJwt(privateKey, kid, {
        iss: issuer, sub, aud: clientId, exp: now + 3600, iat: now,
        email: "alice@example.com", preferred_username: "alice", name: "Alice",
      });
      return json({ access_token: at, id_token: idToken, token_type: "Bearer", expires_in: 3600 });
    }
    if (u.pathname === "/userinfo") {
      const at = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const sub = tokens.get(at);
      if (!sub) { res.writeHead(401); return res.end("no"); }
      return json({ sub, email: "alice@example.com", preferred_username: "alice" });
    }
    res.writeHead(404); res.end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    issuer: `http://127.0.0.1:${server.address().port}`,
    verificationPath,
    verificationContent,
    registerCallback: (cb) => allowedCallbacks.add(cb),
    callbacks: () => [...allowedCallbacks],
    close: () => server.close(),
  };
}

function signJwt(privateKey, kid, claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg: "RS256", typ: "JWT", kid });
  const payload = b64(claims);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${sig}`;
}
