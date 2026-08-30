/**
 * ui-helpers — src/ui.ts 拆出的公共后端函数（TODO-6 模块化重构）。
 */
import type { IncomingMessage, ServerResponse } from "http";
import type { ServiceTunnels } from "./index.ts";

export interface UiContext {
  st: ServiceTunnels;
  port: number;
  csrfToken: string;
  /** 远程放行的 Host 白名单（无端口；空 = loopback-only）。 */
  allowedHosts?: string[];
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.replace(/:\d+$/, "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

export function parseBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const out: Record<string, string> = {};
      for (const pair of body.split("&")) {
        const [k, v] = pair.split("=").map(decodeURIComponent);
        if (k) out[k] = v ?? "";
      }
      resolve(out);
    });
  });
}

export function readJson<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (chunk) => (b += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(b || "{}") as T);
      } catch {
        resolve({} as T);
      }
    });
  });
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function daemonOrLocal<T>(ctx: UiContext, method: string, params?: unknown, local?: () => T | Promise<T>, timeoutMs = 60_000): Promise<T | null> {
  return ctx.st.daemon.request<T>(method, params, timeoutMs).then((r) => {
    if (r !== null) return r;
    return (local ? local() : Promise.resolve(null) as unknown) as T | null;
  }).catch(() => (local ? local() : null));
}

export function maskParams(params: Record<string, unknown> | null | undefined): Record<string, string> | null {
  if (!params) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    const s = String(v ?? "");
    out[k] = /token|secret|password|key/i.test(k) && s.length > 4 ? `••••${s.slice(-4)}` : s;
  }
  return out;
}

export function sshDomainFor(site: string): string {
  return site === "default" ? "default" : site;
}

export async function findExpose(ctx: UiContext, name: string): Promise<{ accessLog?: string | null; errorLog?: string | null } | null> {
  if (!name) return null;
  const fromDaemon = await ctx.st.daemon.request<any[]>("expose.list", undefined, 5_000).catch(() => null);
  const found = (fromDaemon ?? []).find((e) => e.name === name) ?? ctx.st.exposes().find((e) => e.name === name);
  return found ?? null;
}