/**
 * self-expose（TODO-5）：迁移 pi-web 的 PI_WEB_EXPOSE 机制进库。
 *
 * 宿主（嵌入方）把自己的端口暴露（如 pi-web 暴露自身 UI），并受
 * `allowlocal`（直连门控）/ `allowHost`（例外域名）/ `auth`（认证保护）控制。
 *
 * - `SERVICE_TUNNELS_EXPOSE`：纯 `k=v,k2=v2` 格式（无 JSON），dotted 键嵌套
 *   （`tunnel.domain=…`/`provider.oidc.issuerUrl=…`/`user.name=…`）；
 *   `allowHost` 可重复（逗号或空格分隔）；未知键警告忽略；非法 mode
 *   fail-closed（不暴露）。
 * - `exposeSelf(st, opts)`：以独立认证域（默认 site "self"）+ 固定 label
 *   "self" 暴露宿主端口——与服务端口暴露隔离（§4.9 site 默认值）。
 * - allowlocal 门控：`allowLocal()`/`setAllowLocalTemporary(v,ttlMs)`/
 *   `confirmAllowLocal(v)`/`getAllowLocalPending()`/`allowHosts()`/
 *   `setAllowHosts(hosts)`；宿主 middleware 用 `isDirectAccessAllowed(host)`
 *   判定裸直连（回环/LAN 都拦，仅 allowHost + 网关入口放行）。
 * - `maybeExposeSelf(st)`：解析 env → 应用 allowlocal/allowHost 配置 →
 *   mode 非 none 时调用 exposeSelf。由 CLI/宿主启动时调用（库不自动暴露）。
 */

import type { ServiceTunnels } from "./index.ts";

export interface SelfExposeOptions {
  /** tunnel/proxy/both。缺省 proxy。 */
  mode?: "tunnel" | "proxy" | "both" | "portmap" | "ipv6";
  /** 认证 provider（site "self" 默认 portal）。 */
  auth?: string;
  policy?: "one_factor" | "two_factor" | "deny";
  tunnel?: string;
  protocol?: "http" | "https" | "tcp";
  allowToolDownload?: boolean;
  ngrokAuthtoken?: string;
  tunnelParams?: Record<string, unknown>;
  providerParams?: Record<string, unknown>;
  /** 预置认证用户。 */
  user?: { name: string; password: string };
  /** 自身端口（缺省 st.dirs 无默认 → 必填或由 env `port=` 提供）。 */
  port?: number;
  /** 自身服务的 base path（转发映射用；缺省 "" 根路径）。 */
  serviceBasePath?: string;
  /** 直连门控：false → 非 allowHost 裸直连（含回环）403。 */
  allowlocal?: boolean;
}

export interface SelfExposeEnv {
  mode?: string;
  auth?: string;
  policy?: string;
  tunnel?: string;
  protocol?: string;
  allowToolDownload?: boolean;
  port?: number;
  ngrokAuthtoken?: string;
  allowlocal?: boolean;
  allowHost?: string[];
  user?: { name?: string; password?: string };
  tunnelParams?: Record<string, unknown>;
  providerParams?: Record<string, unknown>;
  [k: string]: unknown;
}

const EXPOSE_SCALAR_KEYS = new Set(["mode", "auth", "policy", "tunnel", "protocol", "allowToolDownload", "port", "ngrokAuthtoken", "allowlocal"]);
const VALID_MODES = new Set(["tunnel", "proxy", "both", "portmap", "ipv6", "none"]); // 遗留项2：env 路径补 portmap/ipv6 两模式

function coerce(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function setDotted(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** 解析 SERVICE_TUNNELS_EXPOSE。未知键警告跳过；非法 mode → null（fail-closed）。 */
export function parseExposeEnv(raw: string | undefined | null): SelfExposeEnv | null {
  if (!raw?.trim()) return null;
  const out: SelfExposeEnv = {};
  let hasKey = false;
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key || value === "") continue;
    hasKey = true;
    if (key.startsWith("tunnel.")) {
      const tp = (out.tunnelParams ??= {}) as Record<string, unknown>;
      tp[key.slice(7)] = coerce(value);
    } else if (key.startsWith("provider.")) {
      const pp = (out.providerParams ??= {}) as Record<string, unknown>;
      setDotted(pp, key.slice(9), coerce(value));
    } else if (key.startsWith("user.")) {
      const u = (out.user ??= {}) as Record<string, unknown>;
      u[key.slice(5)] = coerce(value);
    } else if (key === "allowHost") {
      const arr = (out.allowHost ??= []) as string[];
      for (const h of value.split(/[\s,]+/)) {
        if (h.trim()) arr.push(h.trim());
      }
    } else if (EXPOSE_SCALAR_KEYS.has(key)) {
      out[key] = coerce(value);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[service-tunnels] SERVICE_TUNNELS_EXPOSE: 未知键 "${key}"，已忽略`);
    }
  }
  if (!hasKey) return null;
  // mode 缺省 "none"：只应用 allowlocal/allowHost 配置，不暴露自身
  out.mode = String(out.mode ?? "none");
  if (!VALID_MODES.has(out.mode)) {
    // eslint-disable-next-line no-console
    console.warn(`[service-tunnels] SERVICE_TUNNELS_EXPOSE: 非法 mode "${out.mode}"（tunnel|proxy|both|portmap|ipv6|none），不启用`);
    return null;
  }
  return out;
}

// ── allowlocal / allowHost 状态（每实例，非全局） ───────────────────────────

export interface SelfGateState {
  allowLocal: boolean;
  allowLocalOverride?: boolean; // runtime override（TTL 或已确认）
  allowLocalPendingExpires?: number;
  allowLocalTimer?: ReturnType<typeof setTimeout>;
  allowHosts: string[];
}

export function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\./, "").replace(/:\d{1,5}$/, "");
}

export function createSelfGate(initialAllowLocal: boolean, initialAllowHosts: string[] = []): {
  state: SelfGateState;
  allowLocal(): boolean;
  setAllowLocalTemporary(v: boolean, ttlMs: number): void;
  confirmAllowLocal(v: boolean): void;
  getAllowLocalPending(): { pending: boolean; expiresAt: number };
  allowHosts(): string[];
  setAllowHosts(hosts: string[]): void;
  /** 裸直连判定：allowlocal=true → 放行；false → 仅 allowHost 白名单。 */
  isDirectAccessAllowed(host: string | undefined): boolean;
} {
  const state: SelfGateState = { allowLocal: initialAllowLocal, allowHosts: initialAllowHosts.map(normalizeHost) };

  const allowLocal = () => (typeof state.allowLocalOverride === "boolean" ? state.allowLocalOverride : state.allowLocal);

  const setAllowLocalTemporary = (v: boolean, ttlMs: number) => {
    if (state.allowLocalTimer) clearTimeout(state.allowLocalTimer);
    state.allowLocalOverride = v;
    state.allowLocalPendingExpires = Date.now() + ttlMs;
    state.allowLocalTimer = setTimeout(() => {
      state.allowLocalTimer = undefined;
      state.allowLocalPendingExpires = undefined;
      // 回到 env/默认（不强制 true：env 显式 allowlocal=false 则尊重它）
      state.allowLocalOverride = undefined;
    }, ttlMs);
    state.allowLocalTimer.unref?.();
  };

  const confirmAllowLocal = (v: boolean) => {
    if (state.allowLocalTimer) clearTimeout(state.allowLocalTimer);
    state.allowLocalTimer = undefined;
    state.allowLocalPendingExpires = undefined;
    state.allowLocalOverride = v;
  };

  const getAllowLocalPending = () => {
    const exp = state.allowLocalPendingExpires;
    return { pending: exp !== undefined && exp > Date.now(), expiresAt: exp ?? 0 };
  };

  const allowHosts = () => [...state.allowHosts];

  const setAllowHosts = (hosts: string[]) => {
    state.allowHosts = (hosts ?? []).map((h) => normalizeHost(h)).filter(Boolean);
  };

  const isDirectAccessAllowed = (host: string | undefined) => {
    if (allowLocal()) return true;
    if (!host) return false;
    const h = normalizeHost(host);
    return state.allowHosts.includes(h);
  };

  return { state, allowLocal, setAllowLocalTemporary, confirmAllowLocal, getAllowLocalPending, allowHosts, setAllowHosts, isDirectAccessAllowed };
}

// ── exposeSelf / maybeExposeSelf ────────────────────────────────────────────

/** 以独立认证域（默认 site "self"）暴露宿主自身端口。`exposePort` 由
 *  createServiceTunnels 注入（st.auth.expose 引用，避免构造期循环引用）。 */
export async function exposeSelf(
  exposePort: (port: number, opts: Record<string, unknown>) => Promise<{ url: string | null; localUrl?: string; baseUrl?: string; domainUrl?: string; error?: string; tunnel: string }>,
  opts: SelfExposeOptions = {},
): Promise<{ url: string | null; localUrl?: string; baseUrl?: string; domainUrl?: string; error?: string; name?: string }> {
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`self-expose: port required (got ${opts.port})`);
  }
  const authNone = opts.auth === "none";
  const provider = opts.auth && opts.auth !== "auto" && !authNone ? opts.auth : "portal";
  const mode = opts.mode ?? "proxy";
  const site = "self";
  const label = "self";
  const res = await exposePort(port, {
    auth: authNone ? "none" : true,
    mode,
    site,
    label,
    ...(provider !== "portal" && !authNone ? { provider } : {}),
    tunnelType: opts.tunnel ?? "cloudflared",
    tunnelName: `expose-self-${port}`,
    serviceBasePath: opts.serviceBasePath,
    protocol: opts.protocol,
    policy: opts.policy,
    allowToolDownload: opts.allowToolDownload,
    ngrokAuthtoken: opts.ngrokAuthtoken,
    tunnelParams: opts.tunnelParams,
    providerParams: opts.providerParams,
    user: opts.user as { name: string; password: string } | undefined,
  });
  return { url: res.url, localUrl: res.localUrl, baseUrl: res.baseUrl, domainUrl: res.domainUrl, error: res.error, name: res.tunnel };
}

/** 启动钩子：解析 SERVICE_TUNNELS_EXPOSE → 应用 allowlocal/allowHost → mode
 *  非 none 时 exposeSelf。由 CLI/宿主调用（库不自动暴露）。 */
export async function maybeExposeSelf(
  st: Pick<ServiceTunnels, "self"> & { authExpose: (port: number, opts: Record<string, unknown>) => Promise<{ url: string | null; localUrl?: string; baseUrl?: string; domainUrl?: string; error?: string; tunnel: string }> },
  env: string | undefined = process.env.SERVICE_TUNNELS_EXPOSE,
): Promise<{ exposed: boolean; error?: string }> {
  const cfg = parseExposeEnv(env);
  if (!cfg) return { exposed: false };
  // 显式 env 的 allowlocal/allowHost 作为 gate 基线（运行时 override 可覆盖，
  // 重启回 env）。
  if (typeof cfg.allowlocal === "boolean") st.self.confirmAllowLocal(cfg.allowlocal);
  if (cfg.allowHost?.length) st.self.setAllowHosts(cfg.allowHost);
  if (cfg.mode === "none") return { exposed: false };
  try {
    await exposeSelf(st.authExpose, {
      mode: cfg.mode as "tunnel" | "proxy" | "both" | "portmap" | "ipv6",
      auth: cfg.auth as string | undefined,
      policy: cfg.policy as "one_factor" | "two_factor" | "deny" | undefined,
      tunnel: cfg.tunnel,
      protocol: cfg.protocol as "http" | "https" | "tcp" | undefined,
      allowToolDownload: cfg.allowToolDownload,
      port: cfg.port,
      ngrokAuthtoken: cfg.ngrokAuthtoken,
      tunnelParams: cfg.tunnelParams,
      providerParams: cfg.providerParams,
      user: cfg.user && cfg.user.name && cfg.user.password ? { name: cfg.user.name, password: cfg.user.password } : undefined,
      allowlocal: cfg.allowlocal,
    });
    return { exposed: true };
  } catch (err) {
    return { exposed: false, error: err instanceof Error ? err.message : String(err) };
  }
}
