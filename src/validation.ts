import type { TunnelConfig, TunnelType } from "./tunnels.ts";
import { isCustomTunnelType } from "./tunnels-custom.ts";

/**
 * Tunnel config input validation — the single choke point for every user-
 * supplied value that reaches a tunnel process (CLI / UI / daemon RPC /
 * persisted tunnels.json / library callers).
 *
 * Threat model (docs/input-validation-security.md):
 * - Shell injection is already impossible (all built-in tunnels spawn with
 *   `shell: false`, args/env only) — this module closes the REAL gaps:
 *   1. ssh/serveo OPTION injection: host/user starting with "-" is parsed by
 *      OpenSSH as an option → `-oProxyCommand=...` = local RCE.
 *   2. frpc INI injection: newline/control chars in token/server/domain would
 *      inject config lines into the generated .ini.
 *   3. tunnel-name path traversal: `../` in a name escapes the cache dir when
 *      the name is interpolated into the frpc ini filename.
 *   4. garbage values (ports, types, null bytes in args/env) reaching spawn.
 *
 * Fail-closed: every validator throws (TunnelConfigError) — never sanitize
 * silently. `command` type stays allowed at the library level (explicit API
 * use); the daemon RPC boundary additionally requires the explicit
 * `dangerous: true` opt-in (see daemon-server.ts).
 */

export class TunnelConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "TunnelConfigError";
  }
}

/** Control characters + DEL — the frpc INI / argv injection primitive. */
const CONTROL_RE = /[\x00-\x1f\x7f]/;
/** Null byte only — the one character that breaks spawn argv/env/command. */
const NULL_RE = /\x00/;

/** Tunnel name: letters/digits/._- , no leading dot (hidden files), no path
 *  separators → safe to interpolate into filenames and IPC paths. */
export const TUNNEL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/** Hostname / IPv4 literal. Rejects "-" prefix (ssh option injection) and
 *  any path/whitespace/control characters. */
export const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
/** SSH username: no "-" prefix (would become an ssh option), no "@" (would
 *  corrupt user@host), no path chars. */
export const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
/** Domain / subdomain for --domain / --hostname / --subdomain / INI. */
export const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

export const TUNNEL_TYPES: readonly TunnelType[] = [
  "ngrok",
  "frpc",
  "ssh",
  "serveo",
  "cloudflared",
  "localtunnel",
  "bore",
  "natapp",
  "command",
];

/** Validate a tunnel name (used for state keys AND file names). */
export function validateTunnelName(name: unknown): string {
  if (typeof name !== "string" || !TUNNEL_NAME_RE.test(name)) {
    throw new TunnelConfigError(
      `invalid tunnel name ${JSON.stringify(name)} (letters/digits/._- , ≤64 chars, no path separators)`,
    );
  }
  return name;
}

/** Validate an ssh host / server host. The "-" prefix check is the hard
 *  security boundary: OpenSSH parses ANY "-"-prefixed argv as an option. */
export function validateHost(host: unknown, label = "host"): string {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) {
    throw new TunnelConfigError(`invalid ${label}: ${JSON.stringify(host)}`);
  }
  if (host.startsWith("-")) {
    throw new TunnelConfigError(
      `invalid ${label} ${JSON.stringify(host)}: must not start with "-" (ssh option injection)`,
    );
  }
  if (CONTROL_RE.test(host)) {
    throw new TunnelConfigError(`invalid ${label}: control characters are not allowed`);
  }
  if (!HOSTNAME_RE.test(host)) {
    throw new TunnelConfigError(`invalid ${label}: ${JSON.stringify(host)} (expected hostname or IP)`);
  }
  return host;
}

/** Validate an ssh/serveo username (dest = user@host). */
export function validateUser(user: unknown): string {
  if (typeof user !== "string" || user.length === 0 || user.length > 64) {
    throw new TunnelConfigError(`invalid user: ${JSON.stringify(user)}`);
  }
  if (user.startsWith("-")) {
    throw new TunnelConfigError(`invalid user ${JSON.stringify(user)}: must not start with "-" (ssh option injection)`);
  }
  if (CONTROL_RE.test(user)) {
    throw new TunnelConfigError("invalid user: control characters are not allowed");
  }
  if (!USERNAME_RE.test(user)) {
    throw new TunnelConfigError(`invalid user: ${JSON.stringify(user)}`);
  }
  return user;
}

/** Validate a domain / subdomain value. */
export function validateDomain(domain: unknown): string {
  if (typeof domain !== "string" || domain.length === 0 || domain.length > 253) {
    throw new TunnelConfigError(`invalid domain: ${JSON.stringify(domain)}`);
  }
  if (CONTROL_RE.test(domain)) {
    throw new TunnelConfigError("invalid domain: control characters are not allowed");
  }
  if (!DOMAIN_RE.test(domain)) {
    throw new TunnelConfigError(`invalid domain: ${JSON.stringify(domain)}`);
  }
  return domain;
}

/** Validate a token / secret. Deliberately permissive on characters (real
 *  tokens are base64/hex/arbitrary) — only control chars and absurd lengths
 *  are rejected. That alone closes the frpc INI line-injection vector. */
export function validateToken(token: unknown, label = "token"): string {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
    throw new TunnelConfigError(`invalid ${label}: ${JSON.stringify(token)}`);
  }
  if (CONTROL_RE.test(token)) {
    throw new TunnelConfigError(`invalid ${label}: control characters are not allowed (newline would inject config lines)`);
  }
  return token;
}

/** Validate a TCP port. */
export function validatePort(n: unknown, label = "port"): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isInteger(v) || v < 1 || v > 65535) {
    throw new TunnelConfigError(`invalid ${label}: ${JSON.stringify(n)} (expected integer 1-65535)`);
  }
  return v;
}

/** Validate `host[:port]` / `[ipv6][:port]` server addresses. */
export function validateServer(server: unknown): string {
  if (typeof server !== "string" || server.length === 0 || server.length > 253) {
    throw new TunnelConfigError(`invalid server: ${JSON.stringify(server)}`);
  }
  if (CONTROL_RE.test(server)) {
    throw new TunnelConfigError("invalid server: control characters are not allowed");
  }
  if (server.startsWith("[")) {
    // [ipv6][:port]
    const m = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(server);
    if (!m) throw new TunnelConfigError(`invalid server: ${JSON.stringify(server)}`);
    if (m[2]) validatePort(Number(m[2]), "server port");
    return server;
  }
  const parts = server.split(":");
  if (parts.length > 2 || parts.some((p) => p.length === 0)) {
    throw new TunnelConfigError(`invalid server: ${JSON.stringify(server)} (expected host[:port])`);
  }
  validateHost(parts[0]!, "server host");
  if (parts[1]) validatePort(Number(parts[1]), "server port");
  return server;
}

/** Validate a raw shell command (type "command"). Only null bytes and
 *  emptiness are rejected — multi-line shell is legal. */
export function validateCmd(cmd: unknown): string {
  if (typeof cmd !== "string" || cmd.length === 0 || cmd.length > 8192) {
    throw new TunnelConfigError(`invalid command: ${JSON.stringify(cmd)}`);
  }
  if (NULL_RE.test(cmd)) {
    throw new TunnelConfigError("invalid command: null bytes are not allowed");
  }
  return cmd;
}

// ── Auth-provider parameter validation (docs/input-validation-security.md) ──
//
// Auth-provider params have the SAME injection surface as tunnel params, just
// aimed at config files instead of argv:
//   - oauth2-proxy: OIDC params interpolated into a TOML config (unquoted /
//     double-quoted strings) → TOML injection (same class as the frpc INI).
//   - authelia: usernames become YAML keys + totp export FILENAMES (path
//     traversal); displayName/email interpolated into YAML strings.
//   - basic: usernames become htpasswd LINES (`name:hash` — a `:` or newline
//     in a name injects a fake user).
// Root fix: validate the username (single charset, no separators) at every
// UserManager.addUser + escape values where they land in config files.

/** Auth username: letters/digits/._- , ≤64 chars, no `:` (htpasswd line
 *  separator), no path separators (YAML key + totp export filename), no
 *  control chars. This is the root fix for the YAML/htpasswd/filename
 *  injection surfaces (basic/authelia). */
export function validateUserName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 64 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new TunnelConfigError(
      `invalid user name ${JSON.stringify(name)} (letters/digits/._- , ≤64 chars — must stay safe as a YAML key / htpasswd line / file name)`,
    );
  }
  return name;
}

/** Display name: cosmetic — only control chars and absurd length rejected. */
export function validateDisplayName(name: unknown): string | undefined {
  if (name === undefined || name === null) return undefined;
  const v = String(name);
  if (v.length > 128 || CONTROL_RE.test(v)) {
    throw new TunnelConfigError(`invalid display name: control characters or >128 chars`);
  }
  return v;
}

/** Email: no control chars, no whitespace, sane length. */
export function validateEmail(email: unknown): string | undefined {
  if (email === undefined || email === null) return undefined;
  const v = String(email);
  if (v.length === 0 || v.length > 256 || CONTROL_RE.test(v) || /\s/.test(v)) {
    throw new TunnelConfigError(`invalid email: ${JSON.stringify(v)}`);
  }
  return v;
}

/** OIDC URL (issuerUrl) — must be http(s), no control chars. */
export function validateOidcUrl(url: unknown, label = "oidc.issuerUrl"): string {
  const v = typeof url === "string" ? url : "";
  if (v.length === 0 || v.length > 2048 || CONTROL_RE.test(v)) {
    throw new TunnelConfigError(`invalid ${label}: ${JSON.stringify(url)}`);
  }
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
  } catch {
    throw new TunnelConfigError(`invalid ${label}: ${JSON.stringify(url)} (expected http(s) URL)`);
  }
  return v;
}

/** OIDC client id/secret — no control chars, sane length (they end up inside
 *  a quoted TOML string). */
export function validateOidcSecret(v: unknown, label: string): string {
  const s = typeof v === "string" ? v : "";
  if (s.length === 0 || s.length > 4096 || CONTROL_RE.test(s)) {
    throw new TunnelConfigError(`invalid ${label}: control characters or empty`);
  }
  return s;
}

/** Escape a value for a TOML double-quoted string (" and \ must be escaped).
 *  Control characters are rejected BEFORE this by the validators. */
export function tomlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Escape a value for a YAML double-quoted string (\ and " escaped). */
export function yamlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Validate the oauth2-proxy oidc option block (schema-driven provider
 *  params + config.json auth.oidc). Throws on anything that would break the
 *  generated TOML config or alter its structure. */
export function validateOidcOptions(oidc: {
  issuerUrl?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  cookieSecret?: unknown;
}): void {
  validateOidcUrl(oidc?.issuerUrl);
  validateOidcSecret(oidc?.clientId, "oidc.clientId");
  validateOidcSecret(oidc?.clientSecret, "oidc.clientSecret");
  if (oidc?.cookieSecret !== undefined && oidc?.cookieSecret !== null && oidc?.cookieSecret !== "") {
    validateOidcSecret(oidc.cookieSecret, "oidc.cookieSecret");
  }
}

/** Full config validation — called by TunnelManager.start() (fail-closed
 *  before ANY spawn) and by the daemon RPC `tunnel.add` boundary. `name` is
 *  used for error messages only (defaults to cfg.name). */
export function validateTunnelConfig(cfg: TunnelConfig | null | undefined, name?: string): void {
  const label = name ? `tunnel '${name}'` : "tunnel";
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new TunnelConfigError(`${label}: config must be an object`);
  }
  validateTunnelName(cfg.name);

  const type = cfg.type as string;
  if (!TUNNEL_TYPES.includes(type as TunnelType) && !isCustomTunnelType(type)) {
    throw new TunnelConfigError(`${label}: unsupported tunnel type ${JSON.stringify(type)} (valid: ${TUNNEL_TYPES.join(", ")} or a custom SERVICE_TUNNELS_TUNNEL_COMMAND_* type)`);
  }

  // Sweep: no control characters anywhere (INI/argv injection primitive).
  for (const field of ["domain", "server", "token", "host", "user"] as const) {
    const v = (cfg as unknown as Record<string, unknown>)[field];
    if (typeof v === "string" && CONTROL_RE.test(v)) {
      throw new TunnelConfigError(`${label}: ${field} contains control characters`);
    }
  }

  if (cfg.target !== undefined) validatePort(cfg.target, "target");
  if (cfg.port !== undefined) validatePort(cfg.port, "port");
  if (cfg.remotePort !== undefined) validatePort(cfg.remotePort, "remotePort");
  if (cfg.protocol !== undefined && !["http", "https", "tcp"].includes(cfg.protocol)) {
    throw new TunnelConfigError(`${label}: invalid protocol ${JSON.stringify(cfg.protocol)}`);
  }
  if (cfg.args !== undefined && !Array.isArray(cfg.args)) {
    throw new TunnelConfigError(`${label}: args must be an array`);
  }
  if (cfg.args) {
    for (const a of cfg.args) {
      if (typeof a !== "string" || NULL_RE.test(a)) {
        throw new TunnelConfigError(`${label}: args must be strings without null bytes`);
      }
    }
  }
  if (cfg.env !== undefined && (typeof cfg.env !== "object" || cfg.env === null || Array.isArray(cfg.env))) {
    throw new TunnelConfigError(`${label}: env must be an object`);
  }
  if (cfg.env) {
    for (const [k, v] of Object.entries(cfg.env)) {
      if (typeof v !== "string" || NULL_RE.test(v)) {
        throw new TunnelConfigError(`${label}: env values must be strings without null bytes`);
      }
      if (CONTROL_RE.test(k)) {
        throw new TunnelConfigError(`${label}: env keys must not contain control characters`);
      }
    }
  }

  // Custom command-tunnel types (SERVICE_TUNNELS_TUNNEL_COMMAND_*): the shell
  // template is operator-registered (that IS the opt-in), but its form params
  // are interpolated INTO the shell command at start — control characters in
  // ANY custom param would break/alter the command beyond the template.
  // Sweep every string field that isn't structurally handled above.
  if (isCustomTunnelType(type)) {
    const STRUCTURAL = new Set(["name", "type", "target", "port", "remotePort", "protocol", "args", "env", "cmd"]);
    for (const [k, v] of Object.entries(cfg)) {
      if (STRUCTURAL.has(k)) continue;
      if (typeof v === "string" && CONTROL_RE.test(v)) {
        throw new TunnelConfigError(`${label}: custom tunnel param "${k}" contains control characters`);
      }
    }
  }

  switch (type) {
    case "ssh": {
      if (!cfg.host) throw new TunnelConfigError(`${label}: type "ssh" requires host`);
      validateHost(cfg.host, "host");
      if (cfg.user) validateUser(cfg.user);
      break;
    }
    case "serveo": {
      if (cfg.host) validateHost(cfg.host, "host");
      if (cfg.user) validateUser(cfg.user);
      break;
    }
    case "ngrok":
    case "cloudflared":
    case "localtunnel":
    case "natapp": {
      if (cfg.domain) validateDomain(cfg.domain);
      if (cfg.token) validateToken(cfg.token);
      break;
    }
    case "frpc": {
      if (cfg.server) validateServer(cfg.server);
      if (cfg.token) validateToken(cfg.token, "frpc token");
      if (cfg.domain) validateDomain(cfg.domain);
      break;
    }
    case "bore": {
      if (cfg.server) validateServer(cfg.server);
      if (cfg.token) validateToken(cfg.token, "bore secret");
      break;
    }
    case "command": {
      if (!cfg.cmd) throw new TunnelConfigError(`${label}: command type requires cmd`);
      validateCmd(cfg.cmd);
      break;
    }
    default:
      // Custom env-registered command tunnels (SERVICE_TUNNELS_TUNNEL_COMMAND_*):
      // EVERY string field is user input heading into a shell command — the
      // known-field sweep above only covers the built-in field names, so sweep
      // all of them here too. Shell metacharacters are neutralised later by
      // single-quote escaping in resolveCustomCommand (tunnels-custom.ts);
      // this layer rejects the raw garbage (control chars) fail-closed.
      if (isCustomTunnelType(type)) {
        for (const [k, v] of Object.entries(cfg as unknown as Record<string, unknown>)) {
          if (typeof v === "string" && CONTROL_RE.test(v)) {
            throw new TunnelConfigError(`${label}: ${k} contains control characters (custom command tunnel)`);
          }
        }
      }
      break;
  }
}
