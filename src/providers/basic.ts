import { writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join } from "path";
import type { AuthProvider, AuthPolicy, ProviderContext, AuthProviderStatus } from "../auth-provider.ts";

/**
 * basic provider — nginx auth_basic with an htpasswd file.
 *
 * The lightest option: no local auth process, no Redis. Every registered host
 * is protected by HTTP Basic credentials. Credentials live in
 * cacheDir/tmp/basic/htpasswd (0600); the hash is generated with `htpasswd`
 * (apache2-utils) or `openssl passwd -apr1`.
 */

export interface BasicAuthProviderOptions {
  user?: { name: string; password: string };
}

export class BasicAuthProvider implements AuthProvider {
  readonly type = "basic";
  readonly capabilities = {
    localGateway: true,
    edgeAuth: false,
    randomDomain: true,
    multiHost: true,
    needsSessionStore: false,
  };

  #ctx: ProviderContext;
  #opts: BasicAuthProviderOptions;
  #htpasswd = "";
  #creds = { name: "admin", password: "" };

  constructor(ctx: ProviderContext, opts: BasicAuthProviderOptions = {}) {
    this.#ctx = ctx;
    this.#opts = opts;
    this.#creds = {
      name: opts.user?.name ?? "admin",
      password: opts.user?.password ?? randomSecret(12),
    };
    this.#htpasswd = join(ctx.cacheDir, "tmp", "basic", "htpasswd");
  }

  get htpasswdFile(): string {
    return this.#htpasswd;
  }

  status(): AuthProviderStatus {
    return { running: true }; // stateless — nothing to run
  }

  async prepare(): Promise<AuthProviderStatus> {
    mkdirSync(dirname(this.#htpasswd), { recursive: true });
    // nginx auth_basic supports crypt/APR1 but NOT bcrypt, so generate an
    // APR1 hash with openssl (password via stdin so it never shows in argv);
    // fall back to htpasswd (crypt) when openssl is missing.
    let hash = "";
    try {
      const out = execFileSync(
        "openssl",
        ["passwd", "-apr1", "-stdin"],
        { input: this.#creds.password, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      hash = out.trim();
    } catch {
      const out = execFileSync(
        "htpasswd",
        ["-nb", this.#creds.name, this.#creds.password],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      hash = out.trim().split(":")[1] ?? "";
    }
    const file = `${this.#htpasswd}.${process.pid}.tmp`;
    writeFileSync(file, `${this.#creds.name}:${hash}\n`, "utf8");
    try {
      execFileSync("chmod", ["600", file], { stdio: "ignore" });
    } catch {
      // best-effort
    }
    execFileSync("mv", [file, this.#htpasswd], { stdio: "ignore" });
    return this.status();
  }

  async start(): Promise<AuthProviderStatus> {
    return this.prepare();
  }

  async stop(): Promise<void> {
    // nothing to stop
  }

  async validate(): Promise<string[]> {
    const problems: string[] = [];
    if (!this.#creds.password) problems.push("basic auth requires a password");
    return problems;
  }

  renderNginxAuth(): string {
    return `auth_basic "service-tunnels"; auth_basic_user_file ${this.#htpasswd};`;
  }

  async registerHost(_host: string, _policy?: AuthPolicy): Promise<void> {
    // basic auth applies to every host — nothing per-host to register
  }

  async unregisterHost(_host: string): Promise<void> {
    // nothing to unregister
  }

  async listHosts(): Promise<string[]> {
    return [];
  }
}

function randomSecret(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
