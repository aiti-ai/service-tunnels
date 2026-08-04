/**
 * Child-process environment markers.
 *
 * - SERVICE_TUNNELS_MARKER: stamped at library init and inherited by every
 *   spawned child. /proc/<pid>/environ never contains the owner's own marker
 *   (environ reflects env at exec time), so a marker hit is always a spawned
 *   descendant — even one re-parented by daemonization (nohup/setsid/double
 *   fork). Used by discovery to find framework-spawned processes.
 * - SERVICE_TUNNELS_ROLE: stamped on framework helper processes (nginx,
 *   authelia, redis, tunnels). Discovery EXCLUDES role carriers so framework
 *   ports never surface as user test services (they live in the internal
 *   registry instead). Tunnel processes do not listen locally, but the role
 *   filter keeps them out of the tree scan regardless.
 */
export const MARKER_ENV = "SERVICE_TUNNELS_MARKER";
export const ROLE_ENV = "SERVICE_TUNNELS_ROLE";

let currentMarker = process.env[MARKER_ENV] ?? "";

/** Ensure a marker exists (idempotent, survives hot reloads). */
export function ensureMarker(prefix = "service-tunnels"): string {
  if (!currentMarker) {
    currentMarker = `${prefix}-${process.pid}-${Date.now().toString(36)}`;
    process.env[MARKER_ENV] = currentMarker;
  }
  return currentMarker;
}

export function getMarker(): string {
  return currentMarker;
}

export const ROLES = {
  NGINX: "nginx",
  AUTHELIA: "authelia",
  REDIS: "redis",
  TUNNEL: "tunnel",
} as const;

/** Stamp a helper process role before spawning (child inherits it). */
export function roleEnv(role: string): Record<string, string> {
  return { [ROLE_ENV]: role, [MARKER_ENV]: getMarker() };
}
