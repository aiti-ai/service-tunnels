/**
 * AuthProvider interface — pluggable auth for the gateway (design.md §5).
 *
 * Mainline is the LOCAL GATEWAY model: all tunnels are pure transports to the
 * local nginx gateway port; auth is decided 100% locally via nginx
 * auth_request → provider (default: Authelia forward-auth). Edge-auth
 * providers (ngrok edge-oidc) are optional plugins that do not start local
 * processes.
 *
 * Authelia is the built-in default, NOT the only option: providers are
 * registered via a factory (built-in authelia/basic; plugins from the
 * providers/ directory, npm packages, or authPlugins at construction).
 */

export interface AuthPolicy {
  policy?: "one_factor" | "two_factor" | "deny";
  subject?: string[];
  methods?: string[];
}

export interface ProviderContext {
  configDir: string;
  cacheDir: string;
  /** Resolve a tool (PATH > cache > download) — e.g. authelia. */
  resolveTool: (name: string) => Promise<string>;
  /** Register a framework helper port (nginx/authelia/redis). */
  registerInternal: (role: string, port: number) => void;
  unregisterInternal: (role: string) => void;
  /** Find a free local port (0 = kernel-assigned). */
  pickPort: () => Promise<number>;
  log: (line: string) => void;
}

export interface AuthProviderStatus {
  running: boolean;
  /** Local gateway port (authelia forward-auth endpoint behind nginx). */
  port?: number;
}

export interface AuthProviderCapabilities {
  /** Local nginx auth_request backend (mainline). */
  localGateway: boolean;
  /** Auth at the tunnel/edge (optional plugin, e.g. ngrok edge-oidc). */
  edgeAuth: boolean;
  /** Supports randomly-changing public hosts (dynamic registration). */
  randomDomain: boolean;
  /** One instance serves multiple hosts. */
  multiHost: boolean;
  /** Needs a session store (Redis for authelia; oauth2-proxy/basic don't). */
  needsSessionStore: boolean;
}

export interface AuthProvider {
  readonly type: string;
  readonly capabilities: AuthProviderCapabilities;

  /** Green start / config prepare (idempotent). */
  prepare(): Promise<AuthProviderStatus>;
  start(): Promise<AuthProviderStatus>;
  stop(): Promise<void>;
  status(): AuthProviderStatus;

  /** Register a public host under auth (dynamic registration). */
  registerHost(host: string, policy?: AuthPolicy): Promise<void>;
  unregisterHost(host: string): Promise<void>;
  listHosts(): Promise<string[]>;

  /** Local gateway: nginx auth_request snippet (empty for edge providers). */
  renderNginxAuth?(): string;
  /**
   * Re-bind the provider's base path (registry instances are cached per type
   * and may have been created without one — expose() fixes it up so nginx
   * auth_request and the provider agree). Optional; providers without it keep
   * a fixed path.
   */
  setBasePath?(path: string): Promise<void>;
  /** Edge providers: tunnel auth params (e.g. ngrok traffic policy). */
  renderTunnelAuth?(): Record<string, unknown>;

  /** Pre-flight: missing binary / missing OIDC registration → reject. */
  validate?(): Promise<string[]>;
}

export type AuthProviderFactory = (ctx: ProviderContext) => AuthProvider;

/** A registered user (no secrets) — provider-local meaning of displayName/email. */
export interface AuthUser {
  name: string;
  displayName: string;
  email?: string;
}

/**
 * Optional capability: provider keeps a LOCAL user database (authelia
 * users_database.yml, basic htpasswd, ...). Detect via `typeof provider
 * .listUsers === "function"` — providers without it simply don't appear in
 * user-management listings.
 */
export interface UserManager {
  /** Registered users under THIS provider (no secrets). */
  listUsers(): Promise<AuthUser[]>;
  /** Add or update (displayName/email only) a user. */
  addUser(name: string, password: string, displayName?: string, email?: string): Promise<void>;
  /** Change a user's password. */
  setUserPassword(name: string, password: string): Promise<void>;
  /** Remove a user. */
  removeUser(name: string): Promise<void>;
}

export function isUserManager(p: AuthProvider): p is AuthProvider & UserManager {
  return typeof (p as unknown as UserManager).listUsers === "function";
}
