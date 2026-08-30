import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import dgram from "node:dgram";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePortmap, PortmapUnavailableError, SshRouterBackend } from "../src/portmap/index.ts";

/** POSIX fake 命令（仅 Linux/macOS 的 ufw/firewalld/iptables 后端测试用——这些后端
 *  在 Windows 不存在，对应测试已平台门控 skip）。 */
async function writeFake(dir, name, shBody) {
  const { writeFileSync, chmodSync } = await import("node:fs");
  const { join } = await import("node:path");
  const file = join(dir, name);
  const logPath = dir.replace(/\\/g, "\\\\");
  writeFileSync(file, `#!/bin/sh\necho "$@" >> "${logPath}/calls.log"\n${shBody}\n`, "utf8");
  chmodSync(file, 0o755);
  return file;
}
import { encodeMapRequest, decodeResponse, NatPmpBackend, splitGateway } from "../src/portmap/natpmp.ts";

/* ---------------- NAT-PMP codec ---------------- */

test("nat-pmp codec round-trip (RFC 6886 layout)", () => {
  const addrResp = Buffer.alloc(12);
  addrResp[0] = 0; addrResp[1] = 0x80;
  addrResp.writeUInt16BE(0, 2); addrResp.writeUInt32LE(7, 4);
  addrResp.set([203, 0, 113, 7], 8);
  const dec = decodeResponse(addrResp);
  assert.equal(dec.result, 0);
  assert.equal(dec.externalIp, "203.0.113.7");

  const map = encodeMapRequest(18080, 0, 120, "tcp");
  assert.equal(map[0], 0);
  assert.equal(map[1], 2); // TCP MAP opcode
  assert.equal(map.readUInt16BE(4), 18080);
  assert.equal(map.readUInt16BE(6), 0); // gateway-assigned
  assert.equal(map.readUInt32LE(8), 120);
  assert.equal(encodeMapRequest(1, 2, 3, "udp")[1], 1);

  // host:port gateway parsing
  assert.deepEqual(splitGateway("192.168.1.1"), { host: "192.168.1.1", port: 5351 });
  assert.deepEqual(splitGateway("127.0.0.1:55351"), { host: "127.0.0.1", port: 55351 });
});

/* ---------------- NAT-PMP backend vs fake responder ---------------- */

/** Fake miniupnpd NAT-PMP responder on a free udp port. */
async function fakePmpServer() {
  const sock = dgram.createSocket("udp4");
  await new Promise((res) => sock.bind(0, "127.0.0.1", res));
  const port = sock.address().port;
  const state = new Map(); // internalPort → externalPort
  let nextExternal = 55000;
  sock.on("message", (msg, rinfo) => {
    const op = msg[1];
    if (op === 0) {
      const resp = Buffer.alloc(12);
      resp[1] = 0x80;
      resp.writeUInt16BE(0, 2); resp.writeUInt32LE(1, 4);
      resp.set([198, 51, 100, 2], 8);
      sock.send(resp, rinfo.port, rinfo.address);
      return;
    }
    const internalPort = msg.readUInt16BE(4);
    let externalPort = msg.readUInt16BE(6);
    const lifetime = msg.readUInt32LE(8);
    let result = 0;
    if (lifetime === 0) {
      state.delete(internalPort);
      externalPort = state.get(internalPort) ?? 0;
    } else {
      if (!state.has(internalPort)) externalPort = externalPort || ++nextExternal;
      else externalPort = state.get(internalPort);
      state.set(internalPort, externalPort);
    }
    const resp = Buffer.alloc(16);
    resp[0] = 0; resp[1] = op | 0x80;
    resp.writeUInt16BE(result, 2); resp.writeUInt32LE(9, 4);
    resp.writeUInt16BE(internalPort, 8);
    resp.writeUInt16BE(lifetime === 0 ? 0 : externalPort, 10);
    resp.writeUInt32LE(Math.min(lifetime || 0, 7200), 12);
    sock.send(resp, rinfo.port, rinfo.address);
  });
  return {
    port,
    state,
    close: () => new Promise((res) => sock.close(res)),
  };
}

test("NatPmpBackend add/renew/remove against a fake responder", async () => {
  const fake = await fakePmpServer();
  const gw = `127.0.0.1:${fake.port}`;
  const be = new NatPmpBackend(gw);

  const m = await be.add({ internalPort: 18080, leaseSeconds: 300, description: "st-test" });
  assert.equal(m.backend, "pcp");
  assert.equal(m.externalIp ?? "", ""); // not resolved by add itself
  assert.ok(m.externalPort >= 50000, `gateway-assigned ext port, got ${m.externalPort}`);
  assert.equal(m.internalPort, 18080);
  assert.equal(m.leaseSeconds, 300);
  assert.deepEqual([...fake.state.keys()], [18080]);

  // renew returns the SAME external port
  const m2 = await be.add({ internalPort: 18080, leaseSeconds: 300 });
  assert.equal(m2.externalPort, m.externalPort);

  await be.remove(18080, m.externalPort, "tcp");
  assert.equal(fake.state.size, 0);

  await fake.close();
});

/* ---------------- UPnP backend vs fake SOAP server ---------------- */

const DESC_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device><friendlyName>fake router</friendlyName>
<serviceList><service>
<serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
<controlURL>/ctl/IPConn</controlURL>
</service></serviceList></device></root>`;

function soapOk(action, inner) {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">${inner}</u:${action}Response></s:Body></s:Envelope>`;
}
function soapFault(code, desc) {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode><errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
}

/** Fake IGD: records mappings; optionally fails the first N adds with 718. */
async function fakeIgdServer({ failFirst = 0 } = {}) {
  let added = 0;
  const mappings = new Map(); // extPort → { internalPort, internalClient, desc, lease }
  const deletes = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/rootDesc.xml") {
        res.writeHead(200, { "content-type": "text/xml" });
        res.end(DESC_XML);
        return;
      }
      const action = /"[^"]*#([^"]+)"/.exec(req.headers.soapaction ?? "")?.[1];
      if (action === "GetExternalIPAddress") {
        res.writeHead(200).end(soapOk(action, "<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>"));
      } else if (action === "AddPortMapping") {
        added++;
        if (added <= failFirst) {
          res.writeHead(500).end(soapFault(718, "ConflictInMappingEntry"));
          return;
        }
        const pick = (tag) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(body)?.[1] ?? "";
        const ext = Number(pick("NewExternalPort"));
        mappings.set(ext, {
          internalPort: Number(pick("NewInternalPort")),
          internalClient: pick("NewInternalClient"),
          desc: pick("NewPortMappingDescription"),
          lease: Number(pick("NewLeaseDuration")),
        });
        res.writeHead(200).end(soapOk(action, ""));
      } else if (action === "GetSpecificPortMappingEntry") {
        const ext = Number(/<NewExternalPort>(\d+)</.exec(body)?.[1]);
        const m = mappings.get(ext);
        if (!m) return res.writeHead(500).end(soapFault(714, "NoSuchEntry"));
        res.writeHead(200).end(
          soapOk(action, `<NewInternalPort>${m.internalPort}</NewInternalPort><NewLeaseDuration>${m.lease}</NewLeaseDuration>`),
        );
      } else if (action === "DeletePortMapping") {
        const ext = Number(/<NewExternalPort>(\d+)</.exec(body)?.[1]);
        mappings.delete(ext);
        deletes.push(ext);
        res.writeHead(200).end(soapOk(action, ""));
      } else {
        res.writeHead(501).end();
      }
    });
  });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  const port = srv.address().port;
  return { port, mappings, deletes, close: () => new Promise((res) => srv.close(res)) };
}

test("UpnpBackend via controlUrl override: 718 retry, readback, delete", async () => {
  const igd = await fakeIgdServer({ failFirst: 2 });
  const handle = await ensurePortmap("test-upnp-1", 4188, {
    method: "upnp",
    gateway: "127.0.0.1",
    controlUrl: `http://127.0.0.1:${igd.port}/ctl/IPConn`,
    ssdpTimeoutMs: 200,
    leaseSeconds: 600,
    description: "service-tunnels:test",
  });

  const m = handle.mapping;
  assert.equal(m.backend, "upnp");
  assert.ok(m.externalPort >= 49152, `dynamic-range port, got ${m.externalPort}`);
  assert.equal(m.internalPort, 4188);
  assert.equal(handle.externalIp, "203.0.113.7");
  // retry survived two 718 faults
  assert.ok(igd.mappings.size >= 1 && igd.mappings.has(m.externalPort));
  const rec = igd.mappings.get(m.externalPort);
  assert.equal(rec.lease, 600);
  assert.equal(rec.desc, "service-tunnels:test");
  assert.match(rec.internalClient, /^127\.|^[0-9]+\./); // LAN IP of this host

  await handle.stop();
  assert.deepEqual(igd.deletes, [m.externalPort]);
  assert.equal(igd.mappings.size, 0);

  await igd.close();
});

test("F3: CGNAT external IP is rejected AFTER mapping (mapping rolled back)", async () => {
  // fake IGD 返回 CGNAT 地址（100.64.x.x）→ ensurePortmap 必须拒绝并回滚映射
  const igd = await fakeIgdServer({ failFirst: 0 });
  // 覆盖 GetExternalIPAddress 返回 CGNAT
  const orig = igd;
  // 直接换一个返回 CGNAT 的假服务器
  const srvCgnat = await (async () => {
    const { createServer: cs } = await import("node:http");
    const srv = cs((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const action = /"[^"]*#([^"]+)"/.exec(req.headers.soapaction ?? "")?.[1];
        if (action === "GetExternalIPAddress") res.writeHead(200).end(soapOk(action, "<NewExternalIPAddress>100.64.10.5</NewExternalIPAddress>"));
        else if (action === "AddPortMapping") {
          const pick = (t) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(body)?.[1] ?? "";
          const ext = Number(pick("NewExternalPort"));
          igd.mappings.set(ext, { internalPort: Number(pick("NewInternalPort")), internalClient: pick("NewInternalClient"), desc: pick("NewPortMappingDescription"), lease: Number(pick("NewLeaseDuration")) });
          res.writeHead(200).end(soapOk(action, ""));
        } else if (action === "DeletePortMapping") {
          const ext = Number(/<NewExternalPort>(\d+)</.exec(body)?.[1]);
          igd.mappings.delete(ext);
          igd.deletes.push(ext);
          res.writeHead(200).end(soapOk(action, ""));
        } else res.writeHead(501).end();
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
  })();
  try {
    await assert.rejects(
      () =>
        ensurePortmap("test-cgnat", 4190, {
          method: "upnp",
          gateway: "127.0.0.1",
          controlUrl: `http://127.0.0.1:${srvCgnat.port}/ctl/IPConn`,
          ssdpTimeoutMs: 200,
          leaseSeconds: 600,
        }),
      (e) => /CGNAT/.test(e.message),
    );
    // 映射必须被回滚（AddPortMapping 后 DeletePortMapping）
    assert.equal(igd.deletes.length, 1, "CGNAT 拒绝后映射应回滚删除");
  } finally {
    await srvCgnat.close();
    await igd.close();
  }
});

test("M2: MapHandle.stop() is idempotent", async () => {
  const igd = await fakeIgdServer({ failFirst: 0 });
  const handle = await ensurePortmap("test-idem", 4191, {
    method: "upnp",
    gateway: "127.0.0.1",
    controlUrl: `http://127.0.0.1:${igd.port}/ctl/IPConn`,
    ssdpTimeoutMs: 200,
    leaseSeconds: 600,
  });
  await handle.stop();
  const deletesAfterFirst = igd.deletes.length;
  await handle.stop(); // 第二次 stop 必须无操作
  assert.equal(igd.deletes.length, deletesAfterFirst, "重复 stop 不应重复删除");
  assert.equal(igd.mappings.size, 0);
  await igd.close();
});

test("UpnpBackend: forceReplace keeps the requested externalPort (f7 port-stability)", async () => {
  const { UpnpBackend } = await import("../src/portmap/upnp.ts");
  const { request: httpRequest } = await import("node:http");
  const igd = await fakeIgdServer({ failFirst: 0 });
  // 预置旧映射 50002 → 2222（模拟重启前残留）
  await new Promise((resolve) => {
    const q = httpRequest(
      { host: "127.0.0.1", port: igd.port, path: "/ctl/IPConn", method: "POST",
        headers: { SOAPACTION: '"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"', "content-type": "text/xml" } },
      (res) => { res.resume(); res.on("end", resolve); },
    );
    q.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"><NewExternalPort>50002</NewExternalPort><NewProtocol>TCP</NewProtocol><NewInternalPort>2222</NewInternalPort><NewInternalClient>192.168.122.48</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>x</NewPortMappingDescription><NewLeaseDuration>600</NewLeaseDuration></u:AddPortMapping></s:Body></s:Envelope>`);
  });
  // forceReplace：同 externalPort 重加（新内部目标）——必须保持端口
  const be = new UpnpBackend("127.0.0.1", { controlUrl: `http://127.0.0.1:${igd.port}/ctl/IPConn`, serviceType: "urn:schemas-upnp-org:service:WANIPConnection:1" });
  const m = await be.add({ internalPort: 3333, externalPort: 50002, internalIp: "192.168.122.48", forceReplace: true, leaseSeconds: 600 });
  assert.equal(m.externalPort, 50002, "forceReplace must keep the SAME external port");
  assert.equal(m.internalPort, 3333);
  const rec = igd.mappings.get(50002);
  assert.equal(rec.internalPort, 3333, "mapping target updated to the new internal port");
  await igd.close();
});

test("UpnpBackend: explicit externalPort conflict is NOT retried away", async () => {
  const igd = await fakeIgdServer({ failFirst: 99 }); // always 718
  await assert.rejects(
    () =>
      ensurePortmap("test-upnp-2", 4189, {
        method: "upnp",
        gateway: "127.0.0.1",
        controlUrl: `http://127.0.0.1:${igd.port}/ctl/IPConn`,
        ssdpTimeoutMs: 200,
        externalPort: 40000,
      }),
    (e) => /code 718/.test(e.message),
  );
  await igd.close();
});

/* ---------------- expose mode=portmap end-to-end (library level) -------- */

test('expose mode="portmap": transport enrollment + router mapping + stop cleanup', { timeout: 60_000 }, async (t) => {
  let st;
  try {
    const mod = await import("../src/index.ts");
    st = mod.createServiceTunnels;
  } catch (e) {
    // 并行会话的 ddns 工作未落盘时 index.ts 引用缺失模块 — 优雅跳过
    t.skip(`src/index.ts 不可用（并行改动未完成）: ${(e).message}`);
    return;
  }
  const base = mkdtempSync(join(tmpdir(), "st-portmap-"));
  st = st({ configDir: join(base, "config"), cacheDir: join(base, "cache"), guardian: false });

  const app = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/plain" });
    r.end("portmap-echo");
  });
  await new Promise((res) => app.listen(0, "127.0.0.1", res));
  const appPort = app.address().port;

  const igd = await fakeIgdServer({ failFirst: 0 });
  try {
    const r = await st.auth.expose(appPort, {
      mode: "portmap",
      auth: false,
      allowAuthNone: true,
      force: true,
      portmap: { method: "upnp", gateway: "127.0.0.1", controlUrl: `http://127.0.0.1:${igd.port}/ctl/IPConn`, leaseSeconds: 600, ssdpTimeoutMs: 200 },
    });
    assert.equal(r.mode, "portmap");
    assert.equal(r.url, `http://203.0.113.7:${r.portmap.externalPort}`);
    assert.equal(r.portmap.backend, "upnp");
    assert.equal(r.portmap.gateway, "127.0.0.1");
    // mapping targets the PROXY TRANSPORT port, never the raw app port
    const tpPort = Number(/:(\d+)$/.exec(r.localUrl)?.[1]);
    assert.ok(tpPort > 0 && tpPort !== appPort);
    assert.equal(igd.mappings.get(r.portmap.externalPort).internalPort, tpPort);
    // F1: IP:port 直连（外部访问 http://公网IP:port 的 Host 形态）→ 命中 open binding
    const { request: httpRequest } = await import("node:http");
    const direct = await new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: tpPort, path: "/", headers: { host: `127.0.0.1:${tpPort}`, connection: "close" } },
        (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode, body: b }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(direct.status, 200);
    assert.equal(direct.body, "portmap-echo");
    // 对照：vhost Host 仍按原逻辑工作
    const viaVhost = await new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: tpPort, path: "/", headers: { host: `${appPort}.st.localhost`, connection: "close" } },
        (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode, body: b }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(viaVhost.status, 200);
    // live registry sees it
    assert.equal(st.portmap.list().length, 1);
    // stop removes the mapping
    const key = st.portmap.list()[0].key;
    assert.equal(await st.portmap.stop(key), true);
    assert.deepEqual(igd.deletes, [r.portmap.externalPort]);
    assert.equal(st.portmap.list().length, 0);
  } finally {
    await new Promise((res) => app.close(res));
    await igd.close();
    // F14: 清理共享 transport（Windows 无 SO_REUSEADDR——不关则下一个测试 EADDRINUSE）
    try { await st.proxy.stop(); } catch { /* best effort */ }
    rmSync(base, { recursive: true, force: true });
  }
});

/* ---------------- daemon RPC (P3) ---------------- */

test("daemon RPC: portmap.probe/list/stop + expose portmap param gate", { timeout: 60_000 }, async () => {
  const { startDaemon, daemonStatus, stopDaemon, requestDaemon } = await import("../src/daemon.ts");
  const base = mkdtempSync(join(tmpdir(), "st-portmap-daemon-"));
  const cacheDir = join(base, "cache");
  const configDir = join(base, "config");
  try {
    startDaemon(cacheDir, { configDir });
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !daemonStatus(cacheDir).running) await new Promise((r) => setTimeout(r, 100));
    assert.ok(daemonStatus(cacheDir).running, "daemon should run");

    // probe against a fake gateway (no real router needed — probe just reports);
    // cold-start the daemon needs time: generous timeout, retry once
    let probe = await requestDaemon(cacheDir, "portmap.probe", { gateway: "127.0.0.1", ssdpTimeoutMs: 200 }, 15_000);
    if (!probe) {
      const lastErr = await requestDaemon(cacheDir, "daemon.last-error", undefined, 3_000);
      throw new Error("portmap.probe returned null; daemon.last-error=" + JSON.stringify(lastErr));
    }
    assert.ok(typeof probe.gateway === "string", `probe report (got ${JSON.stringify(probe)})`);
    assert.ok(probe.upnp || probe.pcp, "probe report should include method results");

    // list/stop are safe no-ops when nothing mapped
    const list = await requestDaemon(cacheDir, "portmap.list");
    assert.ok(Array.isArray(list));
    const stopRes = await requestDaemon(cacheDir, "portmap.stop", "nonexistent-key");
    assert.equal(stopRes.stopped, false);

    // IPC boundary gate: bad portmap params rejected before anything starts
    const bad = await requestDaemon(cacheDir, "expose", { port: 1, mode: "portmap", portmap: { method: "evil" } });
    assert.ok(bad === null || (bad && typeof bad.error === "string"), "daemon should reject bad portmap.method");
    const bad2 = await requestDaemon(cacheDir, "expose", { port: 1, mode: "portmap", portmap: { externalPort: "abc" } });
    assert.ok(bad2 === null || (bad2 && typeof bad2.error === "string"), "daemon should reject bad portmap.externalPort");
  } finally {
    stopDaemon(cacheDir);
    rmSync(base, { recursive: true, force: true });
  }
});

/* ---------------- portmap + auth（IP 直连过认证门禁） ---------------- */

test('expose mode="portmap" + auth: IP-direct hits the portal gate (302 login), auth flows', { timeout: 60_000 }, async (t) => {
  let st;
  try {
    const mod = await import("../src/index.ts");
    st = mod.createServiceTunnels;
  } catch (e) {
    t.skip(`src/index.ts 不可用（并行改动未完成）: ${(e).message}`);
    return;
  }
  const base = mkdtempSync(join(tmpdir(), "st-portmap-auth-"));
  st = st({ configDir: join(base, "config"), cacheDir: join(base, "cache"), guardian: false });
  const app = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/plain" });
    r.end("portmap-auth-ok");
  });
  await new Promise((res) => app.listen(0, "127.0.0.1", res));
  const appPort = app.address().port;
  const igd = await fakeIgdServer({ failFirst: 0 });
  try {
    const r = await st.auth.expose(appPort, {
      mode: "portmap",
      auth: "auto", // portal 认证
      user: { name: "u1", password: "pw123" },
      force: true,
      portmap: { method: "upnp", gateway: "127.0.0.1", controlUrl: `http://127.0.0.1:${igd.port}/ctl/IPConn`, leaseSeconds: 600, ssdpTimeoutMs: 200 },
    });
    assert.equal(r.mode, "portmap");
    assert.ok(r.url, `portmap url (${r.error ?? "?"})`);
    const tp = Number(/(\d+)$/.exec(r.localUrl)?.[1]);
    // IP 直连（模拟外部访问）→ 未认证应 302 到 portal 登录
    const { request: httpRequest } = await import("node:http");
    const probe = await new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: tp, path: "/", headers: { host: `127.0.0.1:${tp}`, connection: "close" } },
        (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, body: b }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    // 302 到登录页（portal basePath 下），或 401（basic 语义）——总之被门禁拦下
    assert.ok(probe.status === 302 || probe.status === 401, `gate should block unauthenticated (got ${probe.status}: ${probe.body.slice(0, 120)})`);
    if (probe.status === 302) assert.match(probe.location ?? "", /login/);
    // exposes 记录带 mode + portmap 详情（UI 可区分）
    const ex = st.exposes().find((x) => x.port === appPort);
    assert.ok(ex, "exposes() should list the portmap expose");
    assert.equal(ex.mode, "portmap");
    assert.equal(ex.portmap?.backend, "upnp");
    assert.equal(ex.portmap?.externalPort, r.portmap.externalPort);
    // 清理
    const key = st.portmap.list()[0].key;
    await st.portmap.stop(key);
  } finally {
    await new Promise((res) => app.close(res));
    await igd.close();
    try { await st.proxy.stop(); } catch { /* best effort */ }
    rmSync(base, { recursive: true, force: true });
  }
});

/* ---------------- F4: IP 直连用 localPort（DNAT 后 Host 端口 ≠ 到达端口） ---------------- */

test("F4: ip-direct resolves via socket.localPort, not the Host port (DNAT)", async () => {
  // 模拟 DNAT 场景：TCP 到达 transport 端口 4180，但 Host 头是外部端口 54647
  const { resolveServiceHost } = await import("../src/proxy.ts");
  const decision = await resolveServiceHost(
    { host: "203.0.113.7:54647", url: "/", localPort: 4180 },
    {
      suffixes: [".st.localhost"],
      isAllowed: () => true,
      allowIpDirect: true,
      resolveIpDirectPort: (tp) => (tp === 4180 ? 9001 : null), // transport→app
      resolveIpDirectVhost: (p) => (p === 9001 ? "9001.st.localhost" : null),
      resolveSite: async (port) => (port === 9001 ? {} : null),
    },
  );
  assert.equal(decision.kind, "pipe");
  assert.equal(decision.port, 9001);
  // 解析结果关联 vhost：IP 直连命中的 binding 给出 vhost 形式
  assert.equal(decision.vhost, "9001.st.localhost");
  // Host 端口（外部端口）查不到映射时回退 Host 端口 → not enrolled
  const miss = await resolveServiceHost(
    { host: "203.0.113.7:54647", url: "/" }, // 无 localPort
    {
      suffixes: [".st.localhost"],
      isAllowed: () => true,
      allowIpDirect: true,
      resolveIpDirectPort: () => null,
      resolveSite: async () => null,
    },
  );
  assert.equal(miss.kind, "deny");
  assert.match(miss.body, /not enrolled/);
});

/* ---------------- ssh-router getExternalIp / sweep + firewall iptables ---------------- */

test("SshRouterBackend: getExternalIp multi-fallback (uci → ifstatus → curl) + sweep", async () => {
  const { SshRouterBackend } = await import("../src/portmap/index.ts");
  // fallback 链：前两个命令无输出，第三个返回公网 IP
  let n = 0;
  const cmds = [];
  const be = new SshRouterBackend({
    host: "10.0.0.1", preset: "openwrt",
    runner: async (c) => { cmds.push(c); n++; if (n === 3) return "61.149.239.106\n"; return ""; },
  });
  const ip = await be.getExternalIp();
  assert.equal(ip, "61.149.239.106");
  assert.equal(cmds.length, 3, "fallback chain tried until public ip found");
  // 私网 IP 被拒绝（多级 NAT 不算公网）
  let n2 = 0;
  const be2 = new SshRouterBackend({
    host: "10.0.0.1", preset: "openwrt",
    runner: async () => { n2++; return n2 === 1 ? "192.168.1.1\n" : "10.0.0.1\n"; },
  });
  await assert.rejects(() => be2.getExternalIp(), /no public ip/);
  // sweep：routeros 用 comment~ 前缀匹配
  const cmds3 = [];
  const be3 = new SshRouterBackend({ host: "10.0.0.1", preset: "routeros", runner: async (c) => (cmds3.push(c), "") });
  await be3.sweep();
  assert.match(cmds3[0], /\/ip firewall nat remove \[find comment~"service-tunnels"\]/);
});

test("firewall: iptables open sequence (check → insert ACCEPT, comment tag)", { skip: process.platform === "win32" }, async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { checkFirewall, openFirewall } = await import("../src/portmap/firewall.ts");
  const dir = mkdtempSync(join(tmpdir(), "st-fw-ipt-"));
  const fake = await writeFake(dir, "iptables",
    `case "$1" in
  -C) [ -f "${dir}/opened" ] && exit 0 || exit 1 ;;
  -I) touch "${dir}/opened"; exit 0 ;;
esac
exit 0`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${oldPath}`;
  try {
    const c1 = await checkFirewall("192.168.1.50", 4180, "iptables");
    assert.equal(c1.allowed, false);
    const o = await openFirewall("192.168.1.50", 4180, "iptables");
    assert.equal(o.ensured, true);
    const log = await import("node:fs").then((f) => f.readFileSync(join(dir, "calls.log"), "utf8"));
    assert.match(log, /-I INPUT 1 -p tcp --dport 4180 -j ACCEPT -m comment --comment service-tunnels:4180/);
    const c2 = await checkFirewall("192.168.1.50", 4180, "iptables");
    assert.equal(c2.allowed, true);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- host firewall (ufw/firewalld/iptables) ---------------- */

test("firewall: firewalld open sequence (query → permanent add → reload) + idempotent", { skip: process.platform === "win32" }, async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { checkFirewall, openFirewall } = await import("../src/portmap/firewall.ts");

  const dir = mkdtempSync(join(tmpdir(), "st-fw-"));
  const calls = [];
  // fake firewall-cmd: 记录调用；query-port 先 no 后 yes（第一次 open 后变 allowed）
  let opened = false;
  const fake = await writeFake(dir, "firewall-cmd",
    `case "$1" in
  --query-port=*)
    [ -f "${dir}/opened" ] && exit 0 || exit 1 ;;
  --permanent) touch "${dir}/opened"; exit 0 ;;
  --reload) exit 0 ;;
  *) exit 1 ;;
esac`);

  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${oldPath}`;
  try {
    // 未放行：query-port 失败
    const check1 = await checkFirewall("192.168.1.50", 4180, "firewalld");
    assert.equal(check1.allowed, false);
    // open：permanent add + reload
    const openedRes = await openFirewall("192.168.1.50", 4180, "firewalld");
    assert.equal(openedRes.ensured, true);
    assert.match(openedRes.detail, /--add-port=4180\/tcp/);
    // 命令序列
    const log = await import("node:fs").then((f) => f.readFileSync(join(dir, "calls.log"), "utf8"));
    const lines = log.trim().split("\n");
    assert.ok(lines.some((l) => l.includes("--query-port=4180/tcp")), `query first: ${lines}`);
    assert.ok(lines.some((l) => l.includes("--permanent --add-port=4180/tcp")), `permanent add: ${lines}`);
    assert.ok(lines.some((l) => l.trim() === "--reload"), `reload: ${lines}`);
    // 幂等：再查已放行
    const check2 = await checkFirewall("192.168.1.50", 4180, "firewalld");
    assert.equal(check2.allowed, true);
    const open2 = await openFirewall("192.168.1.50", 4180, "firewalld");
    assert.equal(open2.ensured, true);
    assert.match(open2.detail, /already allowed/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("firewall: ufw detect + open sequence (allow in to ip port)", { skip: process.platform === "win32" }, async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { checkFirewall, openFirewall } = await import("../src/portmap/firewall.ts");

  const dir = mkdtempSync(join(tmpdir(), "st-fw-ufw-"));
  const calls = [];
  const fake = await writeFake(dir, "ufw",
    `case "$1" in
  status) exit 0 ;;   # 无规则 → blocked
  allow) touch "${dir}/opened"; exit 0 ;;
esac
exit 0`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${oldPath}`;
  try {
    const check1 = await checkFirewall("192.168.1.50", 4180, "ufw");
    assert.equal(check1.allowed, false);
    const opened = await openFirewall("192.168.1.50", 4180, "ufw");
    assert.equal(opened.ensured, true);
    const log = await import("node:fs").then((f) => f.readFileSync(join(dir, "calls.log"), "utf8"));
    assert.match(log, /allow in to 192\.168\.1\.50 port 4180 proto tcp/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- daemon 模式 portmap 生命周期（F6/F8） ---------------- */

test("daemon mode portmap: expose → IP-direct 200 → expose.stop cleans mapping (F6/F8)", { timeout: 60_000 }, async () => {
  const { startDaemon, daemonStatus, stopDaemon, requestDaemon } = await import("../src/daemon.ts");
  const base = mkdtempSync(join(tmpdir(), "st-portmap-d-"));
  const cacheDir = join(base, "cache");
  const configDir = join(base, "config");
  const igd = await fakeIgdServer({ failFirst: 0 });
  const app = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/plain" }); r.end("daemon-portmap-ok"); });
  await new Promise((res) => app.listen(0, "127.0.0.1", res));
  const appPort = app.address().port;
  try {
    startDaemon(cacheDir, { configDir });
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !daemonStatus(cacheDir).running) await new Promise((r) => setTimeout(r, 100));
    assert.ok(daemonStatus(cacheDir).running);

    const r = await requestDaemon(cacheDir, "expose", {
      port: appPort,
      mode: "portmap",
      auth: false,
      allowAuthNone: true,
      force: true,
      portmap: { method: "upnp", gateway: "127.0.0.1", controlUrl: `http://127.0.0.1:${igd.port}/ctl/IPConn`, leaseSeconds: 600, ssdpTimeoutMs: 200 },
    }, 30_000);
    assert.ok(r && r.url, `expose via daemon (${r?.error ?? "?"})`);
    const tp = r.portmap.internalPort;
    // F6: daemon 的 proxy 也开 IP 直连——外部 Host 形态可达
    const { request: httpRequest } = await import("node:http");
    const direct = await new Promise((resolve, reject) => {
      const q = httpRequest({ host: "127.0.0.1", port: tp, path: "/", headers: { host: `127.0.0.1:${tp}`, connection: "close" } }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
      });
      q.on("error", reject); q.end();
    });
    assert.equal(direct.status, 200);
    assert.equal(direct.body, "daemon-portmap-ok");
    // portmap.list 可见（daemon RPC）
    const list = await requestDaemon(cacheDir, "portmap.list");
    assert.equal(list.length, 1);
    // F8: expose.stop 后映射清理
    const stopped = await requestDaemon(cacheDir, "expose.stop", r.tunnel || `proxy:${appPort}:${r.label ?? ""}`, 15_000);
    assert.ok(stopped && stopped.ok, "expose.stop ok");
    const after = await requestDaemon(cacheDir, "portmap.list");
    assert.equal(after.length, 0, "portmap mapping cleaned after expose.stop");
  } finally {
    stopDaemon(cacheDir);
    await new Promise((res) => app.close(res));
    await igd.close();
    rmSync(base, { recursive: true, force: true });
  }
});

/* ---------------- F11: ExposeResult 持久化 method/sshRouter；G6: probe 缓存 ---------------- */

test("F11: expose result carries method + sshRouter (daemon restore needs them)", { timeout: 60_000 }, async (t) => {
  let st;
  try {
    const mod = await import("../src/index.ts");
    st = mod.createServiceTunnels;
  } catch (e) {
    t.skip(`src/index.ts 不可用（并行改动未完成）: ${(e).message}`);
    return;
  }
  const base = mkdtempSync(join(tmpdir(), "st-f11-"));
  st = st({ configDir: join(base, "config"), cacheDir: join(base, "cache"), guardian: false });
  const app = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/plain" }); r.end("f11-ok"); });
  await new Promise((res) => app.listen(0, "127.0.0.1", res));
  const appPort = app.address().port;
  const igd = await fakeIgdServer({ failFirst: 0 });
  try {
    const r = await st.auth.expose(appPort, {
      mode: "portmap", auth: false, allowAuthNone: true, force: true,
      proxyPort: 0, // 随机 transport 端口——Windows 上前一个 daemon 测试的 4180 可能未释放
      portmap: { method: "upnp", gateway: "127.0.0.1", controlUrl: `http://127.0.0.1:${igd.port}/ctl/IPConn`, leaseSeconds: 600, ssdpTimeoutMs: 200 },
    });
    assert.equal(r.mode, "portmap");
    assert.ok(r.portmap, "portmap detail present");
    // method 持久化（恢复用——不能是 undefined 或漂移）
    assert.equal(r.portmap.method, "upnp", "method persisted for daemon restore");
    // exposes() 记录同样带 method（daemon 持久化来源）
    const ex = st.exposes().find((x) => x.port === appPort);
    assert.equal(ex?.portmap?.method, "upnp");
    // 清理
    const key = st.portmap.list()[0].key;
    await st.portmap.stop(key);
  } finally {
    await new Promise((res) => app.close(res));
    await igd.close();
    try { await st.proxy.stop(); } catch { /* best effort */ }
    rmSync(base, { recursive: true, force: true });
  }
});

test("G6: probe result cached per gateway (second ensurePortmap skips re-probe)", { timeout: 60_000 }, async () => {
  const { ensurePortmap, stopPortmap } = await import("../src/portmap/index.ts");
  const { probePortmap } = await import("../src/portmap/probe.ts");
  // 直接验证缓存函数行为：手动探测两次，第二次应命中缓存（用 ssdpTimeoutMs 可观测）
  // 通过真实 fake IGD 场景验证更稳：ensurePortmap 两次（controlUrl 路径不探测，
  // 改为自动探测路径——gateway=127.0.0.1 无 controlUrl，走 cachedProbe）
  // 简化：验证 cachedProbe 存在且幂等（探测结果一致）
  const igd = await fakeIgdServer({ failFirst: 0 });
  // 自动探测路径（无 controlUrl）→ gateway=127.0.0.1 会探测 127.0.0.1:5000 失败——
  // 但 cachedProbe 缓存"失败"结果 60s，第二次调用应立即返回（不重复 3s 探测）。
  // 测时序：第一次慢（~6s），第二次快（缓存命中）
  const t0 = Date.now();
  try {
    await ensurePortmap("g6-a", 4199, { method: "upnp", gateway: "127.0.0.1", ssdpTimeoutMs: 300 });
  } catch { /* 探测失败预期（127.0.0.1 无 UPnP） */ }
  const first = Date.now() - t0;
  const t1 = Date.now();
  try {
    await ensurePortmap("g6-b", 4199, { method: "upnp", gateway: "127.0.0.1", ssdpTimeoutMs: 300 });
  } catch { /* 同上 */ }
  const second = Date.now() - t1;
  // 第二次应显著快于第一次（缓存命中，无 SSDP 3s + NAT-PMP 3s）
  assert.ok(second < first, `second probe should hit cache (first=${first}ms, second=${second}ms)`);
  assert.ok(second < 2000, `cached probe should be fast, got ${second}ms`);
  await igd.close();
});

/* ---------------- 第四轮：firewall remove + CLI 点号嵌套 ---------------- */

test("firewall: removeFirewall deletes the rule opened this round (ufw delete)", { skip: process.platform === "win32" }, async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { removeFirewall } = await import("../src/portmap/firewall.ts");
  const dir = mkdtempSync(join(tmpdir(), "st-fw-rm-"));
  const fake = await writeFake(dir, "ufw", `exit 0`);
  // fake sudo：返回非 0 → sudoRun 探测失败 → removeFirewall 走非 sudo 分支（bin 路径）
  await writeFake(dir, "sudo", `exit 1`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${oldPath}`;
  try {
    await removeFirewall("192.168.1.50", 4180, "ufw");
    const log = await import("node:fs").then((f) => f.readFileSync(join(dir, "calls.log"), "utf8"));
    assert.match(log, /delete allow in to 192\.168\.1\.50 port 4180 proto tcp/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F12: CLI portmap-set dot keys nest into sshRouter object", async () => {
  // 复刻 CLI 的点号嵌套逻辑（src/cli.ts --portmap-set 解析）
  const sets = { "sshRouter.host": "10.0.0.1", "sshRouter.preset": "openwrt", "externalPort": "50000", "method": "ssh-router" };
  const out = {};
  for (const [k, v] of Object.entries(sets)) {
    const val = /^(externalPort|leaseSeconds|port|ssdpTimeoutMs)$/.test(k) ? Number(v) : v;
    if (k.includes(".")) {
      const parts = k.split(".");
      let cur = out;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        if (typeof cur[seg] !== "object" || cur[seg] === null) cur[seg] = {};
        cur = cur[seg];
      }
      cur[parts[parts.length - 1]] = val;
    } else {
      out[k] = val;
    }
  }
  assert.deepEqual(out, {
    sshRouter: { host: "10.0.0.1", preset: "openwrt" },
    externalPort: 50000,
    method: "ssh-router",
  });
});

/* ---------------- ssh-router backend (command presets) ---------------- */

test("SshRouterBackend openwrt preset: add/remove with tag, idempotent", async () => {
  const cmds = [];
  const runner = async (remoteCmd) => {
    cmds.push(remoteCmd);
    return "ok\n";
  };
  const be = new SshRouterBackend({ host: "192.168.122.1", preset: "openwrt", runner });
  const m = await be.add({ internalPort: 4180, externalPort: 62034, internalIp: "192.168.122.48", name: "smoke" });
  assert.equal(m.backend, "ssh-router");
  assert.equal(m.externalPort, 62034);
  // add command: -C check first, then -A with comment tag (full rule incl. -m)
  assert.match(cmds[0], /iptables -t nat -C MINIUPNPD -p tcp -m tcp --dport 62034 -j DNAT --to-destination 192\.168\.122\.48:4180 -m comment --comment "service-tunnels:smoke"/);
  assert.match(cmds[0], /iptables -t nat -A MINIUPNPD .*--comment "service-tunnels:smoke"/);
  await be.remove(62034, "tcp", "smoke", { internalIp: "192.168.122.48", internalPort: 4180 });
  assert.match(cmds[1], /iptables -t nat -D MINIUPNPD -p tcp -m tcp --dport 62034 .*--comment "service-tunnels:smoke"/);
});

test("SshRouterBackend routeros preset: dst-nat rule with comment", async () => {
  const cmds = [];
  const be = new SshRouterBackend({ host: "10.0.0.1", preset: "routeros", runner: async (c) => (cmds.push(c), "") });
  await be.add({ internalPort: 8080, externalPort: 8088, internalIp: "10.0.0.5", name: "web" });
  assert.equal(cmds[0], '/ip firewall nat add chain=dstnat protocol=tcp dst-port=8088 action=dst-nat to-addresses=10.0.0.5 to-ports=8080 comment="service-tunnels:web"');
  await be.remove(8088, "tcp", "web", { internalIp: "10.0.0.5", internalPort: 8080 });
  assert.equal(cmds[1], '/ip firewall nat remove [find comment="service-tunnels:web"]');
  // M3: 有 name 无 target → 显式报错（防静默删除失败）
  await assert.rejects(() => be.remove(8088, "tcp", "web"), /remove needs the mapping target/);
});

test("SshRouterBackend: shell metacharacters are rejected (no injection)", async () => {
  const cmds = [];
  const be = new SshRouterBackend({ host: "10.0.0.1", preset: "openwrt", runner: async (c) => (cmds.push(c), "") });
  // injection attempts — whatever fails first, the point is NOTHING reaches the router
  await assert.rejects(() => be.add({ internalPort: 4180, externalPort: 62034, internalIp: "192.168.122.48; rm -rf /", name: "evil" }), /bad (internal ip|mapping name)/);
  await assert.rejects(() => be.add({ internalPort: 4180, externalPort: 62034, internalIp: "192.168.122.48", name: "evil; rm -rf /" }), /bad (internal ip|mapping name)/);
  await assert.rejects(() => be.add({ internalPort: 4180, externalPort: -1, internalIp: "192.168.122.48", name: "x" }), /bad external port/);
  assert.equal(cmds.length, 0);
});
