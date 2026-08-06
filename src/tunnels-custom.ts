import type { ParamSpec, TunnelConfig } from "./tunnels.ts";

/**
 * Custom command tunnel types — user-registered via environment variables:
 *
 *   SERVICE_TUNNELS_TUNNEL_COMMAND_<NAME>="ssh -R {{port}}:127.0.0.1:{{localport}} user@host"
 *
 * NAME (lowercased, letters/digits/_/-) becomes a tunnel type that appears
 * automatically in every schema-driven client (tunnel picker + param form),
 * just like the built-in types. The value is a shell command template whose
 * `{{token}}` placeholders become form parameters:
 *
 *   {{token}}        → required user input
 *   {{token:value}}  → optional, fixed default `value` (固定参数)
 *   {{localport}}    → auto-filled with the exposed local port (never shown
 *                      in the form); {{localport:PORT}} fixes it to PORT
 *
 * At start the template is assembled (resolveCustomCommand) and spawned
 * through the shell, exactly like the built-in `command` type. Registering
 * the env var IS the explicit opt-in, so custom types are NOT marked
 * `dangerous` — clients show them as ordinary (safe) picker options.
 *
 * URL RETURN: the tunnel's public URL is whatever the process prints.
 * Operators declare it explicitly by echoing a `ST_TUNNEL_URL:<url>` line
 * (see extractTunnelUrl in tunnels.ts) — `echo ST_TUNNEL_URL:https://x && <cmd>`
 * — which beats regex sniffing and works the same on Windows cmd/PowerShell.
 */

export const CUSTOM_TUNNEL_ENV_PREFIX = "SERVICE_TUNNELS_TUNNEL_COMMAND_";

/** Built-in tunnel type names — env registration must not shadow them. */
const BUILTIN_TUNNEL_TYPES = new Set([
  "ngrok",
  "frpc",
  "ssh",
  "serveo",
  "cloudflared",
  "localtunnel",
  "bore",
  "natapp",
  "command",
]);

/** Safe tunnel-type name charset (letters/digits/_-; no leading dash). */
const TYPE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** `{{token}}` / `{{token:default}}` placeholder parser. */
const TOKEN_RE = /\{\{([a-zA-Z0-9_.-]+)(?::([^}]*))?\}\}/g;

/** Parse every SERVICE_TUNNELS_TUNNEL_COMMAND_* var → { type: template }.
 *  Invalid names, built-in shadowing and empty templates are skipped with a
 *  warning (fail-safe: a typo'd env var must not silently become a type). */
export function customTunnelTemplates(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(CUSTOM_TUNNEL_ENV_PREFIX)) continue;
    const name = key.slice(CUSTOM_TUNNEL_ENV_PREFIX.length).toLowerCase();
    if (!TYPE_NAME_RE.test(name) || BUILTIN_TUNNEL_TYPES.has(name)) {
      console.warn(
        `[service-tunnels] skipping ${key}: invalid or conflicting tunnel type name "${name}"` +
          ` (expected letters/digits/_-, lowercase, not a built-in type)`,
      );
      continue;
    }
    const template = (value ?? "").trim();
    if (!template) {
      console.warn(`[service-tunnels] skipping ${key}: empty command template`);
      continue;
    }
    out[name] = template;
  }
  return out;
}

/** The shell template registered for a custom tunnel type (undefined for
 *  built-in / unknown types). */
export function customTunnelTemplate(type: string): string | undefined {
  return customTunnelTemplates()[type];
}

/** True when `type` is a user-registered custom command tunnel. */
export function isCustomTunnelType(type: string): boolean {
  return customTunnelTemplate(type) !== undefined;
}

/** Invoke cb(token, default?) for every placeholder in a template, in order. */
export function forEachTemplateToken(
  template: string,
  cb: (token: string, def: string | undefined) => void,
): void {
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(template))) {
    cb((m[1] ?? "").toLowerCase(), m[2] ?? undefined);
  }
}

/** Param schemas for ALL custom types (merged into tunnelParamSchemas()). */
export function customTunnelParamSchemas(): Record<string, ParamSpec[]> {
  const out: Record<string, ParamSpec[]> = {};
  for (const [type, template] of Object.entries(customTunnelTemplates())) {
    out[type] = customTunnelParamSchema(template);
  }
  return out;
}

/** Param schema for one custom type, generated from its template placeholders
 *  (template order preserved; duplicates collapsed; `localport` omitted — it
 *  is auto-filled from the exposed port). */
export function customTunnelParamSchema(template: string): ParamSpec[] {
  const seen = new Map<string, ParamSpec>();
  forEachTemplateToken(template, (token, def) => {
    if (token === "localport") return; // auto from the exposed target port
    if (seen.has(token)) return;
    const isNum = def !== undefined && /^-?\d+$/.test(def);
    seen.set(token, {
      key: token,
      label: token,
      type: isNum ? "number" : "string",
      ...(def !== undefined
        ? { default: isNum ? Number(def) : def, required: false }
        : { required: true }),
      description:
        def !== undefined
          ? `固定参数(默认 ${def}),替换模板中的 {{${token}}}`
          : `必填,替换模板中的 {{${token}}}`,
    });
  });
  return [...seen.values()];
}

/** Control characters + DEL — shell-command corruption / injection primitive.
 *  Mirrors validation.ts CONTROL_RE (kept local to avoid a runtime cycle). */
const CONTROL_RE = /[\x00-\x1f\x7f]/;

/** Single-quote a value into a shell word: `'` → `'\''` (POSIX rule). The
 *  result is ALWAYS a literal word — spaces, `$`, backticks, `;`, `|`, `&`,
 *  `"`, quotes etc. are inert inside single quotes, so a substituted value
 *  can never break out of the operator-written template into new shell syntax.
 *  Values are data, never shell fragments. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Fail-closed value check: control chars (incl. newline/NUL/DEL) are rejected
 *  outright — even though shellQuote would neutralise them, garbage like a
 *  multi-line value is almost certainly malicious or a broken client. */
function assertSafeShellValue(value: string, token: string, cfgName: string): void {
  if (CONTROL_RE.test(value)) {
    throw new Error(
      `tunnel '${cfgName}': parameter "{{${token}}}" contains control characters (rejected — would corrupt the shell command)`,
    );
  }
}

/** Assemble the final shell command for a custom type: substitute every
 *  placeholder from the TunnelConfig fields (spread tunnelParams),
 *  `{{localport}}` from the exposed target port, defaults from
 *  `{{token:value}}`. Throws when a required placeholder has no value.
 *
 *  SECURITY: every substituted value (user form input, template default, or
 *  the auto localport) is single-quote escaped (shellQuote) — the template is
 *  operator-trusted, the VALUES are not. Control characters are rejected
 *  fail-closed. The final command is spawned with shell:true by the tunnel
 *  manager; without this escaping a form value like `8080; rm -rf /` would
 *  become shell syntax and execute. */
export function resolveCustomCommand(type: string, cfg: TunnelConfig): string {
  const template = customTunnelTemplate(type);
  if (!template) throw new Error(`tunnel '${cfg.name}': unsupported type ${type}`);
  // Case-insensitive placeholder lookup ({{remotePort}} → cfg.remotePort).
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg as unknown as Record<string, unknown>)) {
    values[k.toLowerCase()] = v;
  }
  let missing: string | null = null;
  TOKEN_RE.lastIndex = 0;
  const cmd = template.replace(TOKEN_RE, (_all, raw: string, def: string | undefined) => {
    const token = raw.toLowerCase();
    if (token === "localport") {
      // auto-fill with the exposed local port; {{localport:PORT}} fixes it
      const local = def ?? String(cfg.target ?? "");
      assertSafeShellValue(local, "localport", cfg.name);
      return shellQuote(local);
    }
    const v = values[token];
    if (v !== undefined && v !== null && v !== "") {
      const s = String(v);
      assertSafeShellValue(s, token, cfg.name);
      return shellQuote(s);
    }
    if (def !== undefined) {
      assertSafeShellValue(def, token, cfg.name);
      return shellQuote(def);
    }
    missing = token;
    return "";
  });
  if (missing !== null) {
    throw new Error(
      `tunnel '${cfg.name}': missing required parameter "{{${missing}}}" for custom tunnel type "${type}"` +
        ` (fill it in the expose form, or tunnel add --set ${missing}=...)`,
    );
  }
  return cmd;
}
