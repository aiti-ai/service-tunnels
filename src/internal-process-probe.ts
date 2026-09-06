import { existsSync, readFileSync, readdirSync, readlinkSync } from "fs";
import { execFileSync } from "child_process";
import { getMarker } from "./marker.ts";

/**
 * 进程凭证探针（想法②）——基于 `SERVICE_TUNNELS_MARKER` + 操作系统进程表反查。
 *
 * 用途：service-tunnels 嵌入方接管登录、拦截所有请求后，AI 内部用 curl/fetch
 * 的请求也会被阻断。本探针提供"不依赖 token"的旁路：对回环请求，反查发起 pid
 * 的 environ 是否带本实例的 `SERVICE_TUNNELS_MARKER`（= 库 spawn 的后代进程）
 * → 命中即放行，**子进程完全不用改 curl**，且覆盖任意深度（孙进程继承 env）。
 *
 * 工作原理：
 *   - **Linux**（可靠）：读 `/proc/net/tcp` + `/proc/net/tcp6`，找 local port ==
 *     ephemeral 且 st==01（ESTABLISHED）→ inode → 反查各 pid 的
 *     `/proc/<pid>/fd` socket 链接 → pid → `/proc/<pid>/environ` 查 marker
 *   - **macOS**（实验性，尽力）：`lsof -nP -iTCP:<port> -sTCP:ESTABLISHED -Fp`
 *     → pid → `ps -e -p <pid>` 读 environ 查 marker。受 SIP 限制，部分版本
 *     跨进程读 environ 受限 → 读不到即降级 false
 *   - **Windows**：不支持（无 `/proc`，environ 在 PEB 需 native API）→ 探针恒
 *     false（降级为纯 token 校验）
 *
 * 安全模型：
 *   - **只认回环 remoteAddress**（`127.0.0.0/8` + `::1` + `::ffff:127.0.0.1`），
 *     公网/LAN 不旁路
 *   - marker 是 per-process 随机串，只有继承了本实例 env 的子进程才带它（宿主
 *     spawn AI bash 时若裁剪了 env 则不命中——预期行为）
 *   - fail-closed：任何读取失败 → false
 *
 * 性能：每请求反查开销大（Linux 扫各 pid 的 /proc/<pid>/fd；macOS 调 lsof+ps），**必须带 TTL
 * 缓存**（默认 5s，key=ephemeral port）。缓存期内校验 pid 仍存活（退出即失效）；
 * TIME_WAIT 端口复用靠短 TTL + pid 存活校验防误判。
 *
 * **默认不 wire**（避免核心路径引入进程表扫描依赖）：嵌入方按需
 * `createServiceTunnels({ autoWireProcessProbe: true })`（便捷开关，默认 false）
 * 或显式 `createServiceTunnels({ verifyInternalProcess: createProcessProbe() })`。
 */

export interface ProcessProbeOptions {
  /** 要匹配的 marker 值（缺省 `getMarker()`——当前库实例的 marker）。 */
  marker?: string;
  /** 缓存 TTL（ms）。缺省 5000。key=ephemeral port。0 = 不缓存（不推荐）。 */
  cacheTtlMs?: number;
}

interface CacheEntry {
  /** 命中的 pid（0 = 反查未找到 / verdict=false 时的占位）。 */
  pid: number;
  verdict: boolean;
  ts: number;
}

const PROC_NET_TCP = "/proc/net/tcp";
const PROC_NET_TCP6 = "/proc/net/tcp6";

/** 解析 remoteAddress 的回环 ephemeral port；非回环/无法解析 → null。
 *  认整个 127.0.0.0/8（Linux 回环段）、::1、IPv4-mapped IPv6。 */
function parseLoopbackPort(remoteAddress: string | undefined): number | null {
  if (!remoteAddress) return null;
  const m = /:(\d{1,5})$/.exec(remoteAddress);
  if (!m) return null;
  const port = Number(m[1]);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  const host = remoteAddress.slice(0, -m[0].length).replace(/^\[|\]$/g, "");
  if (!isLoopbackHost(host)) return null;
  return port;
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  // 127.0.0.0/8 整段都是回环（Linux 任意 127.x.x.x 都可达本机）
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return h === "::1" || h === "0:0:0:0:0:0:0:1" || h === "::ffff:127.0.0.1";
}

// ── Linux 实现（/proc，可靠） ──────────────────────────────────────────────

/** /proc/net/tcp 行 → inode 集合，for ESTABLISHED sockets whose local port matches. */
function establishedInodesForPort(port: number): Set<number> {
  const out = new Set<number>();
  for (const file of [PROC_NET_TCP, PROC_NET_TCP6]) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      if (parts[3] !== "01") continue; // only ESTABLISHED
      const local = parts[1]!;
      const idx = local.indexOf(":");
      if (idx <= 0) continue;
      const localPort = parseInt(local.slice(idx + 1), 16);
      if (localPort !== port) continue;
      const inode = Number(parts[9]!);
      if (Number.isFinite(inode) && inode > 0) out.add(inode);
    }
  }
  return out;
}

/** 反查持有任一 inode socket 的 pid（遍历各 pid 的 `/proc/<pid>/fd` socket 链接）。 */
function linuxPidHoldingInode(inodes: Set<number>): number | null {
  if (inodes.size === 0) return null;
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  for (const pidStr of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pidStr}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = readlinkSync(`/proc/${pidStr}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (!m) continue;
      if (inodes.has(Number(m[1]))) return Number(pidStr);
    }
  }
  return null;
}

function linuxPidHasMarker(pid: number, marker: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").includes(marker);
  } catch {
    return false;
  }
}

/** Linux 探针实现（/proc 反查）。非 Linux（无 /proc/net/tcp）→ 探针恒 false。 */
function createLinuxProbe(
  marker: string,
  cacheTtl: number,
): (remoteAddress: string | undefined) => boolean {
  if (!marker || !existsSync(PROC_NET_TCP)) return () => false;
  const cache = new Map<number, CacheEntry>();
  return (remoteAddress: string | undefined): boolean => {
    const port = parseLoopbackPort(remoteAddress);
    if (port === null) return false;
    const now = Date.now();
    const hit = cache.get(port);
    if (hit && cacheTtl > 0 && now - hit.ts < cacheTtl) {
      if (hit.pid > 0 && !existsSync(`/proc/${hit.pid}`)) cache.delete(port);
      else return hit.verdict;
    }
    const inodes = establishedInodesForPort(port);
    const pid = linuxPidHoldingInode(inodes);
    const verdict = pid !== null && linuxPidHasMarker(pid, marker);
    cache.set(port, { pid: pid ?? 0, verdict, ts: now });
    return verdict;
  };
}

// ── macOS 实现（lsof + ps -e，实验性） ────────────────────────────────────

/** lsof 反查占住本地 port 的 ESTABLISHED 连接的 pid。 */
function macPidForPort(port: number): number | null {
  let out: string;
  try {
    out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-Fp"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    }).toString();
  } catch {
    return null;
  }
  for (const line of out.split("\n")) {
    const m = /^p(\d+)$/.exec(line.trim());
    if (m) return Number(m[1]);
  }
  return null;
}

/** macOS 读 pid 的 environ 是否含 marker（ps -e 显示环境变量）。
 *  受 SIP 限制：macOS 14+ 跨进程读 environ 可能被拒 → 读不到即 false。 */
function macPidHasMarker(pid: number, marker: string): boolean {
  let out: string;
  try {
    out = execFileSync("ps", ["-e", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
      encoding: "utf8",
    });
  } catch {
    return false;
  }
  return out.includes(marker);
}

/** macOS 探针实现（lsof + ps -e，实验性）。lsof/ps 缺失 → 恒 false。 */
function createMacProbe(
  marker: string,
  cacheTtl: number,
): (remoteAddress: string | undefined) => boolean {
  // lsof 可用性探测（缺失即不启用）
  let lsofOk = false;
  try {
    execFileSync("which", ["lsof"], { stdio: "ignore", timeout: 2_000 });
    lsofOk = true;
  } catch {
    lsofOk = false;
  }
  if (!marker || !lsofOk) return () => false;
  const cache = new Map<number, CacheEntry>();
  return (remoteAddress: string | undefined): boolean => {
    const port = parseLoopbackPort(remoteAddress);
    if (port === null) return false;
    const now = Date.now();
    const hit = cache.get(port);
    if (hit && cacheTtl > 0 && now - hit.ts < cacheTtl) {
      // pid==0（曾未找到）→ 直接复用；pid>0 → ps 探活，退出则作废重查
      if (hit.pid === 0) return hit.verdict;
      try {
        execFileSync("ps", ["-p", String(hit.pid), "-o", "pid="], { stdio: "ignore", timeout: 1_000 });
        return hit.verdict;
      } catch {
        cache.delete(port);
      }
    }
    const pid = macPidForPort(port);
    const verdict = pid !== null && macPidHasMarker(pid, marker);
    cache.set(port, { pid: pid ?? 0, verdict, ts: now });
    return verdict;
  };
}

// ── 平台分发 ──────────────────────────────────────────────────────────────

/**
 * 按平台创建进程凭证探针：
 *   - Linux → `/proc` 实现（可靠）
 *   - macOS → `lsof`+`ps` 实现（实验性，受 SIP 限制）
 *   - Windows / 其他 → 探针恒 false（降级为纯 token 校验）
 */
export function createProcessProbe(
  opts: ProcessProbeOptions = {},
): (remoteAddress: string | undefined) => boolean {
  const marker = opts.marker ?? getMarker();
  const cacheTtl = opts.cacheTtlMs ?? 5_000;
  if (process.platform === "linux") return createLinuxProbe(marker, cacheTtl);
  if (process.platform === "darwin") return createMacProbe(marker, cacheTtl);
  return () => false;
}

/** Linux 专用探针（/proc 实现）。非 Linux 恒 false。 */
export function createLinuxProcessProbe(
  opts: ProcessProbeOptions = {},
): (remoteAddress: string | undefined) => boolean {
  const marker = opts.marker ?? getMarker();
  const cacheTtl = opts.cacheTtlMs ?? 5_000;
  return createLinuxProbe(marker, cacheTtl);
}

/** macOS 专用探针（lsof+ps 实现，实验性）。非 macOS 恒 false。 */
export function createMacProcessProbe(
  opts: ProcessProbeOptions = {},
): (remoteAddress: string | undefined) => boolean {
  const marker = opts.marker ?? getMarker();
  const cacheTtl = opts.cacheTtlMs ?? 5_000;
  return createMacProbe(marker, cacheTtl);
}
