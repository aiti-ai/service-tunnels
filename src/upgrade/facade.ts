// src/upgrade/facade.ts - typed bridge to the vendored CJS upgrade-assistant core
// (src/upgrade/vendor → dist/upgrade/vendor via copy-vendor.mjs; the vendored directory
// carries its own package.json {"type":"commonjs"} inside this ESM package — the same
// pattern as src/ssh/vendor.ts).
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { readdirSync, readFileSync } from "fs";
import path from "path";

const here = path.dirname(fileURLToPath(import.meta.url));
const requireCjs = createRequire(import.meta.url);

type VendorCore = { main: (argv: string[], opts?: { stEntry?: string }) => Promise<void>; VERSION: string };
type VendorService = {
  serviceAction: (verb: string, configPath: string, opts?: object) => Promise<unknown>;
  restartPipeline: (configPath: string, opts?: { runId?: string }) => Promise<{ final: string; runDir: string }>;
  pipelineStatus: (runId?: string) => unknown;
};

function vendorCore(): VendorCore {
  return requireCjs(path.join(here, "vendor", "core.js")) as VendorCore;
}
function vendorService(): VendorService {
  return requireCjs(path.join(here, "vendor", "service.js")) as VendorService;
}

export const upgradeVersion = (): string => vendorCore().VERSION;

/** `st upgrade run`: boot the self-isolating assistant (returns after the handoff;
 *  the isolated copy continues detached and reports via its status page / history). */
export async function upgradeRun(
  argv: string[],
  opts?: { stEntry?: string },
): Promise<void> {
  await vendorCore().main(argv, opts);
}

/** `st service <verb>`: service-form verbs via the matrix-calibrated manager chain. */
export async function servicePipelineRun(
  configPath: string,
  opts?: { runId?: string },
): Promise<{ final: string; runDir: string }> {
  return vendorService().restartPipeline(path.resolve(configPath), opts);
}

export function servicePipelineStatus(runId?: string): unknown {
  return vendorService().pipelineStatus(runId);
}

export async function serviceAction(
  verb: string,
  configPath: string,
  opts?: { manager?: string; tail?: number; restartPipeline?: boolean; env?: Record<string, string>; onLine?: (s: string) => void },
): Promise<unknown> {
  return vendorService().serviceAction(verb, path.resolve(configPath), opts);
}

export type UpgradeStatusSummary = {
  state: "idle" | "running" | "leftover-lock" | "unknown";
  lock: LockShape | null;
  live: { port: number; statusUrl: string } | null;
  lastReport: { file: string; finalState?: string; finishedAt?: string; target?: string } | null;
};

type LockShape = {
  pid?: number;
  phase?: string;
  state?: string;
  runDir?: string;
  port?: number;
  ts?: string;
};

/** `st upgrade status`: live run (via the lock's management port), leftover lock, and
 *  the most recent persisted report (~/.svc-assistant/history/<ts>.json). */
export async function upgradeStatus(): Promise<UpgradeStatusSummary> {
  const base = path.join(process.env.HOME || process.env.USERPROFILE || "", ".svc-assistant");
  const out: UpgradeStatusSummary = { state: "unknown", lock: null, live: null, lastReport: null };

  const lockFile = path.join(base, "lock.json");
  try {
    out.lock = JSON.parse(readFileSync(lockFile, "utf8")) as LockShape;
  } catch {
    out.lock = null;
  }

  if (out.lock?.pid) {
    let alive = false;
    try {
      process.kill(out.lock.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) {
      out.state = "running";
      if (out.lock.port) {
        out.live = { port: out.lock.port, statusUrl: `http://127.0.0.1:${out.lock.port}/?tk=` };
      }
    } else {
      out.state = "leftover-lock";
    }
  } else {
    out.state = "idle";
  }

  const historyDir = path.join(base, "history");
  try {
    const files = readdirSync(historyDir).filter((f) => f.endsWith(".json")).sort().reverse();
    if (files[0]) {
      const full = path.join(historyDir, files[0]);
      const doc = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
      out.lastReport = {
        file: full,
        finalState: doc.finalState as string | undefined,
        finishedAt: doc.finishedAt as string | undefined,
        target: doc.target as string | undefined,
      };
    }
  } catch {
    /* no history yet */
  }
  // newest report newer than the lock => the lock is a stale leftover of a finished run
  if (out.state === "leftover-lock" && out.lastReport?.finishedAt) {
    const finished = Date.parse(out.lastReport.finishedAt);
    const locked = out.lock?.ts ? Date.parse(out.lock.ts) : NaN;
    if (Number.isFinite(finished) && Number.isFinite(locked) && finished > locked) {
      out.state = "idle";
      out.lock = null;
    }
  }
  return out;
}
