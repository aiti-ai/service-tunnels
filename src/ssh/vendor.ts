/**
 * Typed facade over the vendored ssh2 server core
 * (src/vendor/ssh2 — CommonJS, loaded via createRequire).
 *
 * Only the gateway-relevant surface is exposed: Server, parseKey,
 * generateKeyPair(Sync). SFTP/client/agent paths are cut in the vendor.
 */
import { createRequire } from "module";

interface KeygenOpts {
  comment?: string;
  /** Only "new" (OpenSSH) format is supported by the vendored build. */
  format?: "new";
}
interface KeyPair {
  private: string;
  public: string;
}

export interface ParsedKey {
  type: string;
  comment: string;
  /** SSH wire-format public key blob (ssh-ed25519 AAAA… decoded). */
  getPublicSSH(): Buffer;
  /** @param algo digest name (undefined for ed25519/ecdsa — EdDSA). */
  verify(data: Buffer, sig: Buffer, algo?: string): boolean | undefined;
  /** Type-agnostic: raw public key data. */
  readonly public: Buffer | null;
}

export interface AuthContext {
  username: string;
  method: string;
  /** Present for method "publickey" (and hostbased). */
  key?: {
    algo: string;
    data: Buffer;
  };
  /** Present when the client sent a signature with the publickey request. */
  signature?: Buffer;
  blob?: Buffer;
  hashAlgo?: string;
  accept(): void;
  reject(authMethodsLeft?: string[], isPartialSuccess?: boolean): void;
}

export interface SessionChannelInfo {
  destIP?: string;
  destPort?: number;
  srcIP?: string;
  srcPort?: number;
}

export interface Connection {
  on(event: "authentication", cb: (ctx: AuthContext) => void): this;
  on(event: "ready", cb: () => void): this;
  on(event: "close", cb: () => void): this;
  on(event: "end", cb: () => void): this;
  on(event: "error", cb: (err: Error) => void): this;
  /** Exec/shell/sftp session requested (we always reject). */
  on(event: "session", cb: (accept: () => Channel, reject: () => void) => void): this;
  /** -L outbound TCP requested (direct-tcpip). */
  on(event: "tcpip", cb: (accept: () => Channel, reject: () => void, info: SessionChannelInfo) => void): this;
  /** Global requests: tcpip-forward / cancel-tcpip-forward. */
  on(event: "request", cb: (accept: (port?: number) => void, reject: () => void, name: string, info: { bindAddr: string; bindPort: number }) => void): this;
  /** Server → client alert of an inbound connection on a forwarded port (-R). */
  forwardOut(boundAddr: string, boundPort: number, remoteAddr: string, remotePort: number, cb: (err: Error | undefined, channel: Channel) => void): void;
  end(): void;
}

export interface Channel {
  on(event: "close", cb: () => void): this;
  on(event: "error", cb: (err: Error) => void): this;
  /** writable/readable streams — pipe directly with a net.Socket. */
  write(data: Uint8Array): boolean;
  end(): void;
  close(): void;
  pipe<T>(dest: T): T;
  unpipe(dest?: unknown): this;
  on(event: "data", cb: (chunk: Buffer) => void): this;
  once(event: "end" | "close" | "error", cb: (...args: unknown[]) => void): this;
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>;
}

export interface ServerOptions {
  hostKeys: Array<Buffer | string>;
  algorithms?: {
    cipher?: string[];
    kex?: string[];
    serverHostKey?: string[];
    hmac?: string[];
  };
  ident?: string;
}

type ClientHandler = (client: Connection, info?: { ip: string; port: number }) => void;

export interface SshServer {
  on(event: "connection", cb: (client: Connection, info: { ip: string; port: number }) => void): this;
  on(event: "error", cb: (err: Error) => void): this;
  once(event: "connection" | "error", cb: (...args: unknown[]) => void): this;
  off(event: "connection" | "error", cb: (...args: unknown[]) => void): this;
  listen(port: number, host?: string, cb?: () => void): this;
  close(cb?: () => void): void;
  address(): { port: number; address: string; family: string } | null;
  /** Hand a raw TCP socket to the ssh2 server (front-listener mode). */
  injectSocket(socket: import("net").Socket): void;
}

interface VendorModule {
  Server: new (options: ServerOptions, handler: ClientHandler) => SshServer;
  utils: {
    parseKey(data: string | Buffer, passphrase?: string): ParsedKey;
    generateKeyPairSync(type: "ed25519" | "rsa" | "ecdsa", opts?: KeygenOpts & { bits?: number }): KeyPair;
    generateKeyPair(type: "ed25519" | "rsa" | "ecdsa", opts?: unknown, cb?: (err: Error | null, keypair?: KeyPair) => void): void;
  };
}

const require = createRequire(import.meta.url);
const mod = require("../vendor/ssh2/ssh-gateway.cjs") as VendorModule;

/** The vendored ssh2 Server constructor. */
export const SshServerCtor = mod.Server;
/** parseKey — validates/parses OpenSSH/PEM public & private keys. */
export const parseKey = mod.utils.parseKey;
export const generateKeyPairSync = mod.utils.generateKeyPairSync;
export const generateKeyPair = mod.utils.generateKeyPair;
