import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadSubject() {
  delete globalThis.__serviceTunnelsCache;
  return import("../src/discovery.ts");
}

async function loadInternal() {
  return import("../src/internal.ts");
}

/** Read a child's stdout until a regex matches (or timeout). */
async function readUntil(stream, pattern, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    let buf = "";
    const timer = setTimeout(() => done(null), timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = pattern.exec(buf);
      if (m) done(m);
    };
    const done = (result) => {
      clearTimeout(timer);
      stream.off("data", onData);
      resolve(result);
    };
    stream.on("data", onData);
  });
}

function pickFreePort() {
  return new Promise((resolve) => {
    const srv = connect(0);
    srv.once("connect", () => {
      srv.destroy();
      resolve(20_000 + Math.floor(Math.random() * 30_000));
    });
    srv.once("error", () => {
      const port = 20_000 + Math.floor(Math.random() * 30_000);
      srv.destroy();
      resolve(port);
    });
  });
}

const HTTP_LISTENER = (port) => `
  const s = require("http").createServer((q, r) => r.end("ok"));
  s.listen(${port}, "127.0.0.1", () => process.stdout.write("READY"));
  setInterval(() => {}, 1000);
`;

test("decodes /proc/net/tcp IPv4 addresses (little-endian)", async () => {
  const { decodeIpv4 } = await loadSubject();
  assert.equal(decodeIpv4("0100007F"), "127.0.0.1");
  assert.equal(decodeIpv4("00000000"), "0.0.0.0");
  assert.equal(decodeIpv4("C0A80132"), "50.1.168.192");
});

test("decodes /proc/net/tcp6 addresses (little-endian 32-bit groups)", async () => {
  const { decodeIpv6 } = await loadSubject();
  assert.equal(decodeIpv6("00000000000000000000000000000000"), "::");
  assert.equal(decodeIpv6("00000000000000000000000001000000"), "::1");
  assert.equal(decodeIpv6("0000000000000000FFFF00000100007F"), "::ffff:7f00:1");
});

test("identifies service-tunnels own command lines", async () => {
  const { isOwnProcess } = await loadSubject();
  assert.equal(isOwnProcess("node /app/bin/service-tunnels.mjs discover"), true);
  assert.equal(isOwnProcess("node /app/src/daemon-server.ts"), true);
  assert.equal(isOwnProcess("node /usr/lib/node_modules/service-tunnels/bin/service-tunnels.mjs"), true);
  assert.equal(isOwnProcess("python3 /app/server.py"), false);
  assert.equal(isOwnProcess("node server.js"), false);
  assert.equal(isOwnProcess(""), false);
});

test("parses lsof LISTEN lines (macOS)", async () => {
  const { parseLsofAddress } = await loadSubject();
  assert.deepEqual(parseLsofAddress("*:8080 (LISTEN)"), { address: "*", port: 8080 });
  assert.deepEqual(parseLsofAddress("127.0.0.1:5173 (LISTEN)"), { address: "127.0.0.1", port: 5173 });
  assert.deepEqual(parseLsofAddress("[::1]:9000 (LISTEN)"), { address: "::1", port: 9000 });
  assert.equal(parseLsofAddress("*:8080 (ESTABLISHED)"), null);
});

test("parses netstat LISTENING lines (Windows)", async () => {
  const { parseNetstatAddress } = await loadSubject();
  assert.deepEqual(parseNetstatAddress("0.0.0.0:8080"), { address: "0.0.0.0", port: 8080 });
  assert.deepEqual(parseNetstatAddress("127.0.0.1:5173"), { address: "127.0.0.1", port: 5173 });
  assert.deepEqual(parseNetstatAddress("[::]:9000"), { address: "::", port: 9000 });
  assert.equal(parseNetstatAddress("garbage"), null);
});

test("strips the basePath before forwarding to services", async () => {
  const { stripBasePath } = await loadSubject();
  assert.equal(stripBasePath("/", "/dev"), "/");
  assert.equal(stripBasePath("/dev", "/dev"), "/");
  assert.equal(stripBasePath("/dev/foo", "/dev"), "/foo");
  assert.equal(stripBasePath("/foo", "/dev"), "/foo");
  assert.equal(stripBasePath("/devfoo", "/dev"), "/devfoo");
  assert.equal(stripBasePath("/dev/foo", ""), "/dev/foo");
});

test("expands wildcard binds into concrete addresses", async () => {
  const { expandListeningAddresses } = await loadSubject();
  const expanded = expandListeningAddresses(["0.0.0.0"]);
  assert.ok(expanded.includes("127.0.0.1"), expanded.join(", "));
  assert.deepEqual(expandListeningAddresses(["127.0.0.1"]), ["127.0.0.1"]);
});

test("IPv6 wildcard :: expands to BOTH families (dual-stack)", async () => {
  const { expandListeningAddresses } = await loadSubject();
  const expanded = expandListeningAddresses(["::"]);
  // dual-stack (v6only=0): :: also accepts IPv4-mapped connections
  assert.ok(expanded.includes("127.0.0.1"), expanded.join(", "));
  assert.ok(expanded.includes("::1"), expanded.join(", "));
});

test("discovers a port opened by our own child process", { timeout: 20_000 }, async () => {
  if (process.platform !== "linux") return; // /proc backend
  const { discoverServicePorts } = await loadSubject();
  const { InternalRegistry } = await loadInternal();
  const internal = new InternalRegistry();

  const port = await pickFreePort();
  const child = spawn(process.execPath, ["-e", HTTP_LISTENER(port)], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  try {
    const ready = await readUntil(child.stdout, /READY/);
    assert.ok(ready, "child should start listening");

    const services = discoverServicePorts(internal);
    const found = [...services.values()].find((s) => s.port === port);
    assert.ok(found, `discovered ${[...services.keys()].join(", ")} but not ${port}`);
    assert.equal(found.pid, child.pid);
    assert.ok(found.addresses.includes("127.0.0.1"));
  } finally {
    child.kill("SIGKILL");
  }
});

test("excludes framework helper processes (SERVICE_TUNNELS_ROLE)", { timeout: 20_000 }, async () => {
  if (process.platform !== "linux") return;
  const { discoverServicePorts } = await loadSubject();
  const { InternalRegistry } = await loadInternal();
  const internal = new InternalRegistry();

  const port = await pickFreePort();
  // Spawned with a role: simulates nginx/authelia/redis owned by the framework.
  const child = spawn(process.execPath, ["-e", HTTP_LISTENER(port)], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, SERVICE_TUNNELS_ROLE: "redis" },
  });

  try {
    const ready = await readUntil(child.stdout, /READY/);
    assert.ok(ready, "helper should start listening");

    const services = discoverServicePorts(internal);
    const found = [...services.values()].find((s) => s.port === port);
    assert.equal(found, undefined, "role-carrying helper must NOT be a discovered service");
  } finally {
    child.kill("SIGKILL");
  }
});

test("excludes ports registered in the internal registry (double safety)", { timeout: 20_000 }, async () => {
  if (process.platform !== "linux") return;
  const { discoverServicePorts } = await loadSubject();
  const { InternalRegistry } = await loadInternal();
  const internal = new InternalRegistry();

  const port = await pickFreePort();
  const child = spawn(process.execPath, ["-e", HTTP_LISTENER(port)], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  try {
    const ready = await readUntil(child.stdout, /READY/);
    assert.ok(ready);

    // Register the port as framework-internal BEFORE discovery.
    internal.register("nginx", { port, pid: child.pid, process: "nginx", cmdline: "nginx", addresses: ["127.0.0.1"] });
    const services = discoverServicePorts(internal);
    const found = [...services.values()].find((s) => s.port === port);
    assert.equal(found, undefined, "internally registered port must be filtered out");

    // And the internal registry still exposes it separately.
    assert.equal(internal.list().some((i) => i.port === port), true);
  } finally {
    child.kill("SIGKILL");
  }
});

test("finds a daemonized grandchild via the env marker", { timeout: 20_000 }, async () => {
  if (process.platform !== "linux") return;
  const { discoverServicePorts } = await loadSubject();
  const { InternalRegistry } = await loadInternal();
  const internal = new InternalRegistry();

  const child = spawn(
    "bash",
    ["-c", `"${process.execPath}" -e '
      const s = require("http").createServer((q, r) => r.end("ok"));
      s.listen(0, "127.0.0.1", () => process.stdout.write("PORT=" + s.address().port + "\\n"));
      setInterval(() => {}, 1000);
    ' &`],
    { stdio: ["ignore", "pipe", "inherit"] },
  );

  let daemonPid = 0;
  try {
    const m = await readUntil(child.stdout, /PORT=(\d+)/);
    assert.ok(m, "daemon should report a port");
    const port = Number(m[1]);

    const services = discoverServicePorts(internal);
    const found = [...services.values()].find((s) => s.port === port);
    assert.ok(found, `discovered ${[...services.keys()].join(", ")} but not ${port}`);
    daemonPid = found.pid;

    const status = readFileSync(`/proc/${daemonPid}/status`, "utf8");
    const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]);
    assert.notEqual(ppid, process.pid, "daemon should have been re-parented");
  } finally {
    child.kill("SIGKILL");
    if (daemonPid) {
      try {
        process.kill(daemonPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
});

test("library instance: createServiceTunnels discovers + internal registry", { timeout: 20_000 }, async () => {
  if (process.platform !== "linux") return;
  const { createServiceTunnels } = await import("../src/index.ts");
  const tmp = mkdtempSync(join(tmpdir(), "st-lib-"));
  const st = createServiceTunnels({ configDir: join(tmp, "config"), cacheDir: join(tmp, "cache") });

  const port = await pickFreePort();
  const child = spawn(process.execPath, ["-e", HTTP_LISTENER(port)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const ready = await readUntil(child.stdout, /READY/);
    assert.ok(ready);
    const found = st.discovery.getPorts().find((p) => p.port === port);
    assert.ok(found, "library discovery should find the child port");
    assert.equal(found.pid, child.pid);

    // internal list separate view
    assert.deepEqual(st.internal.list(), []);
    st.internal.register("redis", { port: 9999, pid: 1, process: "redis", cmdline: "redis", addresses: ["127.0.0.1"] });
    const listed = st.internal.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].port, 9999);
    assert.equal(st.internal.isInternalPort(9999), true);
    assert.equal(st.internal.get("redis")?.pid, 1);
  } finally {
    child.kill("SIGKILL");
  }
});

// ── collectTableTree（Windows 路径）纯表驱动回归 ──────────────────────────────
// Bug 历史（0.3.62 及以前）：
//   1) BFS 把 walk-up 链上的节点（selfAndAncestors）直接剪枝——不入队，导致
//      caller（如 pi-web）的整棵子树（agent 及其启动的测试服务）不可达，
//      服务端口发现恒为空。Linux 版 frontier 全量扩展，无此问题。
//   2) walk-up 遇到已退出祖先（表里查不到的 pid）时 root 停在那个死 pid 上，
//      BFS 从死 pid 出发会把 stale-ppid 孤儿（无关进程）误收进候选。
test("collectTableTree: traverses through the walk-up chain; root never parked on a dead pid", async () => {
  const { collectTableTree } = await loadSubject();

  // 进程表：300（祖先）已退出，不在表里 —— ppid 指向它是悬空引用
  const table = new Map([
    [100, { ppid: 200, name: "node.exe", cmdline: "node pi-web.js" }], // caller (rootPid)
    [200, { ppid: 300, name: "node.exe", cmdline: 'node "next/dist/bin/next" dev -p 30143' }], // own via excludeCmdline
    [101, { ppid: 100, name: "node.exe", cmdline: "node agent-session.js" }], // caller 的子（agent）
    [9001, { ppid: 101, name: "node.exe", cmdline: "node test-server.js" }], // agent 启动的服务 ← 必须可达
  ]);
  const t = collectTableTree(table, {
    rootPid: 100,
    excludeCmdline: [/next[\/]dist[\/]bin[\/]next/],
  });

  // root = 200：最高的存活 own 进程（300 已死不能作 root）
  assert.equal(t.root, 200);
  // walk-up 链完整记录
  assert.ok(t.selfAndAncestors.has(100) && t.selfAndAncestors.has(200));
  // 链上节点不被计入候选……
  assert.equal(t.descendants.has(100), false);
  assert.equal(t.descendants.has(200), false);
  // ……但必须被穿越：caller 子树全部可达
  assert.ok(t.descendants.has(101), "agent child must be reachable through the chain");
  assert.ok(t.descendants.has(9001), "spawned server must be reachable through the chain");
});

test("collectTableTree: orphans under a dead ancestor are not pulled in", async () => {
  const { collectTableTree } = await loadSubject();

  // 300 已死；5555 是 ppid 悬挂在 300 上的孤儿（与 caller 无关）
  const table = new Map([
    [100, { ppid: 200, name: "node.exe", cmdline: "node pi-web.js" }],
    [200, { ppid: 300, name: "node.exe", cmdline: "node next/dist/bin/next dev" }],
    [5555, { ppid: 300, name: "OneDrive.exe", cmdline: "OneDrive.exe /background" }],
  ]);
  const t = collectTableTree(table, { rootPid: 100, excludeCmdline: [/next[\/]dist[\/]bin[\/]next/] });

  assert.equal(t.root, 200);
  assert.equal(t.descendants.has(5555), false, "orphan of a dead ancestor must not become a candidate");
});
