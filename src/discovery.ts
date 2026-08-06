import { readFileSync, readdirSync, readlinkSync } from "fs";
import { execFileSync } from "child_process";
import { networkInterfaces } from "os";
import { ensureMarker, ROLE_ENV } from "./marker.ts";
import type { InternalRegistry } from "./internal.ts";

/**
 * Service-port discovery + auto allow-list (originated in the author's host
 * application, extracted & generalized for service-tunnels).
 *
 * "Allow-list" is not configured by hand: it is the cache of listening TCP
 * ports on processes spawned by the caller (library owner) — or, in CLI
 * mode, processes under the caller's session tree. Ports not in that set are
 * never proxied, so a remote attacker cannot pivot to unrelated local
 * services (Redis, MySQL, ...).
 *
 * A process counts as "ours" when it is:
 *   1. a descendant of the caller's process tree (shell → test server → ...),
 *      or
 *   2. carrying the SERVICE_TUNNELS_MARKER env value (Linux /proc environ) —
 *      survives re-parenting by daemonization.
 *
 * EXCLUDED from results:
 *   - the framework's own process chain (service-tunnels CLI/daemon),
 *   - framework helper processes carrying SERVICE_TUNNELS_ROLE (nginx /
 *     authelia / redis / tunnels) — those live in the internal registry,
 *   - ports registered in the internal registry (double safety),
 *   - caller-provided cmdline exclusions (e.g. host matching its own).
 */

export interface ServicePortInfo {
  port: number;
  pid: number;
  process: string;
  cmdline: string;
  /** Every concrete address the port is listening on (wildcards expanded). */
  addresses: string[];
  /** Username of the process owner (filled when requested). */
  username?: string;
  /** UID of the process owner (Linux/macOS only). */
  uid?: number;
}

export interface DiscoveryOptions {
  /** Alternate root to collect the process tree from (CLI: caller pid). */
  rootPid?: number;
  /** Regex(es) identifying the caller's own processes (never "services"). */
  excludeCmdline?: RegExp | RegExp[];
  /** Force a fresh scan (bypass the TTL cache). */
  force?: boolean;
}

const DISCOVERY_TTL_MS = 5_000;

/** The marker inherited by every process the caller spawns. */
const CHILD_MARKER = ensureMarker();

/** Command lines that identify service-tunnels' own processes. */
export function isOwnProcess(cmdline: string): boolean {
  if (!cmdline) return false;
  return (
    /service-tunnels/.test(cmdline) ||
    /(^|[/\\])(service-tunnels|st)(\.mjs|\.js)?([\s"']|$)/.test(cmdline) ||
    /daemon-server\.ts/.test(cmdline)
  );
}

// ── /proc helpers (Linux) ────────────────────────────────────────────────────

function readCommandLine(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}

function readComm(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return "?";
  }
}

/** Children of the given pids, from /proc/<pid>/task/<tid>/children. */
function readProcChildren(pids: Iterable<number>): Set<number> {
  const out = new Set<number>();
  for (const pid of pids) {
    let tasks: string[];
    try {
      tasks = readdirSync(`/proc/${pid}/task`);
    } catch {
      continue; // process vanished
    }
    for (const tid of tasks) {
      try {
        const raw = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8");
        for (const c of raw.trim().split(/\s+/)) {
          if (c) out.add(Number(c));
        }
      } catch {
        // tid vanished between readdir and read
      }
    }
  }
  return out;
}

// ── Cross-platform process table (macOS / Windows) ───────────────────────────

interface ProcEntry {
  ppid: number;
  name: string;
  cmdline: string;
}

function parsePsTable(out: string): Map<number, ProcEntry> {
  const map = new Map<number, ProcEntry>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) {
      map.set(Number(m[1]), {
        ppid: Number(m[2]),
        name: "",
        cmdline: m[3] ?? "",
      });
    }
  }
  return map;
}

function parsePowerShellTable(out: string): Map<number, ProcEntry> {
  const map = new Map<number, ProcEntry>();
  for (const line of out.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const pid = Number(parts[0]!.trim());
    const ppid = Number(parts[1]!.trim());
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    map.set(pid, {
      ppid,
      name: (parts[2] ?? "").trim(),
      cmdline: (parts[3] ?? "").trim(),
    });
  }
  return map;
}

/** pid → { ppid, name, cmdline } for every process (macOS/Windows only). */
function readProcessTable(): Map<number, ProcEntry> {
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      return parsePsTable(out);
    } catch {
      return new Map();
    }
  }
  if (process.platform === "win32") {
    try {
      const cmd =
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)" }';
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", cmd],
        { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      );
      return parsePowerShellTable(out);
    } catch {
      return new Map();
    }
  }
  return new Map();
}

// ── Process tree ─────────────────────────────────────────────────────────────

interface ProcTree {
  /** PIDs below the caller root (test servers, workers). */
  descendants: Set<number>;
  /** The caller's own process chain. */
  selfAndAncestors: Set<number>;
}

function collectLinuxTree(opts: DiscoveryOptions): ProcTree {
  const selfAndAncestors = new Set<number>();
  const isOwn = (cmdline: string) =>
    isOwnProcess(cmdline) || matchesAny(cmdline, opts.excludeCmdline);

  let pid = opts.rootPid ?? process.pid;
  while (pid > 1) {
    selfAndAncestors.add(pid);
    if (!isOwn(readCommandLine(pid))) break;
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const m = /^PPid:\s+(\d+)/m.exec(status);
      const ppid = m ? Number(m[1]) : 0;
      if (!ppid || ppid === pid || ppid === 1) break;
      pid = ppid;
    } catch {
      break;
    }
  }
  const root = pid;

  const descendants = new Set<number>();
  let frontier = new Set<number>([root]);
  while (frontier.size > 0) {
    frontier = readProcChildren(frontier);
    for (const p of frontier) {
      if (p !== root && !selfAndAncestors.has(p)) descendants.add(p);
    }
  }
  return { descendants, selfAndAncestors };
}

function collectTableTree(table: Map<number, ProcEntry>, opts: DiscoveryOptions): ProcTree {
  const selfAndAncestors = new Set<number>();
  const isOwn = (s: string) => isOwnProcess(s) || matchesAny(s, opts.excludeCmdline);

  let pid = opts.rootPid ?? process.pid;
  for (;;) {
    selfAndAncestors.add(pid);
    const entry = table.get(pid);
    const isOwnProc = pid === (opts.rootPid ?? process.pid) || isOwn(entry?.cmdline ?? "") || isOwn(entry?.name ?? "");
    const ppid = entry?.ppid ?? 0;
    if (!isOwnProc || !ppid || ppid === pid || ppid === 1) break;
    pid = ppid;
  }
  const root = pid;

  const childrenMap = new Map<number, number[]>();
  for (const [child, entry] of table) {
    const arr = childrenMap.get(entry.ppid) ?? [];
    arr.push(child);
    childrenMap.set(entry.ppid, arr);
  }

  const descendants = new Set<number>();
  const queue = [root];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const child of childrenMap.get(cur) ?? []) {
      if (child === root || selfAndAncestors.has(child) || descendants.has(child)) continue;
      descendants.add(child);
      queue.push(child);
    }
  }
  return { descendants, selfAndAncestors };
}

/**
 * Walk up from the current process (or rootPid) to the topmost caller-owned
 * process, then collect every descendant below it. Scoped to the caller even
 * when launched from a user shell or IDE.
 */
function collectProcTree(opts: DiscoveryOptions): ProcTree {
  if (process.platform === "linux") return collectLinuxTree(opts);
  return collectTableTree(readProcessTable(), opts);
}

// ── Socket table parsing (Linux /proc) ───────────────────────────────────────

interface ListenSocket {
  port: number;
  address: string;
}

export function decodeIpv4(hex: string): string {
  const bytes = hex.match(/../g) ?? [];
  return bytes.map((b) => parseInt(b, 16)).reverse().join(".");
}

function formatIpv6(words: number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < words.length; ) {
    if (words[i] === 0) {
      let j = i;
      while (j < words.length && words[j] === 0) j++;
      if (j - i > bestLen) {
        bestStart = i;
        bestLen = j - i;
      }
      i = j;
    } else {
      i++;
    }
  }
  const hex = words.map((w) => w.toString(16));
  if (bestLen >= 2) {
    const head = hex.slice(0, bestStart).join(":");
    const tail = hex.slice(bestStart + bestLen).join(":");
    return `${head}::${tail}`;
  }
  return hex.join(":");
}

export function decodeIpv6(hex: string): string {
  const words: number[] = [];
  for (let i = 0; i < 32; i += 8) {
    const n = parseInt(hex.slice(i, i + 8), 16);
    const b0 = (n >> 24) & 0xff;
    const b1 = (n >> 16) & 0xff;
    const b2 = (n >> 8) & 0xff;
    const b3 = n & 0xff;
    words.push((b3 << 8) | b2, (b1 << 8) | b0);
  }
  return formatIpv6(words);
}

/** socket inode → (port, address) for every LISTEN socket in this netns. */
function parseNetListenTables(): Map<number, ListenSocket> {
  const inodeToSocket = new Map<number, ListenSocket>();
  const tables: Array<[string, boolean]> = [
    ["/proc/net/tcp", false],
    ["/proc/net/tcp6", true],
  ];
  for (const [file, ipv6] of tables) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      if (parts[3] !== "0A") continue; // only LISTEN
      const local = parts[1]!;
      const idx = local.indexOf(":");
      if (idx <= 0) continue;
      const addrHex = local.slice(0, idx);
      const port = parseInt(local.slice(idx + 1), 16);
      if (!Number.isFinite(port) || port <= 0) continue;
      const inode = Number(parts[9]!);
      if (!Number.isFinite(inode)) continue;
      inodeToSocket.set(inode, {
        port,
        address: ipv6 ? decodeIpv6(addrHex) : decodeIpv4(addrHex),
      });
    }
  }
  return inodeToSocket;
}

/** Listening sockets held by a pid (via /proc/<pid>/fd socket inodes). */
function pidsListeningSockets(pid: number, inodeToSocket: Map<number, ListenSocket>): ListenSocket[] {
  let fds: string[];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return [];
  }
  const out: ListenSocket[] = [];
  for (const fd of fds) {
    let link: string;
    try {
      link = readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    const m = /^socket:\[(\d+)\]$/.exec(link);
    if (!m) continue;
    const sock = inodeToSocket.get(Number(m[1]));
    if (sock) out.push(sock);
  }
  return out;
}

// ── Platform discovery backends ──────────────────────────────────────────────

/** All numeric /proc entries (process ids). */
function listAllPids(): number[] {
  try {
    return readdirSync("/proc")
      .filter((n) => /^\d+$/.test(n))
      .map(Number);
  } catch {
    return [];
  }
}

/** True when the process carries our env marker (spawned by us). */
function processHasChildMarker(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/environ`).includes(CHILD_MARKER);
  } catch {
    return false;
  }
}

/** True when the process is a framework helper (nginx/authelia/redis/tunnel). */
function processHasRole(pid: number): boolean {
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8");
    return env.includes(`${ROLE_ENV}=`);
  } catch {
    return false;
  }
}

/** Non-internal interface addresses on this machine. */
function lanAddresses(): { ipv4: string[]; ipv6: string[] } {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  try {
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const iface of ifaces ?? []) {
        if (iface.internal) continue;
        if (iface.family === "IPv4") ipv4.push(iface.address);
        else if (iface.family === "IPv6") ipv6.push(iface.address);
      }
    }
  } catch {
    // networkInterfaces unavailable
  }
  return { ipv4, ipv6 };
}

/** Turn wildcard binds (0.0.0.0 / *) into concrete reachable addresses. */
export function expandListeningAddresses(addresses: string[]): string[] {
  const out = new Set<string>();
  const { ipv4, ipv6 } = lanAddresses();
  for (const a of addresses) {
    if (a === "0.0.0.0" || a === "*") {
      out.add("127.0.0.1");
      for (const ip of ipv4) out.add(ip);
    } else if (a === "::" || a === "::0") {
      out.add("::1");
      for (const ip of ipv6) out.add(ip);
    } else {
      out.add(a);
    }
  }
  return [...out];
}

function matchesAny(cmdline: string, exclusions?: RegExp | RegExp[]): boolean {
  if (!exclusions) return false;
  const list = Array.isArray(exclusions) ? exclusions : [exclusions];
  return list.some((re) => re.test(cmdline));
}

function discoverLinux(
  opts: DiscoveryOptions,
  internal: InternalRegistry,
): Map<number, ServicePortInfo> {
  const { descendants, selfAndAncestors } = collectLinuxTree(opts);
  const inodeToSocket = parseNetListenTables();
  const result = new Map<number, ServicePortInfo>();

  const candidatePids = new Set(descendants);
  for (const pid of listAllPids()) {
    if (candidatePids.has(pid) || selfAndAncestors.has(pid) || pid === process.pid) continue;
    if (processHasChildMarker(pid)) candidatePids.add(pid);
  }

  for (const pid of candidatePids) {
    const cmdline = readCommandLine(pid);
    if (isOwnProcess(cmdline) || matchesAny(cmdline, opts.excludeCmdline)) continue;
    if (processHasRole(pid)) continue; // framework helper → internal registry
    for (const sock of pidsListeningSockets(pid, inodeToSocket)) {
      if (internal.isInternalPort(sock.port)) continue;
      const existing = result.get(sock.port);
      if (existing) {
        if (!existing.addresses.includes(sock.address)) existing.addresses.push(sock.address);
      } else {
        result.set(sock.port, {
          port: sock.port,
          pid,
          process: readComm(pid),
          cmdline,
          addresses: [sock.address],
        });
      }
    }
  }
  for (const info of result.values()) info.addresses = expandListeningAddresses(info.addresses);
  return result;
}

export function parseLsofAddress(name: string): { address: string; port: number } | null {
  const m = /\[?([^\]]*)\]?:(\d+) \(LISTEN\)/.exec(name);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isFinite(port) || port <= 0) return null;
  return { address: m[1] || "*", port };
}

function discoverDarwin(
  descendants: Set<number>,
  opts: DiscoveryOptions,
  internal: InternalRegistry,
): Map<number, ServicePortInfo> {
  const table = readProcessTable();
  const result = new Map<number, ServicePortInfo>();
  let out: string;
  try {
    out = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return result;
  }
  for (const line of out.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const pid = Number(parts[1]!);
    if (!Number.isFinite(pid) || !descendants.has(pid)) continue;
    const parsed = parseLsofAddress(parts[8]!);
    if (!parsed) continue;
    if (internal.isInternalPort(parsed.port)) continue;
    const entry = table.get(pid);
    const cmdline = entry?.cmdline ?? "";
    if (isOwnProcess(cmdline) || matchesAny(cmdline, opts.excludeCmdline)) continue;
    const existing = result.get(parsed.port);
    if (existing) {
      if (!existing.addresses.includes(parsed.address)) existing.addresses.push(parsed.address);
    } else {
      result.set(parsed.port, {
        port: parsed.port,
        pid,
        process: parts[0]!,
        cmdline,
        addresses: [parsed.address],
      });
    }
  }
  for (const info of result.values()) info.addresses = expandListeningAddresses(info.addresses);
  return result;
}

export function parseNetstatAddress(addr: string): { address: string; port: number } | null {
  let m = /^\[([^\]]*)\]:(\d+)$/.exec(addr);
  if (m) {
    const port = Number(m[2]);
    return Number.isFinite(port) && port > 0 ? { address: m[1]!, port } : null;
  }
  m = /^([^:]+):(\d+)$/.exec(addr);
  if (m) {
    const port = Number(m[2]);
    return Number.isFinite(port) && port > 0 ? { address: m[1]!, port } : null;
  }
  return null;
}

function discoverWindows(
  descendants: Set<number>,
  opts: DiscoveryOptions,
  internal: InternalRegistry,
): Map<number, ServicePortInfo> {
  const table = readProcessTable();
  const result = new Map<number, ServicePortInfo>();
  let out: string;
  try {
    out = execFileSync("netstat", ["-ano"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return result;
  }
  for (const line of out.split("\n")) {
    if (!/LISTENING/.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const pid = Number(parts[4]!);
    if (!Number.isFinite(pid) || !descendants.has(pid)) continue;
    const parsed = parseNetstatAddress(parts[1]!);
    if (!parsed) continue;
    if (internal.isInternalPort(parsed.port)) continue;
    const entry = table.get(pid);
    if (!entry) continue;
    if (isOwnProcess(entry.cmdline) || isOwnProcess(entry.name) || matchesAny(entry.cmdline, opts.excludeCmdline)) {
      continue;
    }
    const existing = result.get(parsed.port);
    if (existing) {
      if (!existing.addresses.includes(parsed.address)) existing.addresses.push(parsed.address);
    } else {
      result.set(parsed.port, {
        port: parsed.port,
        pid,
        process: entry.name || "?",
        cmdline: entry.cmdline,
        addresses: [parsed.address],
      });
    }
  }
  for (const info of result.values()) info.addresses = expandListeningAddresses(info.addresses);
  return result;
}

/** Discover listening TCP ports owned by the caller's descendant processes. */
export function discoverServicePorts(
  internal: InternalRegistry,
  opts: DiscoveryOptions = {},
): Map<number, ServicePortInfo> {
  const { descendants } = collectProcTree(opts);
  if (process.platform === "linux") return discoverLinux(opts, internal);
  if (process.platform === "darwin") return discoverDarwin(descendants, opts, internal);
  return discoverWindows(descendants, opts, internal);
}

/**
 * Cached discovery — the cache doubles as the proxy allow-list.
 * Cache lives on globalThis so it survives hot reloads; keyed by marker so
 * distinct library instances (host + standalone) never share allow-lists.
 */
declare global {
  var __serviceTunnelsCache: Record<
    string,
    { ports: Map<number, ServicePortInfo>; expiresAt: number }
  > | undefined;
}

function cacheKey(): string {
  return `${process.pid}:${CHILD_MARKER}`;
}

/** Cached discovery (TTL 5s). */
export function getServicePorts(
  internal: InternalRegistry,
  opts: DiscoveryOptions = {},
): ServicePortInfo[] {
  const now = Date.now();
  const cache = (globalThis.__serviceTunnelsCache ??= {});
  const key = cacheKey();
  const entry = cache[key];
  if (!opts.force && entry && entry.expiresAt > now) {
    return [...entry.ports.values()];
  }
  const ports = discoverServicePorts(internal, opts);
  cache[key] = { ports, expiresAt: now + DISCOVERY_TTL_MS };
  return [...ports.values()];
}

/** Whether a port may be proxied (i.e. was found in the caller's tree). */
export function isServicePortAllowed(internal: InternalRegistry, port: number): boolean {
  return getServicePorts(internal).some((p) => p.port === port);
}

/**
 * Strip a basePath (e.g. /dev) from a path before forwarding to a proxied
 * service. Paths that do not start with the basePath pass through untouched.
 */
export function stripBasePath(pathname: string, basePath: string): string {
  const base = (basePath ?? "").replace(/\/+$/, "");
  if (!base || pathname === "/") return pathname;
  if (pathname === base) return "/";
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length);
  return pathname;
}

// ── Port ownership verification ───────────────────────────────────────────────

/** Extended port info with user information. */
export interface PortOwnerInfo extends Omit<ServicePortInfo, "username" | "uid"> {
  username: string;
  uid?: number;
}

/** Get the UID of a process (Linux/macOS). Returns null on error or unsupported. */
function getProcessUid(pid: number): number | null {
  if (process.platform === "linux") {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const m = /^Uid:\s+(\d+)/m.exec(status);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("ps", ["-o", "uid=", "-p", String(pid)], { encoding: "utf8" });
      const uid = Number(out.trim());
      return Number.isFinite(uid) ? uid : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Get the username of a process (Linux/macOS/Windows). */
function getProcessUsername(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const m = /^Uid:\s+(\d+)/m.exec(status);
      if (!m) return null;
      const uid = Number(m[1]);
      const passwd = readFileSync("/etc/passwd", "utf8");
      for (const line of passwd.split("\n")) {
        const parts = line.split(":");
        if (parts.length >= 3 && parts[2] === String(uid)) {
          return parts[0]!;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const uid = getProcessUid(pid);
      if (uid === null) return null;
      const out = execFileSync("id", ["-un", String(uid)], { encoding: "utf8" });
      return out.trim() || null;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    try {
      const cmd =
        'Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ' +
        pid +
        ' } | ForEach-Object { $_.GetOwner().User }';
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", cmd],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      );
      return out.trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Get the current username. */
export function getCurrentUsername(): string {
  if (process.platform === "win32") {
    return process.env.USERNAME || process.env.USER || "unknown";
  }
  return process.env.USER || process.env.LOGNAME || "unknown";
}

/** Get the current UID (Linux/macOS only). */
function getCurrentUid(): number | null {
  if (process.platform === "win32") return null;
  return process.getuid ? process.getuid() : null;
}

/** Find all processes listening on a specific port (not limited to descendants). */
function findPortListeners(port: number, internal: InternalRegistry): PortOwnerInfo[] {
  const result: PortOwnerInfo[] = [];

  if (process.platform === "linux") {
    const inodeToSocket = parseNetListenTables();
    const pids = listAllPids();

    for (const pid of pids) {
      if (processHasRole(pid)) continue; // skip framework helpers
      for (const sock of pidsListeningSockets(pid, inodeToSocket)) {
        if (sock.port === port && !internal.isInternalPort(port)) {
          const username = getProcessUsername(pid);
          const uid = getProcessUid(pid);
          result.push({
            port,
            pid,
            process: readComm(pid),
            cmdline: readCommandLine(pid),
            addresses: [sock.address],
            username: username || "unknown",
            uid: uid ?? undefined,
          });
        }
      }
    }
  } else if (process.platform === "darwin") {
    try {
      const out = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-P"], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      for (const line of out.split("\n").slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 9) continue;
        const parsed = parseLsofAddress(parts[8]!);
        if (!parsed || parsed.port !== port) continue;
        if (internal.isInternalPort(port)) continue;
        const pid = Number(parts[1]!);
        const username = getProcessUsername(pid);
        const uid = getProcessUid(pid);
        result.push({
          port,
          pid,
          process: parts[0]!,
          cmdline: parts[8]!,
          addresses: [parsed.address],
          username: username || "unknown",
          uid: uid ?? undefined,
        });
      }
    } catch {
      // lsof failed
    }
  } else if (process.platform === "win32") {
    try {
      const out = execFileSync("netstat", ["-ano"], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      for (const line of out.split("\n")) {
        if (!/LISTENING/.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const parsed = parseNetstatAddress(parts[1]!);
        if (!parsed || parsed.port !== port) continue;
        if (internal.isInternalPort(port)) continue;
        const pid = Number(parts[4]!);
        const username = getProcessUsername(pid);
      result.push({
          port,
          pid,
          process: "unknown",
          cmdline: "",
          addresses: [parsed.address],
          username: username || "unknown",
        });
      }
    } catch {
      // netstat failed
    }
  }

  // Expand wildcard addresses
  for (const info of result) {
    info.addresses = expandListeningAddresses(info.addresses);
  }

  return result;
}

/**
 * Verify that a port is owned by the current user.
 *
 * This is a security check to prevent tunneling ports owned by other users.
 * The check can be bypassed with the `--force` flag.
 *
 * @returns `{ allowed: true }` if port is owned by current user
 *          `{ allowed: false, reason: string }` if not
 */
export function verifyPortOwner(port: number, internal: InternalRegistry): {
  allowed: boolean;
  reason?: string;
  owners?: PortOwnerInfo[];
} {
  const listeners = findPortListeners(port, internal);

  if (listeners.length === 0) {
    return { allowed: false, reason: `Port ${port} is not being listened to by any process` };
  }

  const currentUser = getCurrentUsername();
  const currentUid = getCurrentUid();

  // Check if any listener is owned by the current user
  for (const listener of listeners) {
    let isOwner = false;

    if (process.platform === "win32") {
      // Windows: compare usernames (case-insensitive)
      isOwner = listener.username.toLowerCase() === currentUser.toLowerCase();
    } else {
      // Unix-like: compare UIDs first, then usernames as fallback
      if (currentUid !== null && listener.uid !== undefined) {
        isOwner = listener.uid === currentUid;
      } else {
        isOwner = listener.username === currentUser;
      }
    }

    if (isOwner) {
      return { allowed: true };
    }
  }

  // None of the listeners are owned by the current user
  const owners = listeners.map((l) => `${l.process} (${l.username})`).join(", ");
  return {
    allowed: false,
    reason: `Port ${port} is owned by other user(s): ${owners}. Use --force to tunnel anyway.`,
    owners: listeners,
  };
}
