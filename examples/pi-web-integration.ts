/**
 * pi-web integration example — how a long-lived app (like pi-web) embeds
 * service-tunnels in library mode.
 *
 * Library mode: the manager runs INSIDE the caller's process. Helpers become
 * the caller's descendants; discovery scopes to the caller's process tree;
 * the internal registry keeps framework ports (nginx/authelia/redis) out of
 * the user-service discovery results. No daemon needed.
 */
import { createServiceTunnels } from "../src/index.ts";
import type { ServicePortInfo, TunnelInfo } from "../src/index.ts";

interface PiWebServices {
  listServices(): ServicePortInfo[];
  expose(port: number, opts?: { auth?: boolean }): Promise<{ url: string | null }>;
  tunnelStatus(): TunnelInfo[];
  stopAll(): Promise<void>;
}

export function connectPiWebServices(opts?: {
  /** Override dirs (defaults to ~/.config + ~/.cache/service-tunnels). */
  configDir?: string;
  cacheDir?: string;
  /** Extra cmdline patterns identifying pi-web's own processes (never services). */
  excludeCmdline?: RegExp[];
  /** e.g. { ngrok: "/opt/ngrok" } — beats PATH and auto-download. */
  toolPaths?: Record<string, string>;
}): PiWebServices {
  const st = createServiceTunnels({
    configDir: opts?.configDir,
    cacheDir: opts?.cacheDir,
    toolPaths: opts?.toolPaths,
  });

  return {
    /** User test services only — framework ports live in st.internal.list(). */
    listServices: () => st.discovery.getPorts({ excludeCmdline: opts?.excludeCmdline }),

    /** One-shot expose; --auth wraps the app in nginx+Authelia. */
    expose: async (port, o = {}) => {
      const res = await st.auth.expose(port, {
        auth: o.auth ?? false,
        tunnelType: "cloudflared", // or ngrok / ssh / ...
      });
      return { url: res.url };
    },

    tunnelStatus: () => st.tunnels.list(),

    stopAll: async () => {
      await st.tunnels.stopAll();
    },
  };
}

// ── usage (inside pi-web's server) ──────────────────────────────────────────
// const services = connectPiWebServices({
//   cacheDir: join(os.homedir(), ".pi", "service-tunnels"),
//   excludeCmdline: [/next[\\/]dist[\\/]bin[\\/]next/, /pi-web/],
// });
// const ports = services.listServices();          // services dialog
// const { url } = await services.expose(5173, { auth: true }); // one-click
//
// ACTUAL pi-web integration (landed 2026-08-04):
//   pi-web/lib/service-tunnels-integration.ts  — process-level singleton
//   pi-web/app/api/service-tunnels/route.ts     — GET status / POST expose
// pi-web imports the sibling checkout's source directly (next dev SWC
// compiles the TS); a released integration should use the npm package.
