import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { TunnelConfig } from "./tunnels.ts";

/** tunnels.json — fixed config listing the operator's tunnels
 *  (~/.config/service-tunnels/tunnels.json). Runtime state lives in
 *  state.json; this file is the declarative definition. */

export function tunnelsConfigPath(configDir: string): string {
  return join(configDir, "tunnels.json");
}

export function readTunnelConfigs(configDir: string): TunnelConfig[] {
  try {
    const raw = readFileSync(tunnelsConfigPath(configDir), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is TunnelConfig => c && typeof c.name === "string" && typeof c.type === "string",
    );
  } catch {
    return [];
  }
}

export function writeTunnelConfigs(configDir: string, cfgs: TunnelConfig[]): void {
  const file = tunnelsConfigPath(configDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfgs, null, 2) + "\n", "utf8");
  chmodSync(tmp, 0o600); // config may hold frp tokens etc.
  renameSync(tmp, file);
}
