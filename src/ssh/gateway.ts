/**
 * SSH gateway — publickey-only auth + fixed-port forwarding, built on the
 * vendored ssh2 server core (src/vendor/ssh2).
 *
 * Security model:
 *  - ONLY "publickey" authentication is accepted; every other method and any
 *    unlisted public key is rejected (no password / none / keyboard-interactive).
 *  - shell / exec / sftp sessions are rejected outright.
 *  - ANY outbound TCP request (-L, direct-tcpip) ignores the requested target
 *    port and is forwarded to the configured fixed target — the gateway can
 *    never be used as a jump host.
 *  - -R (tcpip-forward) requests are likewise pinned to the configured fixed
 *    listen port; the client's requested bind port is ignored.
 */
import net, { createServer as netServer, type Server as NetServer, type Socket } from "net";
import type { Writable } from "stream";
import { randomUUID } from "crypto";
import { SshServerCtor, parseKey, type Connection, type ParsedKey, type ServerOptions, type SshServer } from "./vendor.ts";

export interface SshGatewayOptions {
  /** Fixed forwarding target host (default 127.0.0.1). */
  forwardHost?: string;
  /** Fixed forwarding target port — the ONLY reachable service (-L). */
  forwardPort: number;
  /**
   * Fixed server-side listen port for -R (remote forwarding). When set, the
   * gateway binds THIS port and pushes inbound connections to the client;
   * the client's requested bindPort is ignored. Must differ from forwardPort
   * (otherwise the listener would intercept -L connections). Default: unset
   * (-R requests are rejected).
   */
  reversePort?: number;
  /** Host keys (ed25519/rsa/ecdsa OpenSSH private key strings). */
  hostKeys: string[];
  /** Authorized public keys (already parsed). */
  authorizedKeys: ParsedKey[];
  /** Listen host (default 127.0.0.1). */
  listenAddr?: string;
  /** Listen port; 0 = ephemeral (check `port` after start). */
  listenPort?: number;
  /** Optional cipher/kex algorithm preference (default: vendored defaults). */
  algorithms?: ServerOptions["algorithms"];
  /** Extra handshake timeout (ms) for unauthenticated connections. */
  authTimeoutMs?: number;
  /** Max concurrent connections. */
  maxConnections?: number;
  /** Failed-auth lockout: after N failures from one source IP the source is
   *  refused for lockoutMs. Default { failures: 10, lockoutMs: 60_000 }. */
  authFailLockout?: { failures: number; lockoutMs: number };
}

export interface SshGatewayStatus {
  listening: boolean;
  port: number;
  connections: number;
  fixedTarget: { host: string; port: number };
  reversePort: number | null;
}

/** Rejects the shell/exec/sftp session and every non-publickey auth attempt. */
export class SshGateway {
  readonly forwardHost: string;
  readonly forwardPort: number;
  readonly reversePort: number | null;
  private readonly server: SshServer;
  /** Front TCP listener: applies an idle/auth timeout to every raw socket
   *  BEFORE the ssh2 handshake starts (ssh2 has no pre-header timeout). */
  private netSrv: NetServer | null = null;
  private connections = 0;
  private closed = false;
  private readonly authTimeoutMs: number;
  private readonly maxConnections: number;
  private readonly lockout: { failures: number; lockoutMs: number };
  private readonly authFailures = new Map<string, { count: number; lockedUntil: number }>();
  private readonly authorized: ParsedKey[];
  private readonly authzByAlgo = new Map<string, ParsedKey[]>();

  constructor(opts: SshGatewayOptions) {
    if (!Number.isInteger(opts.forwardPort) || opts.forwardPort <= 0 || opts.forwardPort > 65535)
      throw new Error(`invalid forwardPort: ${opts.forwardPort}`);
    if (!opts.hostKeys.length) throw new Error("ssh gateway requires at least one host key");
    this.forwardHost = opts.forwardHost ?? "127.0.0.1";
    this.forwardPort = opts.forwardPort;
    this.reversePort = opts.reversePort ?? null;
    if (this.reversePort !== null && this.reversePort === this.forwardPort)
      throw new Error("reversePort must differ from forwardPort");
    this.authorized = opts.authorizedKeys;
    for (const k of this.authorized) {
      const list = this.authzByAlgo.get(k.type) ?? [];
      list.push(k);
      this.authzByAlgo.set(k.type, list);
    }
    this.authTimeoutMs = opts.authTimeoutMs ?? 10_000;
    this.maxConnections = opts.maxConnections ?? 128;
    this.lockout = opts.authFailLockout ?? { failures: 10, lockoutMs: 60_000 };

    this.server = new SshServerCtor(
      {
        hostKeys: opts.hostKeys,
        ...(opts.algorithms ? { algorithms: opts.algorithms } : {}),
      },
      (client, info) => this.#onClient(client, info),
    );
  }

  /** Start listening. Resolves once bound (or with the actual port). */
  start(port = 0, addr = this.forwardHost === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0"): Promise<number> {
    if (this.closed) return Promise.reject(new Error("gateway already closed"));
    return new Promise((resolve, reject) => {
      // Front listener: raw sockets get an idle timeout so silent connections
      // (no SSH version banner) are dropped — ssh2 only fires its 'connection'
      // event after the client banner, so it cannot time these out itself.
      const netSrv = netServer((socket) => {
        // Raw sockets get an idle timeout; authenticated connections lift it
        // in the 'ready' handler. Destroys silent pre-banner peers.
        socket.setTimeout(this.authTimeoutMs, () => socket.destroy());
        socket.on("error", () => {});
        this.server.injectSocket(socket);
      });
      this.netSrv = netSrv;
      netSrv.on("error", (err) => {
        this.server.off("error", onErr);
        reject(err);
      });
      const onErr = (err: unknown) => {
        netSrv.removeListener("error", onErr);
        reject(err);
      };
      try {
        netSrv.listen(port, addr, () => {
          this.server.on("error", (err) => this.#onError(err));
          resolve((netSrv.address() as { port: number } | null)?.port ?? 0);
        });
      } catch (err) {
        onErr(err as Error);
      }
    });
  }

  get port(): number {
    return (this.netSrv?.address() as { port: number } | null)?.port ?? 0;
  }

  status(): SshGatewayStatus {
    return {
      listening: !this.closed,
      port: this.port,
      connections: this.connections,
      fixedTarget: { host: this.forwardHost, port: this.forwardPort },
      reversePort: this.reversePort,
    };
  }

  close(): Promise<void> {
    this.closed = true;
    // ssh2's server.close() waits for active connections; force-disconnect
    // them so remove()/shutdown resolve promptly.
    for (const c of this.#clients) {
      try {
        c.end();
      } catch {
        /* already gone */
      }
    }
    this.#clients.clear();
    const netClose = this.netSrv
      ? new Promise<void>((resolve) => this.netSrv!.close(() => resolve()))
      : Promise.resolve();
    return new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      void netClose;
    });
  }

  #onError(err: Error): void {
    // Server-level error (e.g. listen failure at runtime) — surface to caller.
    // Keep the process alive; per-connection errors are handled on the client.
    // eslint-disable-next-line no-console
    console.error(`[ssh-gateway] server error: ${err.message}`);
  }

  readonly #clients = new Set<Connection>();

  #onClient(client: Connection, info?: { ip: string; port: number }): void {
    // Socket errors are expected (client RST after rejection) — register
    // FIRST so every early-return branch below (lockout / maxConnections)
    // still swallows them; an unhandled 'error' on the ssh2 Connection
    // becomes an uncaughtException in the host process.
    client.on("error", () => {});
    const srcIp = info?.ip ?? "";
    if (srcIp) {
      const entry = this.authFailures.get(srcIp);
      if (entry && entry.lockedUntil > Date.now()) {
        // Source is in a failed-auth lockout — refuse before any handshake.
        client.end();
        return;
      }
    }
    if (this.connections >= this.maxConnections) {
      client.end();
      return;
    }
    this.connections++;
    this.#clients.add(client);

    // Unauthenticated connection budget: drop slow/abusive handshakes.
    const authTimer = setTimeout(() => {
      if (this.connections > 0 && !clientEmittedReady) {
        // Force-close: Client#end() calls _protocol.disconnect(), which is a
        // no-op before the transport handshake completes — destroy the raw
        // socket so a silent/raw peer cannot hold a connection forever.
        try {
          (client as unknown as { _sock?: import("net").Socket })._sock?.destroy();
        } catch {
          /* ignore */
        }
        client.end();
      }
    }, this.authTimeoutMs);
    let clientEmittedReady = false;

    const done = () => {
      clearTimeout(authTimer);
      this.connections--;
    };
    client.on("close", () => { done(); this.#clients.delete(client); });
    client.on("end", done);
    client.on("error", () => {}); // socket errors are expected; never crash

    const failAuth = () => {
      if (!srcIp) return;
      const now = Date.now();
      const entry = this.authFailures.get(srcIp) ?? { count: 0, lockedUntil: 0 };
      if (entry.lockedUntil > now) return; // already locked
      entry.count += 1;
      if (entry.count >= this.lockout.failures) {
        entry.count = 0;
        entry.lockedUntil = now + this.lockout.lockoutMs;
      }
      this.authFailures.set(srcIp, entry);
    };

    client.on("authentication", (ctx) => {
      // ONLY publickey. Reject everything else.
      if (ctx.method !== "publickey") {
        failAuth();
        return ctx.reject(["publickey"]);
      }
      const key = ctx.key;
      if (!key) {
        failAuth();
        return ctx.reject();
      }
      const allowed = this.authzByAlgo.get(key.algo) ?? [];
      const candidate = allowed.find((pk) => {
        try {
          return pk.getPublicSSH().equals(Buffer.from(key.data));
        } catch {
          return false;
        }
      });
      if (!candidate) {
        failAuth();
        return ctx.reject();
      }

      // Probe request (no signature): signal the key is acceptable so the
      // client follows up with a signed request. Do not count as failure.
      if (!ctx.signature) return ctx.accept();
      // NOTE: hashAlgo is undefined for ed25519/ecdsa (EdDSA signs the
      // message directly); keyParser falls back to the key's own hash.
      // Passing a fallback here breaks ed25519 (invalid digest).
      const ok = candidate.verify(ctx.blob!, ctx.signature, ctx.hashAlgo);
      if (ok === true) {
        // Successful auth — forgive this source's failure history.
        this.authFailures.delete(srcIp);
        ctx.accept();
      } else {
        failAuth();
        ctx.reject();
      }
    });

    client.on("ready", () => {
      clientEmittedReady = true;
      clearTimeout(authTimer);
      // Authenticated connections may idle for long periods (port forwards
      // with no traffic) — lift the pre-handshake idle timeout.
      try {
        (client as unknown as { _sock?: import("net").Socket })._sock?.setTimeout(0);
      } catch {
        /* ignore */
      }

      // No shell/exec/sftp — ever.
      client.on("session", (_accept, reject) => reject());

      // -L: client wants an outbound TCP connection. Target port is IGNORED;
      // always connect to the fixed forward target.
      client.on("tcpip", (accept, reject) => {
        const channel = accept();
        const sock = net.connect(this.forwardPort, this.forwardHost);
        sock.on("connect", () => {
          sock.pipe(channel as unknown as Writable);
          (channel as unknown as import("stream").Readable).pipe(sock);
        });
        sock.on("error", () => {
          try {
            channel.close();
          } catch {
            /* already closed */
          }
        });
        channel.on("error", () => sock.destroy());
      });

      // -R: client asks us to listen for it. Enabled only when reversePort is
      // configured; bindPort is IGNORED — we bind reversePort and push inbound
      // connections to the client.
      client.on("request", (accept, reject, name, info) => {
        if (name !== "tcpip-forward" && name !== "cancel-tcpip-forward") return reject();
        if (this.reversePort === null) return reject(); // -R not enabled for this domain
        const fwd = this.#remoteForwarders.get(client);
        if (name === "cancel-tcpip-forward") {
          if (fwd) this.#stopRemoteForward(client, fwd);
          accept();
          return;
        }
        if (fwd) {
          accept(fwd.port);
          return;
        }
        // We bind reversePort regardless of what the client asked for, but the
        // client only accepts pushed (forwarded-tcpip) channels for the port IT
        // registered — so remember its bindAddr/bindPort for forwardOut().
        const clientBindAddr = info.bindAddr;
        const clientBindPort = info.bindPort;
        const srv = netServer((sock) => {
          client.forwardOut(clientBindAddr, clientBindPort, sock.remoteAddress ?? "127.0.0.1", sock.remotePort ?? 0, (err, channel) => {
            if (err) {
              sock.destroy();
              return;
            }
            sock.pipe(channel as unknown as Writable);
            (channel as unknown as import("stream").Readable).pipe(sock);
            sock.on("error", () => channel.close());
            channel.on("error", () => sock.destroy());
          });
        });
        const listener = { srv, port: 0 };
        this.#remoteForwarders.set(client, listener);
        srv.on("error", () => {});
        srv.listen(this.reversePort, this.forwardHost, () => {
          listener.port = (srv.address() as { port: number }).port;
          accept(listener.port);
        });
      });
    });

    client.on("close", () => {
      const fwd = this.#remoteForwarders.get(client);
      if (fwd) this.#stopRemoteForward(client, fwd);
    });
  }

  readonly #remoteForwarders = new Map<Connection, { srv: NetServer; port: number }>();

  #stopRemoteForward(client: Connection, fwd: { srv: NetServer; port: number }): void {
    this.#remoteForwarders.delete(client);
    try {
      fwd.srv.close();
    } catch {
      /* not listening */
    }
  }
}
