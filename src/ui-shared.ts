/**
 * ui-shared — 双端共享展示语义（库 `st ui` 与 pi-web 扩展共同消费）。
 *
 * 无依赖纯函数 + 类型：modeOf / fmtAddr / fmtBytes / identityView /
 * ddnsBadge / netcheckEventView / adviceView。禁止 DOM / Node API / 网络访问
 * ——两端（浏览器与 Node）都必须能原样 import。
 *
 * 消费方式：
 *   - 库 UI：构建产物 dist/ui-shared.js 以 `<script type="module"
 *     src="/ui/shared.js">` 加载，模块顶层把全部导出挂到
 *     `window.__stShared`（下方 "browser mount" 段）；core.js 运行时优先取
 *     `window.__stShared`，缺失时回落本地实现（等价性由 test/ui-shared.test.mjs
 *     钉死，漂移即测试红）。
 *   - pi-web 扩展：`import { modeOf, identityView, … } from
 *     "service-tunnels/src/ui-shared.ts"`（package.json exports `./src/*.ts`）。
 *
 * i18n 约定：本模块不查任何语言表——人读文案一律返回 i18n key（`ui.doctor.*`
 * 等，权威表在 src/i18n.ts CATALOG），渲染端用各自的 tr()/translate() 查。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 暴露条目
// ─────────────────────────────────────────────────────────────────────────────

export type ExposeMode = "tunnel" | "proxy" | "both" | "portmap" | "ipv6";

/** mode 显示规则：记录自带 mode 优先；老记录按 name 前缀（ipv6:/proxy:）推断。 */
export function modeOf(e: { mode?: string; name?: string; tunnelType?: string } | null | undefined): string {
  if (e && e.mode) return e.mode;
  if (!e || !e.name) return "";
  if (e.name.indexOf("ipv6:") === 0) return "ipv6";
  if (e.name.indexOf("proxy:") === 0) return "proxy";
  return e.tunnelType || "";
}

// ─────────────────────────────────────────────────────────────────────────────
// 地址 / 字节格式化
// ─────────────────────────────────────────────────────────────────────────────

/** IPv6 字面量加方括号（含端口拼接前的地址部分）；IPv4 / 域名原样。 */
export function fmtAddr(a: string): string {
  return a.includes(":") ? "[" + a + "]" : a;
}

/** 字节数人读（B/KB/MB/GB，一位小数；负数/非有限原样返回 "—"）。 */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + " GB";
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return String(n) + " B";
}

// ─────────────────────────────────────────────────────────────────────────────
// 端口识别（port-identity 探测结果的展示视图）
// ─────────────────────────────────────────────────────────────────────────────

export interface IdentityView {
  /** favicon URL（可直接进 <img src>；调用方负责 esc）。 */
  icon?: string;
  /** 主行文本：用户 label > 探测 title（可能与 label 同值）。 */
  title?: string;
  /** 次级行/tooltip 元信息串：协议 + 状态码 + Server 头（"http 200 · nginx"）。 */
  tooltip?: string;
  /** 用户自定义 label 是否存在（true 时主行是人工事实，客户端可加样式）。 */
  hasLabel?: boolean;
  /** 探测到的原始 title（仅当 label 存在且与 title 不同时带回）——客户端可拼
   *  「探测: {detected}」前缀进 tooltip。 */
  detected?: string;
}

/**
 * port-identity 探测结果 → 展示视图（主行 label>title 规则、tooltip 拼装）。
 * 传入 undefined（无探测数据）返回空视图 {}，调用方回落进程名渲染。
 */
export function identityView(
  id: { label?: string; title?: string; favicon?: string; protocol?: string; status?: number; server?: string } | null | undefined,
): IdentityView {
  if (!id) return {};
  const isHttp = !!id.protocol && id.protocol !== "tcp";
  const meta = isHttp
    ? [id.protocol + (id.status ? " " + id.status : ""), id.server].filter(Boolean).join(" · ")
    : "";
  const hasLabel = !!id.label;
  const title = id.label || id.title;
  const detected = id.label && id.title && id.label !== id.title ? id.title : undefined;
  const tooltip = [detected, meta].filter(Boolean).join(" · ");
  const out: IdentityView = {};
  if (id.favicon) out.icon = id.favicon;
  if (title) out.title = title;
  if (tooltip) out.tooltip = tooltip;
  if (hasLabel) out.hasLabel = true;
  if (detected) out.detected = detected;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// DDNS badge（exposes 记录的 ddns 注册结果列）
// ─────────────────────────────────────────────────────────────────────────────

export interface DdnsBadge {
  profile?: string;
  items: Array<{ type: string; ok: boolean }>;
}

/** expose.ddns → badge 数据（无 ddns / 无 actions 返回 null，调用方渲染 "-"）。 */
export function ddnsBadge(
  ddns?: { profile?: string; actions?: Array<{ type: string; ok: boolean }> } | null,
): DdnsBadge | null {
  if (!ddns || !Array.isArray(ddns.actions) || !ddns.actions.length) return null;
  const out: DdnsBadge = { items: ddns.actions.map((a) => ({ type: String(a.type), ok: !!a.ok })) };
  if (ddns.profile) out.profile = ddns.profile;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// doctor（netcheck）事件渲染 — 双端同构（契约冻结：键名 ui.doctor.ev.<type>）
// ─────────────────────────────────────────────────────────────────────────────

export type NetcheckTone = "ok" | "bad" | "dim" | "warn";

export interface NetcheckEventView {
  icon: string;
  /** i18n key（ui.doctor.ev.<type>）；渲染端查各自语言表。 */
  textKey: string;
  /** 插值参数（渲染端 {k} 替换）。 */
  params?: Record<string, string>;
  tone: NetcheckTone;
}

/**
 * NetcheckEvent（docs/netcheck-design.md §5.1）→ 渲染视图。
 * 未知事件类型兜底 ui.doctor.ev.unknown（dim），双端行为一致。
 */
export function netcheckEventView(ev: { type: string } & Record<string, unknown>): NetcheckEventView {
  switch (ev.type) {
    case "phase-start":
      return { icon: "▶", textKey: "ui.doctor.ev.phase-start", params: { label: String(ev.label ?? ""), total: ev.total != null ? String(ev.total) : "" }, tone: "dim" };
    case "probe-done":
      return { icon: ev.ok ? "✓" : "✗", textKey: "ui.doctor.ev.probe-done", params: { item: String(ev.item ?? ""), verdict: String(ev.verdict ?? ""), ms: String(ev.ms ?? "") }, tone: ev.ok ? "ok" : "bad" };
    case "tunnel-est":
      return { icon: "✓", textKey: "ui.doctor.ev.tunnel-est", params: { provider: String(ev.provider ?? ""), url: String(ev.url ?? ""), ms: String(ev.ms ?? "") }, tone: "ok" };
    case "tunnel-fail":
      return { icon: "✗", textKey: "ui.doctor.ev.tunnel-fail", params: { provider: String(ev.provider ?? ""), error: String(ev.error ?? ""), ms: String(ev.ms ?? "") }, tone: "bad" };
    case "channel-result":
      return { icon: ev.ok ? "✓" : "✗", textKey: "ui.doctor.ev.channel-result", params: { provider: String(ev.provider ?? ""), channel: String(ev.channel ?? ""), level: String(ev.level ?? ""), ms: String(ev.ms ?? "") }, tone: ev.ok ? "ok" : "bad" };
    case "verdict-confirmed":
      return { icon: ev.confirmed ? "★" : "○", textKey: "ui.doctor.ev.verdict-confirmed", params: { provider: String(ev.provider ?? ""), verdict: String(ev.verdict ?? ""), sourcesOk: String(ev.sourcesOk ?? "") }, tone: ev.confirmed ? "ok" : "warn" };
    case "advice-update":
      return { icon: "💡", textKey: "ui.doctor.ev.advice-update", params: { note: String(ev.note ?? "") }, tone: "warn" };
    case "phase-end":
      return { icon: "■", textKey: "ui.doctor.ev.phase-end", params: { phase: String(ev.phase ?? ""), summary: String(ev.summary ?? "") }, tone: "dim" };
    case "summary":
      return { icon: "📋", textKey: "ui.doctor.ev.summary", tone: "ok" };
    case "done":
      return { icon: "✔", textKey: "ui.doctor.ev.done", tone: "ok" };
    case "error":
      return { icon: "⚠", textKey: "ui.doctor.ev.error", params: { message: String(ev.message ?? "") }, tone: "bad" };
    case "cancelled":
      return { icon: "⏹", textKey: "ui.doctor.ev.cancelled", tone: "warn" };
    default:
      return { icon: "·", textKey: "ui.doctor.ev.unknown", params: { type: String(ev.type ?? "") }, tone: "dim" };
  }
}

export interface AdviceCardView {
  /** 排序分（score，调用方按此降序）。 */
  rank: number;
  /** 角标 i18n key：实测确认 ✓ / 单源未确认 / 未实测。 */
  badgeKey: string;
  /** 角标语气（映射到双端各自的 ok/warn/dim 样式）。 */
  tone: NetcheckTone;
  /** 建议条目 id（透传，客户端锚定用）。 */
  key: string;
}

/** Advice（设计稿 §5.7）→ 卡片角标与排序数据（confirmed/untested 规则单源）。 */
export function adviceView(a: { id?: string; score?: number; confidence?: string; confirmed?: boolean }): AdviceCardView {
  const score = typeof a.score === "number" && Number.isFinite(a.score) ? a.score : 0;
  const confirmed = !!a.confirmed;
  const untested = !a.confidence || a.confidence === "none";
  const badgeKey = untested ? "ui.doctor.advice.untested" : confirmed ? "ui.doctor.advice.confirmed" : "ui.doctor.advice.unconfirmed";
  const tone: NetcheckTone = confirmed ? "ok" : untested ? "dim" : "warn";
  return { rank: score, badgeKey, tone, key: String(a.id ?? "") };
}

// ─────────────────────────────────────────────────────────────────────────────
// browser mount — dist/ui-shared.js 以 <script type="module"> 加载时把全部导出
// 挂到 globalThis（core.js 经 window.__stShared 取用；Node 侧无 window，跳过）。
// ─────────────────────────────────────────────────────────────────────────────

const exportsTable = {
  modeOf,
  fmtAddr,
  fmtBytes,
  identityView,
  ddnsBadge,
  netcheckEventView,
  adviceView,
};
type ExportsTable = typeof exportsTable;

declare global {
  // eslint-disable-next-line no-var
  var __stShared: ExportsTable | undefined;
}

if (typeof globalThis !== "undefined" && typeof (globalThis as { window?: unknown }).window !== "undefined") {
  globalThis.__stShared = exportsTable;
}
