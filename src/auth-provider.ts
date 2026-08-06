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
  /** Register a spawned helper PID for guardian cleanup (all active spawns). */
  registerPid: (role: string, pid: number) => void;
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

/** 免认证直达内容（域名验证文件 + 预登录设置页）——oauth2-proxy 等 IdP 联动场景。 */
export interface ProviderSetup {
  verification: Array<{ path: string; content: string }>;
  /** 预登录设置页路径（缺省关闭）。 */
  infoPath?: string;
  /** 设置页 HTML 模板（nginx $host/$arg_rd 变量形式）。 */
  infoHtmlTemplate?: string;
  /** 设置页 HTML 渲染（node proxy 手动替换变量）。 */
  infoHtml?: (host: string, next: string) => string;
}

/** 验证条目插进 nginx 配置前的白名单校验（防配置注入）：
 *  - path：仅 URL 路径字符（`/` 开头，字母数字 `._~-` 与 `/`），禁止
 *    `;{}'\"` 空白换行（会断 nginx 指令）与 `..`；
 *  - content：单行、无单引号/反斜杠（`return 200 '...'` 字符串边界）。
 *  非法 → 抛错（注册失败并显式暴露配置错误，不静默丢弃）。 */
export function validateSetupEntry(v: { path: string; content: string }): void {
  const path = typeof v?.path === "string" ? v.path : "";
  if (!/^\/[a-zA-Z0-9._~\/-]+$/.test(path) || path.includes("..") || path.length > 256) {
    throw new Error(`invalid verification path (must be a URL path of [a-zA-Z0-9._~/-]): ${JSON.stringify(path)}`);
  }
  const content = typeof v?.content === "string" ? v.content : "";
  if (content.length > 512 || /['\r\n\\]/.test(content)) {
    throw new Error("invalid verification content: must be a single-line string without quotes/backslashes");
  }
}

/** URL 路径前缀白名单校验（认证放行 bypass 用，插进 nginx `location <path>`）：
 *  仅 `/` 开头的 URL 路径字符，禁 `;{}'\"` 空白换行（断 nginx 指令）与 `..`；
 *  **禁止 `/`（根）**——会匹配全部路径导致认证整体逃逸（Node proxy 前缀匹配
 *  必然命中；nginx 会因重复 `location /` 拒绝启动）。想完全免认证请用
 *  `--auth none`，而不是白名单根路径。 */
export function validateBypassPaths(paths: unknown): string[] {
  const list = Array.isArray(paths) ? paths : typeof paths === "string" ? [paths] : [];
  return list.map((p) => {
    if (typeof p !== "string" || !/^\/[a-zA-Z0-9._~\/-]*$/.test(p) || p.includes("..") || p.length > 256) {
      throw new Error(`invalid bypass path (must be a URL path of [a-zA-Z0-9._~/-]): ${JSON.stringify(p)}`);
    }
    if (p === "/") {
      throw new Error("invalid bypass path: '/' would bypass ALL auth — use --auth none instead");
    }
    return p;
  });
}

export interface AuthProvider {
  readonly type: string;
  /** Site (auth realm) this instance belongs to ("default" when absent). */
  readonly site?: string;
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

  /** 未认证时的登录跳转目标模板（$host/$request_uri 变量；scheme 本地 http /
   *  隧道 https）。缺省：portal 风格 `${basePath}/login?next=$request_uri`。
   *  Provider 自描述——接线层不再按 type 分支（expose/proxy 都调它）。 */
  loginRedirect?(basePath: string, scheme: "http" | "https"): string;

  /** 网关/门禁认证模式（nginx authMode + node proxy 探针协议）。缺省
   *  "forward-auth"（探针式）；"oauth2-proxy"（/oauth2/ 协议）；"basic"
   *  （nginx auth_basic，无 basePath、无登录页）。 */
  readonly gatewayMode?: "forward-auth" | "oauth2-proxy" | "basic";
  /** 认证探针路径（缺省 `${basePath}/api/authz/auth-request`）。oauth2-proxy
   *  用固定 `/oauth2/auth`。 */
  readonly authzPath?: string;
  /** 直达 provider 的路径前缀（oauth2-proxy: ["/oauth2"]——登录/回调不经探针）。 */
  readonly providerPaths?: string[];
  /** 默认 basePath 命名策略（缺省 "/{type}"；basic → ""）。 */
  defaultBasePath?(): string;
  /** 登录后展示地址 loginUrl（缺省 `${url}${basePath}/login`；basic 无 → undefined）。 */
  loginUrl?(url: string, basePath: string): string | undefined;
  /** 免认证直达：域名验证文件 + 预登录设置页（oauth2-proxy 等 IdP 联动场景）。 */
  setupConfig?(): ProviderSetup | undefined;

  /** Pre-flight: missing binary / missing OIDC registration → reject. */
  validate?(): Promise<string[]>;
}

export type AuthProviderFactory = (ctx: ProviderContext, opts?: Record<string, unknown>) => AuthProvider;

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

export const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
export function randomAlnum(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += ALNUM[Math.floor(Math.random() * ALNUM.length)];
  return out;
}

const BASE_ADJECTIVES = [
  "fuzzy", "wobbly", "sneaky", "cosmic", "jolly", "mellow", "zippy", "quirky",
  "lucky", "crimson", "brisk", "witty", "dizzy", "spicy", "frosty", "peachy",
  "snazzy", "twisty", "velvet", "bouncy",
];
const BASE_ANIMALS = [
  "narwhal", "wombat", "capybara", "platypus", "axolotl", "llama", "gecko",
  "badger", "otter", "moose", "panda", "raccoon", "sloth", "tapir", "lemur",
  "ferret", "ibex", "kitten", "puffin", "dragon",
];

/** 随机趣味名（portal 等 provider 的默认 basePath 用）。 */
export function randomName(): string {
  const a = BASE_ADJECTIVES[Math.floor(Math.random() * BASE_ADJECTIVES.length)]!;
  const n = BASE_ANIMALS[Math.floor(Math.random() * BASE_ANIMALS.length)]!;
  return `${a}-${n}`;
}
