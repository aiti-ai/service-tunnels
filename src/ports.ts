/**
 * 本机监听端口识别（daemon IPC `port.list`）。
 *
 * 枚举 /proc/net/tcp[6] 的 LISTEN 套接字，通过 socket inode 反查 /proc/<pid>/fd
 * 归属进程，并按调用方 uid 过滤 —— 只列出**当前用户**的进程端口（不泄漏
 * 其他用户/系统进程），供 UI 暴露端口下拉选择。
 *
 * scope:
 *   - "current-user"（默认）：当前 uid 的所有进程
 *   - "pid:<n>"：指定 pid 及其全部子孙进程（进程树，如宿主应用整棵树）
 */

import { readdirSync, readlinkSync, readFileSync } from "node:fs";

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

/** 进程是否属于当前用户（或指定 pid 的进程树）。 */
function matchScope(pid: number, scope: string): boolean {
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
    const root = Number(scope.slice(4));
    if (!root || pid === root) return true;
    // 沿 /proc/<pid>/status PPid 链向上找 root
    let cur = pid;
    for (let depth = 0; depth < 64; depth++) {
      let ppid = -1;
      try {
        const st = readFileSync(`/proc/${cur}/status`, "utf8");
        const m = /^PPid:\s+(\d+)/m.exec(st);
        const ppidStr = m?.[1];
        if (ppidStr) ppid = Number(ppidStr);
      } catch {
        return false;
      }
      if (ppid === root) return true;
      if (ppid <= 1 || ppid === cur) return false;
      cur = ppid;
    }
    return false;
  }
  return true;
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
    /python3 -c|s\.accept\(\).*time\.sleep/.test(c)
  );
}

export function listListeningPorts(scope = "current-user"): PortInfo[] {
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
    if (!matchScope(owner.pid, scope)) continue;
    if (isFrameworkProcess(owner.process)) continue;
    const key = `${e.port}-${e.protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port: e.port, pid: owner.pid, process: owner.process, protocol: e.protocol });
  }
  out.sort((a, b) => a.port - b.port);
  return out;
}
