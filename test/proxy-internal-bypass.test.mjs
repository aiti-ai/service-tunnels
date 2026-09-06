import assert from "node:assert/strict";
import test from "node:test";
import { resolveServiceHost, DEFAULT_SUFFIXES } from "../src/proxy.ts";
import { InternalTokenRing } from "../src/internal-token.ts";

/** 构造一个 open vhost + password gate 的决策上下文，verifyInternalToken wire ring。 */
function ctxOf({ verifyInternalToken, password = "secret", resolveSite } = {}) {
  return {
    suffixes: DEFAULT_SUFFIXES,
    isAllowed: () => true,
    password,
    basePath: "",
    serviceBasePath: "",
    ...(verifyInternalToken ? { verifyInternalToken } : {}),
    ...(resolveSite ? { resolveSite } : {}),
  };
}

const VHOST = "5173.st.localhost";

test("internal bypass: open vhost + password gate，无 token → 401 deny-auth", async () => {
  const ring = new InternalTokenRing({ autoRotate: false });
  const decision = await resolveServiceHost(
    { host: VHOST, url: "/", method: "GET", authorization: undefined },
    ctxOf({ verifyInternalToken: (a) => ring.verify(a) }),
  );
  assert.equal(decision.kind, "deny-auth");
  assert.match(decision.wwwAuthenticate, /Basic/);
  ring.stop();
});

test("internal bypass: open vhost + password gate，带有效 internal token → forward 旁路放行", async () => {
  const ring = new InternalTokenRing({ autoRotate: false });
  const token = ring.currentToken();
  const decision = await resolveServiceHost(
    { host: VHOST, url: "/", method: "GET", authorization: `Bearer ${token}` },
    ctxOf({ verifyInternalToken: (a) => ring.verify(a) }),
  );
  assert.equal(decision.kind, "forward");
  assert.match(decision.target, /127\.0\.0\.1:5173/);
  ring.stop();
});

test("internal bypass: 带错误 token 仍 401（fail-closed）", async () => {
  const ring = new InternalTokenRing({ autoRotate: false });
  const decision = await resolveServiceHost(
    { host: VHOST, url: "/", method: "GET", authorization: "Bearer sti_wrong" },
    ctxOf({ verifyInternalToken: (a) => ring.verify(a) }),
  );
  assert.equal(decision.kind, "deny-auth");
  ring.stop();
});

test("internal bypass: enrollment 不被旁路——未 enroll 端口（resolveSite 返回 null）带 token 仍 403", async () => {
  const ring = new InternalTokenRing({ autoRotate: false });
  const token = ring.currentToken();
  const decision = await resolveServiceHost(
    { host: VHOST, url: "/", method: "GET", authorization: `Bearer ${token}` },
    ctxOf({ verifyInternalToken: (a) => ring.verify(a), resolveSite: async () => null }),
  );
  assert.equal(decision.kind, "deny");
  assert.equal(decision.status, 403);
  assert.match(decision.body, /not enrolled/);
  ring.stop();
});

test("internal bypass: allow-list 不被旁路——isAllowed=false 带 token 仍 403", async () => {
  const ring = new InternalTokenRing({ autoRotate: false });
  const token = ring.currentToken();
  const decision = await resolveServiceHost(
    { host: VHOST, url: "/", method: "GET", authorization: `Bearer ${token}` },
    { ...ctxOf({ verifyInternalToken: (a) => ring.verify(a) }), isAllowed: () => false },
  );
  assert.equal(decision.kind, "deny");
  assert.equal(decision.status, 403);
  assert.match(decision.body, /not allowed/);
  ring.stop();
});

test("internal bypass: labeled vhost + token provider gate，带 internal token → pipe 旁路 tokenFile", async () => {
  const ring = new InternalTokenRing({ autoRotate: false });
  const token = ring.currentToken();
  // resolveSite 返回带 tokenFile 的 backend（模拟 token provider）；gateBackend
  // 原本会 verifyBearerToken 读文件——internalBypass 应跳过它直接 pipe。
  const resolveSite = async () => ({ tokenFile: "/nonexistent/tokens.json", serviceBasePath: "" });
  const decision = await resolveServiceHost(
    { host: "5173-portal.st.localhost", url: "/", method: "GET", authorization: `Bearer ${token}` },
    {
      suffixes: DEFAULT_SUFFIXES,
      isAllowed: () => true,
      basePath: "",
      serviceBasePath: "",
      resolveLabel: (l) => (l === "portal" ? "default" : null),
      resolveSite,
      verifyInternalToken: (a) => ring.verify(a),
    },
  );
  assert.equal(decision.kind, "pipe");
  assert.equal(decision.port, 5173);
  ring.stop();
});

test("internal bypass: labeled vhost + token provider gate，无 internal token → 401 deny-auth（tokenFile gate 正常拦）", async () => {
  const ring = new InternalTokenRing({ autoRotate: false });
  const resolveSite = async () => ({ tokenFile: "/nonexistent/tokens.json", serviceBasePath: "" });
  const decision = await resolveServiceHost(
    { host: "5173-portal.st.localhost", url: "/", method: "GET", authorization: undefined },
    {
      suffixes: DEFAULT_SUFFIXES,
      isAllowed: () => true,
      basePath: "",
      serviceBasePath: "",
      resolveLabel: (l) => (l === "portal" ? "default" : null),
      resolveSite,
      verifyInternalToken: (a) => ring.verify(a),
    },
  );
  assert.equal(decision.kind, "deny-auth");
  assert.match(decision.wwwAuthenticate, /Bearer/);
  ring.stop();
});

test("internal bypass: rotate 后老 token 在 overlap 内仍旁路放行", async () => {
  const ring = new InternalTokenRing({ ttlMs: 60_000, rotateIntervalMs: 20_000, autoRotate: false });
  const t0 = ring.currentToken();
  ring.rotate();
  const decision = await resolveServiceHost(
    { host: VHOST, url: "/", method: "GET", authorization: `Bearer ${t0}` },
    ctxOf({ verifyInternalToken: (a) => ring.verify(a) }),
  );
  assert.equal(decision.kind, "forward");
  ring.stop();
});
