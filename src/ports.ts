/**
 * 本机监听端口识别（daemon IPC `port.list`）。
 *
 * 三平台分派（与 discovery.ts 的主链路同配方，但本模块**零依赖**——它是
 * UI/daemon 的兜底数据源，不得因 import 触发 marker 等库初始化副作用）：
 *   - linux：/proc/net/tcp[6] LISTEN 套接字 + socket inode 反查 /proc/<pid>/fd
 *   - win32：netstat -ano（端口→pid）+ 一次 Get-CimInstance Win32_Process 全表
 *            （进程名/cmdline/PPid 链/SessionId）
 *   - darwin：lsof -nP -iTCP -sTCP:LISTEN + ps -axo pid,uid,command
 *
 * 结果带 5s TTL 缓存（port.list 是 10s 轮询面板的数据源；Windows 的
 * powershell 全表实测 ~0.9s，不缓存即把探测成本放大到每次轮询）。
 *
 * scope:
 *   - "current-user"（默认）：Linux/macOS 按 uid；Windows 无廉价 per-pid owner
 *     查询（GetOwner 逐进程），改按**会话号**——与查询进程同 SessionId 即当前
 *     登录用户的进程（session 0 的系统服务自然排除）。daemon 若跑在 session 0
 *     服务态，此过滤会偏到服务会话，届时应改用 pid:<n> scope。
 *   - "pid:<n>"：指定 pid 及其全部子孙进程（进程树，如宿主应用整棵树）
 */

import { readdirSync, readlinkSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";

export interface PortInfo {
  port: number;
  pid: number;
  process: string;
  protocol: "tcp" | "tcp6";
}

interface SockEntry {
  port: number;
  inode: string;
  protocol: "tcp" | "tcp6";
}

/** pid → 进程信息（Windows/macOS 进程表条目）。 */
export interface ProcRow {
  ppid: number;
  name: string;
  cmdline: string;
  /** Windows 会话号（macOS/Linux 表无此列 → undefined）。 */
  session?: number;
  /** Unix uid（Windows 表无此列 → undefined）。 */
  uid?: number;
}

const TTL_MS = 5_000;
/** powershell 全表 / netstat / lsof 均可能秒级，上限给足（异步不阻塞事件循环）。 */
const EXEC_TIMEOUT_MS = 15_000;

/** 异步执行外部命令并返回 stdout；失败一律空串（探测不抛，宁可少条目）。 */
function execOut(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: EXEC_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => resolve(err ? "" : stdout || ""),
    );
  });
}

// ── 解析器（纯函数，fixture 可测） ──────────────────────────────────────────

/** 解析 `netstat -ano` 输出里的 TCP LISTENING 行 → 端口/pid/协议族。 */
export function parseNetstatListening(out: string): SockEntry[] {
  const rows: SockEntry[] = [];
  for (const line of out.split("\n")) {
    // 状态列在各语言 Windows 均保持 ASCII "LISTENING"（155 zh-CN 实测）
    if (!/LISTENING/.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    if (!/^tcp$/i.test(parts[0]!)) continue;
    const port = localPortOf(parts[1]!);
    if (!port) continue;
    const pid = Number(parts[parts.length - 1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    rows.push({ port: port.port, inode: String(pid), protocol: port.protocol });
  }
  return rows;
}

/** 解析 local address（`0.0.0.0:22` / `[::]:445` / `[::ffff:0:0]:80`）→ 端口 + 协议族。 */
function localPortOf(addr: string): { port: number; protocol: "tcp" | "tcp6" } | null {
  const idx = addr.lastIndexOf(":");
  if (idx < 0) return null;
  const host = addr.slice(0, idx);
  const port = Number(addr.slice(idx + 1));
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  // 方括号即 IPv6（含 IPv4-mapped 形态）
  return { port, protocol: host.startsWith("[") ? "tcp6" : "tcp" };
}

/**
 * 解析 Get-CimInstance Win32_Process 的 TSV 全表。
 * 行格式 `pid \t ppid \t name \t sessionId \t cmdline`（cmdline 放末列：
 * 其内 tab 不再影响前面字段）；`#SID=<n>` 行是脚本自身的当前会话号。
 */
export function parseCimTable(out: string): { currentSid: number | null; table: Map<number, ProcRow> } {
  const table = new Map<number, ProcRow>();
  let currentSid: number | null = null;
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    const sidLine = /^#SID=(\d+)$/.exec(line);
    if (sidLine) {
      currentSid = Number(sidLine[1]);
      continue;
    }
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const pid = Number(parts[0]!.trim());
    const ppid = Number(parts[1]!.trim());
    if (!Number.isFinite(pid) || pid <= 0) continue;
    table.set(pid, {
      ppid: Number.isFinite(ppid) ? ppid : 0,
      name: (parts[2] ?? "").trim(),
      session: parts.length >= 4 ? Number(parts[3]!.trim()) || 0 : undefined,
      cmdline: (parts.slice(4).join("\t") ?? "").trim(),
    });
  }
  return { currentSid, table };
}

/** 解析 `ps -axo pid=,uid=,command=` → pid → 行。 */
export function parsePsTable(out: string): Map<number, ProcRow> {
  const table = new Map<number, ProcRow>();
  for (const raw of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(raw);
    if (!m) continue;
    const cmdline = (m[3] ?? "").trim();
    table.set(Number(m[1]), {
      ppid: 0, // 该表不含 PPid；进程树另用 pid,ppid 表
      uid: Number(m[2]),
      name: cmdline.split(/\s+/)[0] ?? "",
      cmdline,
    });
  }
  return table;
}

/** 解析 `ps -axo pid=,ppid=` → pid → ppid（macOS 进程树）。 */
export function parsePpidTable(out: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const raw of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(raw);
    if (m) map.set(Number(m[1]), Number(m[2]));
  }
  return map;
}

/** 解析 `lsof -nP -iTCP -sTCP:LISTEN` → 端口/pid（inode 位复用存 pid）。 */
export function parseLsofListening(out: string): SockEntry[] {
  const rows: SockEntry[] = [];
  for (const line of out.split("\n").slice(1)) {
    // NAME 列 = 本地地址（LISTEN 无远端配对）；末列锚定，避免把 ESTABLISHED
    // 的 `a:52000->b:6379` 远端口误当本端口（lsof 各列以空白分隔，宽度不稳）
    const name = /\s(\S+:\d+)(?:->\S+)?\s+\(LISTEN\)\s*$/.exec(line);
    const pid = /^\s*\S+\s+(\d+)\s/.exec(line);
    if (!name || !pid) continue;
    const port = Number(pid[1]);
    if (!Number.isFinite(port) || port <= 0) continue;
    const local = localPortOf(name[1]!);
    if (!local) continue;
    rows.push({ port: local.port, inode: pid[1]!, protocol: local.protocol });
  }
  return rows;
}

/** pid 是否等于 root 或其祖先链上的后代（PPid 链向上走，含死 ppid 断链即止）。 */
export function isInPidTree(pid: number, root: number, ppidOf: (pid: number) => number | undefined): boolean {
  if (!root || pid === root) return true;
  let cur = pid;
  for (let depth = 0; depth < 64; depth++) {
    const ppid = ppidOf(cur);
    if (ppid === undefined) return false; // 进程已消失：宁可漏也不误命中
    if (ppid === root) return true;
    if (ppid <= 1 || ppid === cur) return false;
    cur = ppid;
  }
  return false;
}

/**
 * 框架/内部进程判定：这些端口不该出现在"可暴露目标"下拉里——
 *  - service-tunnels 自身的 nginx 网关、daemon/UI、SSH 网关
 *  - 浏览器/远程桌面等系统工具
 */
function isFrameworkProcess(cmd: string): boolean {
  const c = cmd.toLowerCase();
  return (
    /nginx/.test(c) ||
    /daemon-server|service-tunnels|src\/ssh|cli\.ts/.test(c) ||
    /chrome|chromium|gnome-remote|microsoft-edge/.test(c) ||
    /relay\.cjs|gobare|bore server/.test(c) ||
    // authelia 端口探测脚本（s.accept 等待）等临时探针
    /python3 -c|s\.accept\(\).*time\.sleep/.test(c) ||
    // Windows：SVCHOST 宿主端口是系统服务，永不作为暴露目标
    /(^|[/\\])svchost(\.exe)?\b/.test(c) ||
    // pid 4「System」/注册表等内核态宿主（SMB 445、RPC 135）——无 cmdline，只有进程名
    /^\s*(system|registry|memory compression)(\s|$)/.test(c)
  );
}

// ── Linux：/proc（原实现） ──────────────────────────────────────────────────

/** 解析 /proc/net/tcp|tcp6，返回 LISTEN 项。 */
function parseProcNet(path: string, protocol: "tcp" | "tcp6"): SockEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: SockEntry[] = [];
  const lines = raw.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i]!.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const local = parts[1]!; // hex ip:hex port
    const st = parts[3]!; // 0A = LISTEN
    const inode = parts[9]!;
    if (st !== "0A") continue;
    const portHex = local.split(":")[1];
    if (!portHex) continue;
    const port = parseInt(portHex, 16);
    if (!port || port > 65535) continue;
    out.push({ port, inode, protocol });
  }
  return out;
}

/** 扫描 /proc/<pid>/fd 的 socket:[inode] symlink → inode->pid 映射。 */
function socketOwners(): Map<string, { pid: number; process: string }> {
  const owners = new Map<string, { pid: number; process: string }>();
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return owners;
  }
  for (const pidStr of pids) {
    const fdDir = `/proc/${pidStr}/fd`;
    let fds: string[];
    try {
      fds = readdirSync(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(`${fdDir}/${fd}`);
        const m = /^socket:\[(\d+)\]$/.exec(target);
        if (!m) continue;
        if (owners.has(m[1]!)) continue;
        let cmdline = "";
        try {
          cmdline = readFileSync(`/proc/${pidStr}/cmdline`, "utf8").replace(/\0/g, " ").trim();
        } catch {
          /* process exited between scans */
        }
        owners.set(m[1]!, { pid: Number(pidStr), process: cmdline.slice(0, 80) || `pid ${pidStr}` });
      } catch {
        // fd 可能在扫描间隙消失
      }
    }
  }
  return owners;
}

function linuxPpidOf(pid: number): number | undefined {
  try {
    const st = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /^PPid:\s+(\d+)/m.exec(st);
    return m?.[1] ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

function listLinuxPorts(scope: string): PortInfo[] {
  const entries = [
    ...parseProcNet("/proc/net/tcp", "tcp"),
    ...parseProcNet("/proc/net/tcp6", "tcp6"),
  ];
  const owners = socketOwners();
  const seen = new Set<string>();
  const out: PortInfo[] = [];
  for (const e of entries) {
    const owner = owners.get(e.inode);
    if (!owner) continue;
    if (!matchLinuxScope(owner.pid, scope)) continue;
    if (isFrameworkProcess(owner.process)) continue;
    const key = `${e.port}-${e.protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port: e.port, pid: owner.pid, process: owner.process, protocol: e.protocol });
  }
  out.sort((a, b) => a.port - b.port);
  return out;
}

function matchLinuxScope(pid: number, scope: string): boolean {
  if (scope === "current-user") {
    let uidLine: string;
    try {
      uidLine = readFileSync(`/proc/${pid}/status`, "utf8");
    } catch {
      return false;
    }
    const m = /^Uid:\s+(\d+)/m.exec(uidLine);
    const uidStr = m?.[1];
    if (!uidStr) return false;
    return Number(uidStr) === (process.getuid?.() ?? -1);
  }
  if (scope.startsWith("pid:")) {
    return isInPidTree(pid, Number(scope.slice(4)), linuxPpidOf);
  }
  return true;
}

// ── Windows / macOS ─────────────────────────────────────────────────────────

/**
 * 端口行 + 进程表 → 去重排序的 PortInfo（win/mac 共用；纯函数，fixture 可测）。
 * 过滤顺序：进程表命中 → scope → 框架进程 → (port,protocol) 去重。
 */
export function buildPorts(
  rows: SockEntry[],
  table: Map<number, ProcRow>,
  opts: {
    scope: string;
    /** scope=current-user（Windows）：与查询进程同会话。 */
    currentSid?: number | null;
    /** scope=current-user（macOS）：同 uid。 */
    myUid?: number;
    /** scope=pid:<n>：PPid 链来源。 */
    ppidOf?: (pid: number) => number | undefined;
  },
): PortInfo[] {
  const rootPid = opts.scope.startsWith("pid:") ? Number(opts.scope.slice(4)) : 0;
  const seen = new Set<string>();
  const out: PortInfo[] = [];
  for (const e of rows) {
    const pid = Number(e.inode); // inode 槽位存 pid
    const row = table.get(pid);
    if (!row) continue;
    if (opts.scope === "current-user") {
      if (opts.myUid !== undefined) {
        if (row.uid !== opts.myUid) continue;
      } else if (opts.currentSid === null || opts.currentSid === undefined || row.session !== opts.currentSid) {
        continue;
      }
    } else if (rootPid) {
      if (!isInPidTree(pid, rootPid, opts.ppidOf ?? (() => undefined))) continue;
    }
    if (isFrameworkProcess(`${row.name} ${row.cmdline}`)) continue;
    const key = `${e.port}-${e.protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = (row.cmdline || row.name || "").slice(0, 80);
    out.push({ port: e.port, pid, process: label || `pid ${pid}`, protocol: e.protocol });
  }
  out.sort((a, b) => a.port - b.port);
  return out;
}

const CIM_CMD =
  'Write-Output "#SID=$([Diagnostics.Process]::GetCurrentProcess().SessionId)"; ' +
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.SessionId)`t$($_.CommandLine)" }';

async function listWindowsPorts(scope: string): Promise<PortInfo[]> {
  const [netstatOut, cimOut] = await Promise.all([
    execOut("netstat", ["-ano"]),
    execOut("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", CIM_CMD]),
  ]);
  const { currentSid, table } = parseCimTable(cimOut);
  return buildPorts(parseNetstatListening(netstatOut), table, {
    scope,
    currentSid,
    ppidOf: (pid) => table.get(pid)?.ppid,
  });
}

async function listDarwinPorts(scope: string): Promise<PortInfo[]> {
  const needTree = scope.startsWith("pid:");
  const [lsofOut, psOut, ppidOut] = await Promise.all([
    execOut("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]),
    execOut("ps", ["-axo", "pid=,uid=,command="]),
    needTree ? execOut("ps", ["-axo", "pid=,ppid="]) : Promise.resolve(""),
  ]);
  const ppidOf = parsePpidTable(ppidOut);
  return buildPorts(parseLsofListening(lsofOut), parsePsTable(psOut), {
    scope,
    myUid: process.getuid?.() ?? -1,
    ppidOf: (pid) => ppidOf.get(pid),
  });
}

// ── 入口（TTL 缓存 + 并发合流） ─────────────────────────────────────────────

declare global {
  var __serviceTunnelsPortListCache: Record<string, { expiresAt: number; ports: PortInfo[] }> | undefined;
}

/** 同 scope 的并发请求合流到一次探测（powershell 全表 ~1s，重复发起纯浪费）。 */
const inflight = new Map<string, Promise<PortInfo[]>>();

/** 当前用户（或指定进程树）的监听 TCP 端口；结果缓存 5s，`force` 绕过。 */
export function listListeningPorts(scope = "current-user", force = false): Promise<PortInfo[]> {
  const cache = (globalThis.__serviceTunnelsPortListCache ??= {});
  const now = Date.now();
  if (!force) {
    const hit = cache[scope];
    if (hit && hit.expiresAt > now) return Promise.resolve(hit.ports);
    const pending = inflight.get(scope);
    if (pending) return pending;
  }
  const p = (async () => {
    let ports: PortInfo[];
    if (process.platform === "linux") ports = listLinuxPorts(scope);
    else if (process.platform === "darwin") ports = await listDarwinPorts(scope);
    else ports = await listWindowsPorts(scope);
    cache[scope] = { expiresAt: Date.now() + TTL_MS, ports };
    return ports;
  })().finally(() => inflight.delete(scope));
  if (!force) inflight.set(scope, p);
  return p;
}
