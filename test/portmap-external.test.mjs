/**
 * 外部连通性验证（可选）——真实路由器 + 公网 vantage point。
 *
 * 环境变量门控（未设置自动 skip，不依赖 CI）：
 *   ST_TESTSERVER   SSH 目标：user@host 或 user@host:port（公网主机，免密登录）
 *   ST_TEST_GATEWAY 路由器网关 IP（可选；缺省自动探测默认网关）
 *
 * 流程：本地起 HTTP 服务 → 真实 portmap 映射 → SSH 到公网主机 curl
 * http://<externalIp>:<extPort>/ → 断言响应内容 → 清理映射。
 * 这是「外部可达性真实验证」——内网 hairpin 测不到的最后一环。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGateway } from "../src/portmap/probe.ts";

function sshRun(target, cmd, timeoutMs = 20_000) {
  // target: user@host or user@host:port
  const m = /^([^@]+)@([^:]+)(?::(\d+))?$/.exec(target);
  if (!m) return Promise.reject(new Error(`ST_TESTSERVER must be user@host[:port], got "${target}"`));
  const [, user, host, port] = m;
  return new Promise((resolve, reject) => {
    execFile(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", ...(port ? ["-p", port] : []), `${user}@${host}`, cmd],
      { timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`ssh ${target}: ${(stderr || err.message).trim()}`));
        else resolve(stdout);
      },
    );
  });
}

test("external reachability: real router mapping verified from a public host (ST_TESTSERVER)", { timeout: 120_000 }, async (t) => {
  const target = process.env.ST_TESTSERVER;
  if (!target) {
    t.skip("ST_TESTSERVER not set (public SSH host to verify from, e.g. user@host)");
    return;
  }
  const gateway = process.env.ST_TEST_GATEWAY ?? defaultGateway();
  if (!gateway) {
    t.skip("no gateway detected — cannot build a real port mapping");
    return;
  }

  const base = mkdtempSync(join(tmpdir(), "st-portmap-ext-"));
  const { createServiceTunnels } = await import("../src/index.ts");
  const st = createServiceTunnels({ configDir: join(base, "config"), cacheDir: join(base, "cache"), guardian: false });
  // app 监听 127.0.0.1（模拟真实服务）——portmap 映射的是 proxy transport
  // （transport 监听所有接口），app 本身不需要对 LAN 可见。
  const app = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/plain" });
    r.end("portmap-external-ok");
  });
  await new Promise((res) => app.listen(0, "127.0.0.1", res));
  const appPort = app.address().port;

  let exposed;
  try {
    // 1. 完整 expose 链路（transport + 映射）——映射目标 = proxy transport 端口
    exposed = await st.auth.expose(appPort, {
      mode: "portmap",
      auth: false,
      allowAuthNone: true,
      force: true,
      portmap: { method: "auto", gateway, leaseSeconds: 120 },
    });
    if (!exposed.url) {
      const msg = exposed.error ?? "expose failed";
      if (/(no UPnP|no NAT-PMP|CGNAT|private)/.test(msg)) t.skip(`environment does not support portmap: ${msg}`);
      else throw new Error(`expose failed: ${msg}`);
      return;
    }
    const externalIp = exposed.portmap.externalIp;
    const externalPort = exposed.portmap.externalPort;
    // 2. 公网主机反向访问（真实外部视角）
    const out = await sshRun(target, `curl -s -m 10 http://${externalIp}:${externalPort}/`);
    assert.match(out, /portmap-external-ok/, `public host reply: ${JSON.stringify(out)}`);
    t.diagnostic(`external OK: http://${externalIp}:${externalPort} verified from ${target}`);
  } catch (e) {
    // 路由器侧不可控的失败 → skip；映射成功但外部验证失败 → fail（真实 bug 信号）
    if (e && typeof e.message === "string" && /(ssh .*: (Connection refused|timed out|Host key verification failed))/.test(e.message)) {
      t.skip(`test server unreachable: ${e.message}`);
    } else {
      throw e;
    }
  } finally {
    try {
      if (exposed?.url) {
        const key = st.portmap.list().find((x) => x.externalPort === exposed.portmap.externalPort)?.key;
        if (key) await st.portmap.stop(key);
      }
    } catch { /* best effort */ }
    await new Promise((res) => app.close(res));
    rmSync(base, { recursive: true, force: true });
  }
});
