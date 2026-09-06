import assert from "node:assert/strict";
import test from "node:test";
import { InternalTokenRing } from "../src/internal-token.ts";

const bearer = (t) => `Bearer ${t}`;

test("InternalTokenRing: currentToken 返回 sti_ 前缀原文，envForChild 可注入子进程", () => {
  const ring = new InternalTokenRing({ ttlMs: 60_000, rotateIntervalMs: 20_000, autoRotate: false });
  const t = ring.currentToken();
  assert.match(t, /^sti_/);
  const env = ring.envForChild();
  assert.equal(env.ST_INTERNAL_TOKEN, t);
  assert.ok(Number(env.ST_INTERNAL_TOKEN_EXPIRES) > Date.now());
  ring.stop();
});

test("InternalTokenRing: verify 接受当前 token（Bearer），拒绝空/错误/非 Bearer", () => {
  const ring = new InternalTokenRing({ ttlMs: 60_000, rotateIntervalMs: 20_000, autoRotate: false });
  const t = ring.currentToken();
  assert.equal(ring.verify(bearer(t)), true);
  assert.equal(ring.verify(undefined), false);
  assert.equal(ring.verify(""), false);
  assert.equal(ring.verify(bearer("sti_wrong")), false);
  assert.equal(ring.verify(`Basic ${t}`), false);
  // scheme 大小写不敏感
  assert.equal(ring.verify(`bearer ${t}`), true);
  assert.equal(ring.verify(`BEARER ${t}`), true);
  ring.stop();
});

test("InternalTokenRing: rotate 后老 token 在 TTL 内仍有效（overlap），过期后失效", async () => {
  // 用 fake timers 不可移植；用真实短 TTL + 短轮换。
  const ring = new InternalTokenRing({ ttlMs: 200, rotateIntervalMs: 70, autoRotate: false });
  const t0 = ring.currentToken();
  ring.rotate(); // 老条目降级（原文清空），但 hash 仍在 ring，TTL 内仍有效
  const t1 = ring.currentToken();
  assert.notEqual(t0, t1);
  // 老 token overlap 期内仍放行
  assert.equal(ring.verify(bearer(t0)), true, "old token still valid within overlap");
  assert.equal(ring.verify(bearer(t1)), true, "new token valid");
  // 等 TTL 过期后老 token 失效
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(ring.verify(bearer(t0)), false, "old token expired");
  assert.equal(ring.verify(bearer(t1)), false, "new token also expired after TTL");
  ring.stop();
});

test("InternalTokenRing: rotate 后老条目原文清空（仅留 hash），currentToken 拿新原文", () => {
  const ring = new InternalTokenRing({ ttlMs: 60_000, rotateIntervalMs: 20_000, autoRotate: false });
  const t0 = ring.currentToken();
  ring.rotate();
  const t1 = ring.currentToken();
  assert.notEqual(t0, t1);
  // 两次 envForChild 拿到同一个（最新）token，稳定可重复注入
  assert.deepEqual(ring.envForChild(), ring.envForChild());
  assert.equal(ring.envForChild().ST_INTERNAL_TOKEN, t1);
  ring.stop();
});

test("InternalTokenRing: ringSize 上限裁剪 + status 不泄露秘密", () => {
  const ring = new InternalTokenRing({ ttlMs: 60_000, rotateIntervalMs: 20_000, ringSize: 3, autoRotate: false });
  for (let i = 0; i < 6; i++) ring.rotate();
  const st = ring.status();
  assert.equal(st.size, 3, "ring capped to ringSize");
  assert.equal(st.ttlMs, 60_000);
  assert.equal(st.rotateIntervalMs, 20_000);
  assert.ok(st.current && st.current.expiresAt > Date.now());
  // status 不含原文/hash
  assert.equal(JSON.stringify(st).includes("sti_"), false);
  ring.stop();
});

test("InternalTokenRing: 自动轮换定时器按间隔生成新 token", async () => {
  const ring = new InternalTokenRing({ ttlMs: 2_000, rotateIntervalMs: 50, autoRotate: true });
  const t0 = ring.currentToken();
  await new Promise((r) => setTimeout(r, 140));
  const t1 = ring.currentToken();
  assert.notEqual(t0, t1, "auto-rotate produced a new token");
  assert.equal(ring.verify(bearer(t0)), true, "old still valid within TTL (overlap)");
  assert.equal(ring.verify(bearer(t1)), true);
  ring.stop();
});

test("InternalTokenRing: stop 清空 ring，verify 一律 false", () => {
  const ring = new InternalTokenRing({ ttlMs: 60_000, rotateIntervalMs: 20_000, autoRotate: false });
  const t = ring.currentToken();
  assert.equal(ring.verify(bearer(t)), true);
  ring.stop();
  assert.equal(ring.verify(bearer(t)), false);
  // stop 后 currentToken 会重新 spawn（ring 不再为空）——这是设计如此，
  // 避免 stop 后调用方拿空值；要彻底停用应不持有 ring 引用。
  assert.match(ring.currentToken(), /^sti_/);
  ring.stop();
});

test("InternalTokenRing: rotateIntervalMs > ttlMs 被夹到 ttl（不抛错）", () => {
  const ring = new InternalTokenRing({ ttlMs: 1_000, rotateIntervalMs: 5_000, autoRotate: false });
  assert.equal(ring.status().rotateIntervalMs, 1_000, "clamped to ttl");
  ring.stop();
});
