/**
 * pi-web integration example — how a long-lived app (like pi-web) embeds
 * service-tunnels in library mode with SITE isolation (sites-design.md).
 *
 * Scenario (R5): pi-web itself and its subprocess dev servers live in two
 * SEPARATE auth realms — different domains, different user dbs, different
 * providers. Library mode: the manager runs INSIDE the caller's process;
 * helpers become the caller's descendants; discovery scopes to the caller's
 * process tree.
 */
import { createServiceTunnels } from "../src/index.ts";
import type { ServicePortInfo, TunnelInfo, SiteConfig } from "../src/index.ts";

interface PiWebServices {
  listServices(): ServicePortInfo[];
  /** Preset the two auth realms (idempotent). */
  ensureSites(): void;
  /** pi-web's own UI under site "pi-web" (its own users). */
  exposeSelf(port: number, opts?: { tunnel?: boolean }): Promise<{ localUrl?: string; url?: string | null }>;
  /** A subprocess dev server under site "services" (separate users). */
  exposeService(port: number, opts?: { tunnel?: boolean }): Promise<{ localUrl?: string; url?: string | null }>;
  tunnelStatus(): TunnelInfo[];
  stopAll(): Promise<void>;
}

export function connectPiWebServices(opts?: {
  /** Override dirs (defaults to ~/.config + ~/.cache/service-tunnels). */
  configDir?: string;
  cacheDir?: string;
  /** e.g. { ngrok: "/opt/ngrok" } — beats PATH and auto-download. */
  toolPaths?: Record<string, string>;
}): PiWebServices {
  const st = createServiceTunnels({
    configDir: opts?.configDir,
    cacheDir: opts?.cacheDir,
    toolPaths: opts?.toolPaths,
  });

  /** Preset the two auth realms (idempotent; user-managed sites win). */
  function ensureSites(): void {
    const presets: Record<string, Omit<SiteConfig, "name">> = {
      // pi-web's own admin UI — full-featured portal, its own users
      "pi-web": { provider: "portal", domain: "web.pi.example.com", policy: "two_factor" },
      // pi-web subprocess dev servers — light basic auth, separate users
      services: { provider: "basic", domain: "dev.pi.example.com" },
    };
    const existing = st.sites.list().map((s) => s.name);
    for (const [name, cfg] of Object.entries(presets)) {
      if (!existing.includes(name)) {
        try {
          st.sites.add(name, cfg);
        } catch {
          // name conflict (e.g. user registered it differently) — keep user's
        }
      }
    }
  }

  return {
    listServices: () => st.discovery.getPorts(),

    ensureSites,

    exposeSelf: async (port, o = {}) => {
      const res = await st.auth.expose(port, {
        mode: o.tunnel ? "both" : "proxy",
        site: "pi-web",
        auth: true,
        tunnelType: "cloudflared",
      });
      // → http://<port>-pi-web.st.localhost:4180  (local)
      // → http://<port>.web.pi.example.com       (site domain, portless)
      // → https://<random>.trycloudflare.com     (tunnel, when o.tunnel)
      return { localUrl: res.localUrl, url: res.url };
    },

    exposeService: async (port, o = {}) => {
      const res = await st.auth.expose(port, {
        mode: o.tunnel ? "both" : "proxy",
        site: "services",
        auth: true,
        tunnelType: "cloudflared",
      });
      // → http://<port>-services.st.localhost:4180  (local)
      // → http://<port>.dev.pi.example.com         (site domain, portless)
      return { localUrl: res.localUrl, url: res.url };
    },

    tunnelStatus: () => st.tunnels.list(),

    stopAll: async () => {
      await st.shutdown();
    },
  };
}

// ── usage (inside pi-web's server) ──────────────────────────────────────────
// const services = connectPiWebServices({
//   cacheDir: join(os.homedir(), ".pi", "service-tunnels"),
// });
// services.ensureSites();                                  // pi-web + services realms
// services.exposeSelf(3000);                               // pi-web admin (own users)
// services.exposeService(5173, { tunnel: true });          // dev server (separate users)
// const users = await st.auth.users(undefined, "services"); // per-realm user mgmt
//
// ACTUAL pi-web integration (landed 2026-08-04):
//   pi-web/lib/service-tunnels-integration.ts  — process-level singleton
//   pi-web/app/api/service-tunnels/route.ts     — GET status / POST expose
// pi-web imports the sibling checkout's source directly (next dev SWC
// compiles the TS); a released integration should use the npm package.
