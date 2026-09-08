/**
 * ui-doctor — 网络体检（netcheck）UI 骨架：job 单例 + SSE 事件流。
 *
 * 库 netcheck 实现未落（设计稿 docs/netcheck-design.md 已定稿）。本模块把
 * 双端契约先冻在 UI 侧：
 *   - 事件形状 NetcheckEvent（设计稿 §5.1），渲染统一走 ui-shared.ts
 *     netcheckEventView()（键名 ui.doctor.ev.<type>）；
 *   - POST /api/doctor-start（409 单例）/ POST /api/doctor-stop /
 *     GET /api/doctor-events（SSE：Last-Event-ID 环形缓冲 500 续传、心跳 20s、
 *     连接上限 8 → 503）。
 *
 * 事件源：st.netcheck.run(opts, onEvent) 存在即真实接入；否则 mock 序列
 * （200ms/事件）。**mock 仅在 ST_UI_DOCTOR_MOCK=1 时对 UI 开放**（/api/status
 * 的 netcheck 能力位同步点亮）——生产默认隐藏 doctor tab，实现落库后自动切换
 * 真实事件源，UI 零改动。
 */
import type { ServerResponse } from "http";
import type { ServiceTunnels } from "./index.ts";

export type DoctorEvent = { type: string } & Record<string, unknown>;

interface BufferEntry { id: number; ev: DoctorEvent }

interface Subscriber {
  id: number;
  write(frame: string): void;
  close(): void;
}

interface NetcheckLike {
  run?: (opts: { mode?: string }, onEvent: (ev: DoctorEvent) => void) => Promise<unknown>;
}

export interface DoctorHub {
  start(opts?: { mode?: string }): Promise<{ started: boolean; mock: boolean }>;
  stop(): void;
  subscribe(res: ServerResponse, lastEventId?: string): boolean;
  subscriberCount(): number;
  running(): boolean;
}

/** mock 模式开关（dev/test 专用；生产不设 → doctor tab 隐藏）。 */
export function doctorMockEnabled(): boolean {
  return process.env.ST_UI_DOCTOR_MOCK === "1";
}

/** netcheck 能力探测：真实实现优先，mock 开关兜底（仅 UI 门控用）。 */
export function doctorAvailable(st: ServiceTunnels): boolean {
  return typeof (st as { netcheck?: NetcheckLike }).netcheck?.run === "function" || doctorMockEnabled();
}

const MAX_SUBSCRIBERS = 8;
const MAX_BUFFER = 500;
const HEARTBEAT_MS = 20_000;

export function createDoctorHub(st: ServiceTunnels): DoctorHub {
  const buffer: BufferEntry[] = [];
  const subs = new Set<Subscriber>();
  let seq = 0;
  let jobRunning = false;
  let jobCancelled = false;

  function emit(ev: DoctorEvent): void {
    seq += 1;
    buffer.push({ id: seq, ev });
    if (buffer.length > MAX_BUFFER) buffer.shift();
    const frame = `id: ${seq}\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const s of subs) {
      try { s.write(frame); } catch { subs.delete(s); }
    }
  }

  async function start(opts: { mode?: string } = {}): Promise<{ started: boolean; mock: boolean }> {
    if (jobRunning) {
      throw Object.assign(new Error("doctor job already running"), { code: "conflict" });
    }
    jobRunning = true;
    jobCancelled = false;
    const netcheck = (st as { netcheck?: NetcheckLike }).netcheck;
    if (netcheck && typeof netcheck.run === "function") {
      void netcheck
        .run({ mode: opts.mode === "full" ? "full" : "quick" }, emit)
        .catch((e) => emit({ type: "error", message: String(e) }))
        .finally(() => { jobRunning = false; });
      return { started: true, mock: false };
    }
    void runMock();
    return { started: true, mock: true };
  }

  /** mock 事件序列（quick 形态：画像 → 初步建议 → 实测 → 确认 → 汇总）。 */
  async function runMock(): Promise<void> {
    const events: DoctorEvent[] = [
      { type: "phase-start", phase: "A", label: "Environment", total: 3 },
      { type: "probe-done", probeId: "a2", item: "Egress IPv4", verdict: "ok", ok: true, ms: 120 },
      { type: "probe-done", probeId: "a3", item: "Egress IPv6", verdict: "unavailable", ok: false, ms: 80 },
      { type: "probe-done", probeId: "a9", item: "Gateway UPnP", verdict: "ok", ok: true, ms: 900 },
      { type: "phase-end", phase: "A", summary: "3 probes" },
      { type: "advice-update", advice: mockAdvice(false), basis: "probe", note: "initial (probes only)" },
      { type: "phase-start", phase: "C", label: "Live tests", total: 2 },
      { type: "tunnel-est", provider: "serveo", url: "https://example.serveo.net", ms: 3200 },
      { type: "channel-result", provider: "serveo", channel: "check-host", level: "E1", ok: true, ms: 90 },
      { type: "verdict-confirmed", provider: "serveo", verdict: "E1+", confirmed: true, sourcesOk: 2 },
      { type: "tunnel-est", provider: "localtunnel", url: "https://example.loca.lt", ms: 1800 },
      { type: "tunnel-fail", provider: "bore", error: "connect timeout", ms: 30_000 },
      { type: "advice-update", advice: mockAdvice(true), basis: "live", note: "after live tests" },
      { type: "phase-end", phase: "C", summary: "2/3 providers usable" },
      { type: "summary", report: mockReport(), text: "netcheck report (mock)", markdown: "# Netcheck report (mock)\n" },
      { type: "done", report: mockReport() },
    ];
    for (const ev of events) {
      if (jobCancelled) {
        emit({ type: "cancelled" });
        jobRunning = false;
        return;
      }
      emit(ev);
      await new Promise((r) => setTimeout(r, 200));
    }
    jobRunning = false;
  }

  function stop(): void {
    if (jobRunning) jobCancelled = true;
  }

  function subscribe(res: ServerResponse, lastEventId?: string): boolean {
    if (subs.size >= MAX_SUBSCRIBERS) return false;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
    });
    const sub: Subscriber = {
      id: seq,
      write: (f) => res.write(f),
      close: () => {
        if (!subs.has(sub)) return;
        subs.delete(sub);
        clearInterval(beat);
        try { res.end(); } catch { /* already gone */ }
      },
    };
    subs.add(sub);
    res.write(": connected\n\n");
    // Last-Event-ID 续传：重放缓冲中 id 更大的事件（EventSource 重连自动带）
    const last = Number(lastEventId ?? 0) || 0;
    if (last > 0) {
      for (const entry of buffer) {
        if (entry.id > last) {
          try { res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.ev)}\n\n`); } catch { break; }
        }
      }
    }
    const beat = setInterval(() => {
      try { res.write(": hb\n\n"); } catch { sub.close(); }
    }, HEARTBEAT_MS);
    res.on("close", () => sub.close());
    return true;
  }

  return {
    start,
    stop,
    subscribe,
    subscriberCount: () => subs.size,
    running: () => jobRunning,
  };
}

function mockAdvice(live: boolean): Array<Record<string, unknown>> {
  return live
    ? [
        { id: "serveo", score: 70, confidence: "E1+", confirmed: true, title: "serveo (tested)", why: ["E1+ confirmed by 2 sources"], cmd: "st expose 3000 --tunnel serveo" },
        { id: "ipv6", score: 60, confidence: "none", confirmed: false, title: "ipv6 direct", why: ["no global IPv6 detected"], cmd: "" },
      ]
    : [
        { id: "ipv6", score: 70, confidence: "none", confirmed: false, title: "ipv6 direct (untested)", why: ["probes only"], cmd: "st expose 3000 --mode ipv6" },
        { id: "serveo", score: 55, confidence: "none", confirmed: false, title: "serveo (untested)", why: ["free, no account"], cmd: "st expose 3000 --tunnel serveo" },
      ];
}

function mockReport(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    meta: { startedAt: new Date().toISOString(), durationMs: 4200, mode: "quick", tool: { version: "mock" } },
    environment: { os: process.platform, nat: "unknown", netClass: "open", hasGlobalIpv6: false, egressIpv4Consistent: true, dns: [], tools: [] },
    endpoints: [],
    liveTests: [],
    advice: mockAdvice(true),
    channelsUsed: [],
  };
}
