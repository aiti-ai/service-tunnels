import type { ServicePortInfo } from "./discovery.ts";

/**
 * Internal registry — framework helper ports (nginx/authelia/redis/...).
 *
 * These are owned by the framework itself, NOT user test services. Discovery
 * filters them out (see discovery.ts), and `st.internal.list()` exposes them
 * to the caller separately (e.g. a services dialog showing "framework
 * services" or health checks). The two views never mix.
 */
export class InternalRegistry {
  #byRole = new Map<string, ServicePortInfo>();
  #listeners = new Set<(role: string, info: ServicePortInfo | null) => void>();

  register(role: string, info: ServicePortInfo): void {
    this.#byRole.set(role, { ...info });
    for (const cb of this.#listeners) cb(role, this.#byRole.get(role)!);
  }

  unregister(role: string): void {
    if (this.#byRole.delete(role)) {
      for (const cb of this.#listeners) cb(role, null);
    }
  }

  list(): ServicePortInfo[] {
    return [...this.#byRole.values()].map((i) => ({ ...i }));
  }

  get(role: string): ServicePortInfo | undefined {
    const info = this.#byRole.get(role);
    return info ? { ...info } : undefined;
  }

  /** True when this port belongs to a framework helper (never user service). */
  isInternalPort(port: number): boolean {
    for (const info of this.#byRole.values()) {
      if (info.port === port) return true;
    }
    return false;
  }

  onRoleChanged(cb: (role: string, info: ServicePortInfo | null) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }
}
