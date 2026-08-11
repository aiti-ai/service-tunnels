/**
 * SSH domain store — per-domain key/authorized_keys persistence.
 *
 * Layout (mirrors the basic provider's htpasswd-file-as-user-db model):
 *   <dir>/                    0700
 *   ├── authorized_keys       授权公钥（authorized_keys 格式，0600）
 *   ├── host_ed25519_key      host key（缺则自动生成，0600）
 *   ├── host_rsa_key          2048 位（缺则自动生成）
 *   ├── host_ecdsa_key        P-256（缺则自动生成）
 *   └── meta.json             domain 元数据（固定转发目标等）
 *
 * Keys are never encrypted (vendor keygen rejects passphrases); files are
 * written atomically (tmp + rename) and permission-restricted.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { join } from "path";
import { createHash, randomUUID, generateKeyPairSync as nodeGen } from "crypto";
import { generateKeyPairSync, parseKey, type ParsedKey } from "./vendor.ts";

export interface SshDomainMeta {
  domain: string;
  forwardPort: number;
  forwardHost?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SshKeyInfo {
  fingerprint: string;
  type: string;
  comment: string;
  addedAt: string;
}

export interface GeneratedKeyPair {
  privateKey: string;
  publicKey: string;
  fingerprint: string;
}

const HOST_KEY_TYPES = [
  { file: "host_ed25519_key", gen: () => generateKeyPairSync("ed25519", { comment: "host" }).private },
  // RSA 纯 JS 生成极慢（分钟级）——host key 用 node crypto（~250ms），
  // 输出 PKCS1 PEM，ssh2 parseKey 兼容。
  { file: "host_rsa_key", gen: () => nodeGen("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" } }).privateKey },
  { file: "host_ecdsa_key", gen: () => generateKeyPairSync("ecdsa", { bits: 256, comment: "host" }).private },
] as const;

/** SHA-256 fingerprint in the OpenSSH format ("SHA256:<b64-no-padding>"). */
export function sshFingerprint(pubBlob: Buffer): string {
  const b64 = createHash("sha256").update(pubBlob).digest("base64").replace(/=+$/, "");
  return `SHA256:${b64}`;
}

function normalizeComment(line: string): string {
  const idx = line.lastIndexOf(" ");
  if (idx < 0) return "";
  return line.slice(idx + 1).trim();
}

export class SshDomain {
  readonly domain: string;
  readonly dir: string;

  private constructor(domain: string, dir: string) {
    this.domain = domain;
    this.dir = dir;
  }

  static create(domain: string, dir: string): SshDomain {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Ensure meta exists (created lazily on save); ensure host keys present.
    const d = new SshDomain(domain, dir);
    d.ensureHostKeys();
    return d;
  }

  /** Paths (exposed for tests). */
  get authorizedKeysPath(): string { return join(this.dir, "authorized_keys"); }
  get metaPath(): string { return join(this.dir, "meta.json"); }
  get hostKeyPaths(): string[] { return HOST_KEY_TYPES.map((t) => join(this.dir, t.file)); }

  // —— Host keys ——

  /** Generate any missing host keys (ed25519 + rsa + ecdsa), 0600. */
  ensureHostKeys(): void {
    for (const { file, gen } of HOST_KEY_TYPES) {
      const p = join(this.dir, file);
      if (existsSync(p)) continue;
      this.#atomicWrite(p, gen() + "\n", 0o600);
    }
  }

  /** Load all host key private keys (text). */
  loadHostKeys(): string[] {
    this.ensureHostKeys();
    return HOST_KEY_TYPES.map((t) => {
      const p = join(this.dir, t.file);
      return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
    }).filter(Boolean);
  }

  /** Host key fingerprints keyed by type (for known_hosts distribution). */
  hostKeyFingerprints(): Record<string, string> {
    this.ensureHostKeys();
    const out: Record<string, string> = {};
    for (const { file } of HOST_KEY_TYPES) {
      const p = join(this.dir, file);
      if (!existsSync(p)) continue;
      const key = parseKey(readFileSync(p, "utf8"));
      if (!(key instanceof Error)) out[file.replace(/^host_|_key$/g, "")] = sshFingerprint(key.getPublicSSH());
    }
    return out;
  }

  // —— Authorized keys ——

  /** Parse + validate a raw authorized_keys line; returns ParsedKey or Error. */
  static validateKeyLine(line: string): ParsedKey | Error {
    if (typeof line !== "string") return new Error("key must be a string");
    const k = parseKey(line.trim());
    return k instanceof Error ? new Error(`invalid public key: ${k.message}`) : k;
  }

  /** List authorized keys (in file order). */
  listAuthorizedKeys(): SshKeyInfo[] {
    if (!existsSync(this.authorizedKeysPath)) return [];
    const out: SshKeyInfo[] = [];
    for (const line of readFileSync(this.authorizedKeysPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const key = parseKey(t);
      if (key instanceof Error) continue; // skip malformed lines (tolerant read)
      out.push({
        fingerprint: sshFingerprint(key.getPublicSSH()),
        type: key.type,
        comment: key.comment || normalizeComment(t),
        addedAt: "",
      });
    }
    // addedAt lives in the comment-less form; stored keys carry `addedAt=...`
    // comments when added via this API — reconstruct below.
    return this.#withAddedAt(out);
  }

  #withAddedAt(list: SshKeyInfo[]): SshKeyInfo[] {
    // When keys were added through addKey we append `service-tunnels:<ts>` to
    // the comment; surface that as addedAt without exposing the marker.
    return list.map((k) => {
      const m = /service-tunnels:(\d+)$/.exec(k.comment);
      if (m) return { ...k, comment: k.comment.replace(/ service-tunnels:\d+$/, ""), addedAt: new Date(Number(m[1])).toISOString() };
      return k;
    });
  }

  /** Add a public key (uploaded by the user). Returns fingerprint. */
  addKey(publicKey: string): { fingerprint: string; key: ParsedKey } {
    const parsed = SshDomain.validateKeyLine(publicKey);
    if (parsed instanceof Error) throw parsed;
    const fingerprint = sshFingerprint(parsed.getPublicSSH());
    if (this.listAuthorizedKeys().some((k) => k.fingerprint === fingerprint))
      throw new Error(`key already authorized (${fingerprint})`);
    // <type> <b64> [comment] service-tunnels:<ts>  (ts marker doubles as addedAt)
    const base = `${parsed.type} ${parsed.getPublicSSH().toString("base64")}`;
    const comment = parsed.comment && parsed.comment !== parsed.type ? ` ${parsed.comment}` : "";
    const line = `${base}${comment} service-tunnels:${Date.now()}`;
    const lines = this.#rawLines();
    lines.push(line);
    this.#writeAuthorized(lines);
    return { fingerprint, key: parsed };
  }

  /** Generate a keypair server-side; public key is stored, private returned once. */
  generateKey(type: "ed25519" | "rsa" | "ecdsa" = "ed25519", bits?: number, comment = "service-tunnels"): GeneratedKeyPair {
    const kp = type === "rsa"
      ? generateKeyPairSync("rsa", { bits: bits ?? 2048, comment })
      : type === "ecdsa"
        ? generateKeyPairSync("ecdsa", { bits: bits ?? 256, comment })
        : generateKeyPairSync("ed25519", { comment });
    const parsed = SshDomain.validateKeyLine(kp.public);
    if (parsed instanceof Error) throw parsed;
    const fingerprint = sshFingerprint(parsed.getPublicSSH());
    this.addKey(kp.public);
    return { privateKey: kp.private, publicKey: kp.public, fingerprint };
  }

  /** Remove a key by fingerprint. Returns true if removed. */
  removeKey(fingerprint: string): boolean {
    const lines = this.#rawLines();
    const kept = lines.filter((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return true;
      const key = parseKey(t);
      if (key instanceof Error) return true;
      return sshFingerprint(key.getPublicSSH()) !== fingerprint;
    });
    if (kept.length === lines.length) return false;
    this.#writeAuthorized(kept);
    return true;
  }

  #rawLines(): string[] {
    if (!existsSync(this.authorizedKeysPath)) return [];
    return readFileSync(this.authorizedKeysPath, "utf8").split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  }

  #writeAuthorized(lines: string[]): void {
    this.#atomicWrite(this.authorizedKeysPath, lines.join("\n") + (lines.length ? "\n" : ""), 0o600);
  }

  /** Parse the authorized_keys file into ParsedKey[] (skips malformed lines). */
  loadAuthorizedParsed(): ParsedKey[] {
    if (!existsSync(this.authorizedKeysPath)) return [];
    const out: ParsedKey[] = [];
    for (const line of readFileSync(this.authorizedKeysPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const key = parseKey(t);
      if (key instanceof Error) continue;
      out.push(key);
    }
    return out;
  }

  // —— Meta ——

  loadMeta(): SshDomainMeta | null {
    if (!existsSync(this.metaPath)) return null;
    try {
      return JSON.parse(readFileSync(this.metaPath, "utf8")) as SshDomainMeta;
    } catch {
      return null;
    }
  }

  saveMeta(meta: Omit<SshDomainMeta, "createdAt" | "updatedAt">): SshDomainMeta {
    const prev = this.loadMeta();
    const next: SshDomainMeta = {
      ...meta,
      domain: this.domain,
      createdAt: prev?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.#atomicWrite(this.metaPath, JSON.stringify(next, null, 2) + "\n", 0o600);
    return next;
  }

  // —— Internals ——

  #atomicWrite(path: string, content: string, mode: number): void {
    const tmp = join(this.dir, `.${randomUUID()}.tmp`);
    writeFileSync(tmp, content, { mode });
    renameSync(tmp, path);
  }
}
