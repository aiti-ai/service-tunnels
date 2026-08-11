/**
 * SSH gateway manager — owns N domains (storage + running gateway instances)
 * for the daemon. Persists the domain registry to cacheDir/ssh-domains.json
 * (atomic) so domains survive daemon restarts.
 *
 * IPC surface (daemon methods):
 *   ssh.domain.list | create | remove
 *   ssh.key.add | generate | list | remove
 *   ssh.host.fingerprints
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { validateUserName } from "../validation.ts";
import { SshDomain, sshFingerprint, type SshDomainMeta, type SshKeyInfo, type GeneratedKeyPair } from "./domain.ts";

export type { SshDomainMeta, SshKeyInfo, GeneratedKeyPair } from "./domain.ts";
import { SshGateway } from "./gateway.ts";
import { parseKey } from "./vendor.ts";

export interface SshDomainConfig {
  domain: string;
  /** 归属 site（平台用户组）。用于按 site 组织/管理 ssh 网关与 keys。 */
  site?: string;
  /** SSH gateway listen port (0 = ephemeral). */
  sshPort?: number;
  /** Fixed -L forwarding target port (required). */
  forwardPort: number;
  /** Optional -R reverse listen port (must differ from forwardPort). */
  reversePort?: number;
  /** Fixed -L forwarding target host. Loopback/private addresses ONLY — the
   *  gateway must never become an open egress proxy. Default 127.0.0.1. */
  forwardHost?: string;
  listenAddr?: string;
  /** Optional auth-timeout ms (default 10000). */
  authTimeoutMs?: number;
  /** Optional max connections (default 128). */
  maxConnections?: number;
  /** Optional failed-auth lockout: after N failures from one source IP the
   *  source is refused for `lockoutMs` (default 10 failures / 60 s). */
  authFailLockout?: { failures: number; lockoutMs: number };
}

export interface SshDomainInfo extends SshDomainConfig {
  /** Actual bound SSH port (ephemeral resolved). */
  port: number;
  listening: boolean;
  connections: number;
  hostKeyFingerprints: Record<string, string>;
  meta: SshDomainMeta | null;
}

interface PersistedRecord extends SshDomainConfig {
  hostKeysDir: string;
  port: number;
  /** false = gateway stopped (data kept, listener closed). */
  running?: boolean;
}

export interface SshManagerOptions {
  cacheDir: string;
}

const DOMAINS_FILE = "ssh-domains.json";
// 持久数据不放 tmp/（guardian 会按 owner 存活清理 tmp/*）——放 cache 顶层。
const SSH_ROOT = "ssh";

export class SshManager {
  private readonly root: string;
  private readonly file: string;
  private readonly domains = new Map<string, { cfg: PersistedRecord; store: SshDomain; gateway: SshGateway | null }>();

  constructor(opts: SshManagerOptions) {
    this.root = join(opts.cacheDir, SSH_ROOT);
    this.file = join(opts.cacheDir, DOMAINS_FILE);
    // 迁移：旧版本把 ssh 数据放在 cacheDir/tmp/ssh（会被 guardian 清理）——
    // 若 tmp/ssh 存在且新位置为空则搬过去，避免重启后重新生成 host keys。
    const legacyRoot = join(opts.cacheDir, "tmp", "ssh");
    if (existsSync(legacyRoot) && !existsSync(this.root)) {
      try {
        renameSync(legacyRoot, this.root);
      } catch { /* 迁移失败则重新生成 */ }
    }
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.#load();
  }

  // —— domains ——

  list(): SshDomainInfo[] {
    return [...this.domains.values()].map((d) => this.#info(d));
  }

  get(domain: string): SshDomainInfo | undefined {
    const d = this.domains.get(domain);
    return d ? this.#info(d) : undefined;
  }

  /** Get the domain if present, else auto-create (M0b-ssh site 化：UI/宿主只
   *  传 site + 端口，域/端口由库自动维护). */
  async ensure(cfg: SshDomainConfig): Promise<SshDomainInfo> {
    const existing = this.get(cfg.domain);
    if (existing) return existing;
    return this.create(cfg);
  }

  async create(cfg: SshDomainConfig): Promise<SshDomainInfo> {
    const domain = validateUserName(cfg.domain);
    if (this.domains.has(domain)) throw new Error(`ssh domain already exists: ${domain}`);
    if (!Number.isInteger(cfg.forwardPort) || cfg.forwardPort <= 0 || cfg.forwardPort > 65535)
      throw new Error(`invalid forwardPort: ${cfg.forwardPort}`);
    if (cfg.reversePort !== undefined && cfg.reversePort === cfg.forwardPort)
      throw new Error("reversePort must differ from forwardPort");
    if (cfg.forwardHost !== undefined) {
      const fh = cfg.forwardHost.trim().toLowerCase();
      const isPrivate =
        fh === "localhost" || fh === "127.0.0.1" || fh === "::1" ||
        /^10\./.test(fh) || /^192\.168\./.test(fh) || /^172\.(1[6-9]|2\d|3[01])\./.test(fh) ||
        /^169\.254\./.test(fh) || /^fd[0-9a-f]{2}:/i.test(fh) || fh.startsWith("fe80:");
      if (!isPrivate)
        throw new Error(`forwardHost must be loopback/private (got ${cfg.forwardHost}) — the gateway must not become an open egress proxy`);
    }

    const dir = join(this.root, domain);
    const store = SshDomain.create(domain, dir);
    const record: PersistedRecord = {
      ...cfg,
      domain,
      hostKeysDir: dir,
      port: cfg.sshPort ?? 0,
    };
    const gateway = new SshGateway({
      forwardHost: cfg.forwardHost ?? "127.0.0.1",
      forwardPort: cfg.forwardPort,
      reversePort: cfg.reversePort,
      hostKeys: store.loadHostKeys(),
      authorizedKeys: store.loadAuthorizedParsed(),
      listenAddr: cfg.listenAddr,
      authTimeoutMs: cfg.authTimeoutMs,
      maxConnections: cfg.maxConnections,
    });
    try {
      record.port = await gateway.start(cfg.sshPort ?? 0, cfg.listenAddr ?? "127.0.0.1");
    } catch (err) {
      throw new Error(`failed to start ssh gateway: ${(err as Error).message}`);
    }
    this.domains.set(domain, { cfg: record, store, gateway });
    this.#persist();
    return this.#info(this.domains.get(domain)!);
  }

  async remove(domain: string): Promise<{ ok: true }> {
    validateUserName(domain);
    const d = this.domains.get(domain);
    if (!d) throw new Error(`unknown ssh domain: ${domain}`);
    await d.gateway?.close();
    this.domains.delete(domain);
    rmSync(d.store.dir, { recursive: true, force: true });
    this.#persist();
    return { ok: true };
  }

  /** Stop the gateway listener (data kept; start() resumes). */
  async stop(domain: string): Promise<{ ok: true }> {
    const d = this.#require(domain);
    await d.gateway?.close();
    d.gateway = null;
    d.cfg.running = false;
    this.#persist();
    return { ok: true };
  }

  /** Start/resume a stopped gateway on its configured port. */
  async start(domain: string): Promise<SshDomainInfo> {
    const d = this.#require(domain);
    if (d.gateway) return this.#info(d);
    const gw = new SshGateway({
      forwardHost: d.cfg.forwardHost ?? "127.0.0.1",
      forwardPort: d.cfg.forwardPort,
      reversePort: d.cfg.reversePort,
      hostKeys: d.store.loadHostKeys(),
      authorizedKeys: d.store.loadAuthorizedParsed(),
      listenAddr: d.cfg.listenAddr,
      authTimeoutMs: d.cfg.authTimeoutMs,
      maxConnections: d.cfg.maxConnections,
      authFailLockout: d.cfg.authFailLockout,
    });
    d.cfg.port = await gw.start(d.cfg.port, d.cfg.listenAddr ?? "127.0.0.1");
    d.gateway = gw;
    d.cfg.running = true;
    this.#persist();
    return this.#info(d);
  }

  // —— keys (delegated to the domain store; gateway hot-reload awaited so a
  //     restart can never race shutdown / run after the store is gone) ——

  async addKey(domain: string, publicKey: string): Promise<{ fingerprint: string }> {
    const d = this.#require(domain);
    const { fingerprint } = d.store.addKey(publicKey);
    await this.#refreshGatewayKeys(d);
    return { fingerprint };
  }

  async generateKey(domain: string, opts: { type?: "ed25519" | "rsa" | "ecdsa"; bits?: number; comment?: string; count?: number } = {}): Promise<GeneratedKeyPair[]> {
    const d = this.#require(domain);
    const count = Math.min(Math.max(1, opts.count ?? 1), 10);
    const out: GeneratedKeyPair[] = [];
    for (let i = 0; i < count; ++i) {
      const comment = count > 1 ? `${opts.comment ?? "service-tunnels"}-${i + 1}` : (opts.comment ?? "service-tunnels");
      out.push(d.store.generateKey(opts.type ?? "ed25519", opts.bits, comment));
    }
    await this.#refreshGatewayKeys(d);
    return out;
  }

  listKeys(domain: string): SshKeyInfo[] {
    return this.#require(domain).store.listAuthorizedKeys();
  }

  async removeKey(domain: string, fingerprint: string): Promise<{ removed: boolean }> {
    const d = this.#require(domain);
    const removed = d.store.removeKey(fingerprint);
    if (removed) await this.#refreshGatewayKeys(d);
    return { removed };
  }

  hostFingerprints(domain: string): Record<string, string> {
    return this.#require(domain).store.hostKeyFingerprints();
  }

  // —— internals ——

  #require(domain: string): { cfg: PersistedRecord; store: SshDomain; gateway: SshGateway | null } {
    const d = this.domains.get(domain);
    if (!d) throw new Error(`unknown ssh domain: ${domain}`);
    return d;
  }

  /** Hot-reload authorized keys into the running gateway (no reconnect).
   *  AWAITED by addKey/generateKey/removeKey so a restart can never race
   *  shutdown or run after the store dir is gone. Guards against restarting
   *  a gateway that was closed/stopped meanwhile (d.gateway changed). */
  async #refreshGatewayKeys(d: { cfg: PersistedRecord; store: SshDomain; gateway: SshGateway | null }): Promise<void> {
    // The gateway holds an immutable authorized set per instance; simplest
    // correct behavior for now: restart the gateway so auth changes apply.
    // (Single-user admin surface — restart is sub-second and drops no long
    //  -lived data because key changes are rare.)
    const old = d.gateway;
    if (!old) return;
    const port = d.cfg.port;
    try {
      await old.close();
    } catch {
      /* already closed */
    }
    // stop() may have swapped d.gateway to null while we closed — do not
    // resurrect a stopped domain's listener.
    if (d.gateway !== old) return;
    const gw = new SshGateway({
      forwardHost: d.cfg.forwardHost ?? "127.0.0.1",
      forwardPort: d.cfg.forwardPort,
      reversePort: d.cfg.reversePort,
      hostKeys: d.store.loadHostKeys(),
      authorizedKeys: d.store.loadAuthorizedParsed(),
      listenAddr: d.cfg.listenAddr,
      authTimeoutMs: d.cfg.authTimeoutMs,
      maxConnections: d.cfg.maxConnections,
      authFailLockout: d.cfg.authFailLockout,
    });
    const p = await gw.start(port, d.cfg.listenAddr ?? "127.0.0.1");
    if (d.gateway === old) {
      d.cfg.port = p;
      d.gateway = gw;
    } else {
      await gw.close().catch(() => {});
    }
  }

  #info(d: { cfg: PersistedRecord; store: SshDomain; gateway: SshGateway | null }): SshDomainInfo {
    const st = d.gateway?.status();
    return {
      domain: d.cfg.domain,
      site: d.cfg.site,
      sshPort: d.cfg.sshPort,
      port: d.cfg.port,
      forwardPort: d.cfg.forwardPort,
      reversePort: d.cfg.reversePort,
      forwardHost: d.cfg.forwardHost,
      listenAddr: d.cfg.listenAddr,
      listening: d.cfg.running !== false && (st?.listening ?? false),
      connections: st?.connections ?? 0,
      hostKeyFingerprints: d.store.hostKeyFingerprints(),
      meta: d.store.loadMeta(),
    };
  }

  #load(): void {
    if (!existsSync(this.file)) return;
    let records: PersistedRecord[];
    try {
      records = JSON.parse(readFileSync(this.file, "utf8")) as PersistedRecord[];
    } catch {
      return; // corrupt registry: start empty (domains are re-creatable)
    }
    for (const rec of records) {
      try {
        const store = SshDomain.create(rec.domain, rec.hostKeysDir);
        const gateway = rec.running === false ? null : new SshGateway({
          forwardHost: rec.forwardHost ?? "127.0.0.1",
          forwardPort: rec.forwardPort,
          reversePort: rec.reversePort,
          hostKeys: store.loadHostKeys(),
          authorizedKeys: store.loadAuthorizedParsed(),
          listenAddr: rec.listenAddr,
          authTimeoutMs: rec.authTimeoutMs,
          maxConnections: rec.maxConnections,
          authFailLockout: rec.authFailLockout,
        });
        if (gateway) {
          void gateway.start(rec.port, rec.listenAddr ?? "127.0.0.1").then((p) => {
            rec.port = p;
            this.#persist();
          });
        }
        this.domains.set(rec.domain, { cfg: rec, store, gateway });
      } catch (err) {
        // Skip a broken domain on restore (port busy etc.) — keep daemon up.
        // eslint-disable-next-line no-console
        console.error(`[ssh] restore failed for domain ${rec.domain}: ${(err as Error).message}`);
      }
    }
  }

  #persist(): void {
    const records: PersistedRecord[] = [...this.domains.values()].map((d) => d.cfg);
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
