/**
 * ports.ts（daemon `port.list` 数据源）跨平台解析与过滤——fixture 驱动，
 * 不依赖真机进程表（真机冒烟只在最后一条：断言返回数组且缓存生效）。
 */
import assert from "node:assert/strict";
import test from "node:test";

const mod = await import("../src/ports.ts");
const {
  parseNetstatListening,
  parseCimTable,
  parsePsTable,
  parsePpidTable,
  parseLsofListening,
  isInPidTree,
  buildPorts,
  listListeningPorts,
} = mod;

// ── netstat -ano（Windows） ─────────────────────────────────────────────────

const NETSTAT = [
  "  Protocol  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:22             0.0.0.0:0              LISTENING       5836",
  "  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4",
  "  TCP    [::]:8080              [::]:0                 LISTENING       12345",
  "  TCP    [::ffff:0.0.0.0]:30142              [::]:0                 LISTENING       999",
  "  TCP    192.168.122.10:52100     1.2.3.4:443            ESTABLISHED     12345",
  "  TCP    127.0.0.1:52999        127.0.0.1:53000        TIME_WAIT       0",
  "  UDP    0.0.0.0:5353           *:*                                    2216",
  "",
].join("\n");

test("parseNetstatListening：只取 TCP LISTENING，IPv6 按方括号分族", () => {
  assert.deepEqual(parseNetstatListening(NETSTAT), [
    { port: 22, inode: "5836", protocol: "tcp" },
    { port: 445, inode: "4", protocol: "tcp" },
    { port: 8080, inode: "12345", protocol: "tcp6" },
    { port: 30142, inode: "999", protocol: "tcp6" },
  ]);
});

test("parseNetstatListening：垃圾行/无 pid/端口越界一律丢弃", () => {
  const rows = parseNetstatListening(
    [
      "  TCP    0.0.0.0:0              0.0.0.0:0              LISTENING       4",
      "  TCP    badaddress             0.0.0.0:0              LISTENING       4",
      "  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       notanumber",
      "  LISTENING",
    ].join("\n"),
  );
  assert.deepEqual(rows, []);
});

// ── Get-CimInstance Win32_Process（Windows） ────────────────────────────────

const CIM = [
  "#SID=1",
  "4\t0\tSystem\t0\t",
  "999\t4\tsvchost.exe\t0\tC:\\Windows\\system32\\svchost.exe -k NetSvc",
  "12345\t999\tnode.exe\t1\tnode C:\\srv\\app.js",
  "777\t1\tpowershell.exe\t1\t",
  "888\t1\tcmd.exe\t2\trun\tchild.exe", // cmdline 内 tab：末列吞并
  "junk line without tabs",
  "",
].join("\r\n"); // CRLF 输出

test("parseCimTable：#SID 头 + TSV 行，cmdline 内 tab 归末列", () => {
  const { currentSid, table } = parseCimTable(CIM);
  assert.equal(currentSid, 1);
  assert.equal(table.get(4)?.ppid, 0);
  assert.equal(table.get(4)?.name, "System");
  assert.equal(table.get(4)?.session, 0);
  assert.equal(table.get(4)?.cmdline, "");
  assert.equal(table.get(12345)?.cmdline, "node C:\\srv\\app.js");
  assert.equal(table.get(12345)?.session, 1);
  assert.equal(table.get(888)?.cmdline, "run\tchild.exe");
  assert.equal(table.has(777), true);
  assert.equal([...table].length, 5); // 垃圾行不进表
});

// ── ps / lsof（macOS） ──────────────────────────────────────────────────────

const PS = [
  "  1     0 /sbin/launchd",
  " 501   501 /Applications/MyApp.app/Contents/MacOS/MyApp",
  " 700     0 /usr/sbin/httpd -D FOREGROUND",
].join("\n");

test("parsePsTable / parsePpidTable：pid+uid+command 与 pid+ppid", () => {
  const t = parsePsTable(PS);
  assert.equal(t.get(501)?.uid, 501);
  assert.equal(t.get(501)?.cmdline, "/Applications/MyApp.app/Contents/MacOS/MyApp");
  assert.equal(t.get(501)?.name, "/Applications/MyApp.app/Contents/MacOS/MyApp");
  assert.equal(t.get(700)?.uid, 0);
  const pp = parsePpidTable("  501 1\n  600 501\n");
  assert.equal(pp.get(600), 501);
  assert.equal(pp.get(501), 1);
});

const LSOF = [
  "COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
  "node    12345 wind   18u  IPv4 0x1234                0t0  TCP *:30142 (LISTEN)",
  "node    12345 wind   19u  IPv6 0x5678                0t0  TCP [::1]:8080 (LISTEN)",
  "Python   7777 wind    3u  IPv4 0x9abc                0t0  TCP 127.0.0.1:9820 (LISTEN)",
  "node    12345 wind   22u  IPv4 0xdef0      0t0  TCP 127.0.0.1:52000->127.0.0.1:6379 (ESTABLISHED)",
].join("\n");

test("parseLsofListening：只取 LISTEN，pid 存 inode 槽", () => {
  assert.deepEqual(parseLsofListening(LSOF), [
    { port: 30142, inode: "12345", protocol: "tcp" },
    { port: 8080, inode: "12345", protocol: "tcp6" },
    { port: 9820, inode: "7777", protocol: "tcp" },
  ]);
});

// ── 进程树 scope ────────────────────────────────────────────────────────────

test("isInPidTree：自身/后代/断链（进程已消失）/根在顶端", () => {
  const chain = new Map([[10, 1], [20, 10], [30, 20], [40, 30]]);
  const ppidOf = (p) => chain.get(p);
  assert.equal(isInPidTree(10, 10, ppidOf), true);
  assert.equal(isInPidTree(40, 10, ppidOf), true);
  assert.equal(isInPidTree(40, 20, ppidOf), true);
  assert.equal(isInPidTree(40, 99, ppidOf), false);
  assert.equal(isInPidTree(999, 10, ppidOf), false); // 表里没有 → 已消失，宁可漏
  assert.equal(isInPidTree(20, 1, ppidOf), true); // 挂到 init 的整棵树都是后代
  const loop = new Map([[5, 6], [6, 5]]);
  assert.equal(isInPidTree(5, 99, (p) => loop.get(p)), false); // 环不死循环
});

// ── buildPorts：scope + 框架过滤 + 去重排序 ─────────────────────────────────

const { currentSid: SID, table: WIN_TABLE } = parseCimTable(CIM);

test("buildPorts(win)：current-user 按会话过滤，pid: 按 PPid 链，System/svchost 剔除", () => {
  const rows = parseNetstatListening(NETSTAT);
  const mine = buildPorts(rows, WIN_TABLE, { scope: "current-user", currentSid: SID });
  // 22→5836 表里没有；445→pid4 session0；8080→12345 session1；30142→999 svchost
  assert.deepEqual(mine, [{ port: 8080, pid: 12345, process: "node C:\\srv\\app.js", protocol: "tcp6" }]);

  const tree = buildPorts(rows, WIN_TABLE, {
    scope: "pid:999",
    ppidOf: (p) => WIN_TABLE.get(p)?.ppid,
  });
  // 树 = {999, 12345}；999 自身被 svchost 名单挡掉，只剩后代 node 的 8080；
  // 445（pid 4，不属该树）与 30142（svchost）都不出现
  assert.deepEqual(tree, [{ port: 8080, pid: 12345, process: "node C:\\srv\\app.js", protocol: "tcp6" }]);

  const noSid = buildPorts(rows, WIN_TABLE, { scope: "current-user", currentSid: null });
  assert.deepEqual(noSid, []); // 拿不到会话号 → 宁缺不滥
});

test("buildPorts(mac)：uid 过滤 + 同端口 tcp/tcp6 并存不吞", () => {
  const table = parsePsTable(" 12345 501 node /srv/app.js\n 700 0 /usr/sbin/httpd\n 60 501 nginx: master\n");
  const rows = [
    { port: 3000, inode: "12345", protocol: "tcp" },
    { port: 3000, inode: "12345", protocol: "tcp6" },
    { port: 80, inode: "700", protocol: "tcp" },
    { port: 8080, inode: "60", protocol: "tcp" },
    { port: 9, inode: "404", protocol: "tcp" },
  ];
  assert.deepEqual(buildPorts(rows, table, { scope: "current-user", myUid: 501 }), [
    { port: 3000, pid: 12345, process: "node /srv/app.js", protocol: "tcp" },
    { port: 3000, pid: 12345, process: "node /srv/app.js", protocol: "tcp6" },
  ]); // 80 属 uid 0；8080 是 nginx 框架口；9 无进程行
});

// ── 真机冒烟（不假设具体端口，只验链路与缓存） ──────────────────────────────

test("listListeningPorts：返回数组，5s 内命中缓存（同引用）", async () => {
  const a = await listListeningPorts("current-user");
  assert.ok(Array.isArray(a));
  assert.ok(a.every((p) => Number.isFinite(p.port) && p.port > 0 && typeof p.process === "string"));
  const b = await listListeningPorts("current-user");
  assert.equal(a, b); // 缓存生效（否则每次轮询重跑 powershell ~1s）
  const c = await listListeningPorts("current-user", true);
  assert.notEqual(a, c); // force 绕缓存
});
