import { readConfigFile } from "../config.ts";
import type { ParamSpec } from "../tunnels.ts";

/**
 * OAuth2 provider variants — declarative, like the `command` tunnel variant
 * (tunnels-custom.ts): one small definition registers a first-class auth
 * provider type whose fixed parameters (oauth2-proxy `-provider`, endpoints,
 * scopes) are CARRIED by the definition + config file — the expose page
 * prefills them (zero-input expose), the user can edit in place.
 *
 * 两种注册方式：
 *   1. 内置变体表 OAUTH2_VARIANTS（随包发布，docs/oauth2-variants.md）；
 *   2. 环境变量注册自定义变体（像 command 隧道一样零代码）：
 *
 *        SERVICE_TUNNELS_OAUTH2_VARIANT_<NAME>="provider=oidc;issuerUrl={{issuerUrl}};clientId={{clientId}};clientSecret={{clientSecret}}"
 *
 *      → 新 provider 类型 `oauth2-<name>`；`key=value` 用 `;` 分隔，键名自动
 *      归一化为 oauth2-proxy TOML 键（issuerUrl → oidc_issuer_url、kebab →
 *      snake）；值里的 `{{token}}` 变成表单参数（required），`{{token:default}}`
 *      为可选带默认值（复用 ParamSpec default 预填机制）。固定值（无占位符）
 *      直接携带。声明里的键可写任意 oauth2-proxy 配置项（provider/scope/
 *      gitlab_url/github_org/command/...）。
 *
 * 凭据来源优先级（高 → 低）：
 *   1. 表单 / CLI --provider-set / 站点 providerParams（现场覆盖）
 *   2. 配置档 auth.oauth2.variants.<id>（按变体携带）
 *   3. 配置档 auth.oauth2（共享凭据）
 *   4. 配置档 auth.oidc（旧字段，向后兼容）
 *   5. 变体定义内置固定参数（端点/scope/{{token:default}} 默认值）
 *   6. 缺 → validate() 报错并给出补法提示
 */

/** 变体表单参数：复用 ParamSpec 结构（页面渲染同一套 render），外加
 *  `flag`——映射到的 oauth2-proxy 配置键（缺省 = key 本身）；`list`——
 *  列表型配置键（github_org 等），写 TOML 数组。 */
export interface VariantParamSpec extends ParamSpec {
  flag?: string;
  /** 列表型配置键：值逗号分隔 → TOML 数组（github_org/github_team...）。 */
  list?: boolean;
}

/** 自定义变体（环境变量注册）的配置行：`key = template`，template 里可含
 *  `{{token}}` / `{{token:default}}` 占位符（运行时用解析值替换）。 */
export interface OAuth2VariantLine {
  /** oauth2-proxy TOML 配置键（snake_case）。 */
  key: string;
  /** 值模板（固定文本 + 占位符）。 */
  template: string;
}

export interface OAuth2VariantDef {
  /** 注册名 = auth provider type（"oauth2-github"）。 */
  id: string;
  /** 页面显示名。 */
  label: string;
  description?: string;
  /** oauth2-proxy `-provider` 值。 */
  provider: string;
  /** 固定 OIDC issuer（SaaS 变体）；缺省 = 由表单/配置档提供。 */
  issuerUrl?: string;
  /** 固定 -scope（逗号分隔）。 */
  scope?: string;
  /** 固定额外 oauth2-proxy 配置键。 */
  flags?: Record<string, string>;
  /** 待填参数（配置档携带/默认值预填 → 零输入直点暴露；缺的字段才需要手填）。 */
  form: VariantParamSpec[];
  /** 表单 key → 配置档键 的映射：配置档携带该键后，表单字段**默认填入**
   *  （default = 携带值；不删除，可编辑覆盖；清空 = 回落配置档）。 */
  creds: Record<string, string>;
  /** 环境变量注册的自定义变体：原始配置行（provider/issuer/scope/其他键都
   *  在里面；运行时替换占位符后逐行写入 conf）。内置变体无此字段。 */
  lines?: OAuth2VariantLine[];
  /** 注册来源（"builtin" | "env:<VAR>"），元数据展示用。 */
  source?: "builtin" | string;
}

/** 配置档 auth.oauth2 形态（configDir/service-tunnels.json）。 */
export interface OAuth2VariantCredsFile {
  clientId?: string;
  clientSecret?: string;
  cookieSecret?: string;
  /** 按变体 id 的凭据覆盖（如 { "oauth2-github": { clientId, clientSecret } }）。 */
  variants?: Record<string, Record<string, string>>;
}

/** 环境变量注册自定义变体的前缀（类似 SERVICE_TUNNELS_TUNNEL_COMMAND_*）。
 *  例：SERVICE_TUNNELS_OAUTH2_VARIANT_MYIDP="provider=oidc;..." → 类型
 *  oauth2-myyidp。 */
export const OAUTH2_VARIANT_ENV_PREFIX = "SERVICE_TUNNELS_OAUTH2_VARIANT_";

/** 自定义变体类型名 charset（字母/数字/_/-，小写，不以 - 开头）。 */
const TYPE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** `{{token}}` / `{{token:default}}` 占位符解析（同 tunnels-custom）。 */
const TOKEN_RE = /\{\{([a-zA-Z0-9_.-]+)(?::([^}]*))?\}\}/g;

/** 自定义声明里列表型配置键 → 写 TOML 数组（值逗号分隔）。 */
const LIST_KEYS = new Set(["github_org", "github_team", "allowed_groups", "email_domains"]);

/**
 * 内置变体表。字段值（provider 名、scope、端点）与 oauth2-proxy 7.6.0
 * 的 provider 定义对齐；配置键一律 snake_case（oauth2-proxy TOML 约定：
 * 配置键 = CLI flag 的 `-` 换成 `_`）。SaaS 变体端点固定（页面上只有凭据
 * 可填），自托管变体（keycloak/okta/generic）必须提供 issuerUrl（配置档
 * 携带后同样零输入）。
 */
export const OAUTH2_VARIANTS: OAuth2VariantDef[] = [
  {
    id: "oauth2-github",
    label: "GitHub OAuth",
    description: "GitHub 账号登录（端点固定，只需 Client ID/Secret）",
    provider: "github",
    scope: "user:email",
    form: [
      { key: "clientId", label: "Client ID", required: true, placeholder: "Ov23li..." },
      { key: "clientSecret", label: "Client Secret", type: "password", required: true },
      {
        key: "org",
        label: "GitHub 组织（可选）",
        flag: "github_org",
        list: true,
        placeholder: "my-org",
        description: "仅允许该组织的成员登录（留空=所有 GitHub 用户；多个用逗号分隔）",
      },
    ],
    creds: { clientId: "clientId", clientSecret: "clientSecret" },
  },
  {
    id: "oauth2-google",
    label: "Google OAuth",
    description: "Google 账号登录（端点固定，只需 Client ID/Secret）",
    provider: "google",
    scope: "openid,email,profile",
    form: [
      { key: "clientId", label: "Client ID", required: true, placeholder: "xxxx.apps.googleusercontent.com" },
      { key: "clientSecret", label: "Client Secret", type: "password", required: true },
    ],
    creds: { clientId: "clientId", clientSecret: "clientSecret" },
  },
  {
    id: "oauth2-gitlab",
    label: "GitLab OAuth",
    description: "GitLab 账号登录（SaaS 默认 https://gitlab.com）",
    provider: "gitlab",
    scope: "openid,email",
    flags: { gitlab_url: "https://gitlab.com" },
    form: [
      { key: "clientId", label: "Client ID", required: true },
      { key: "clientSecret", label: "Client Secret", type: "password", required: true },
      {
        key: "gitlabUrl",
        label: "GitLab 地址（可选）",
        flag: "gitlab_url",
        placeholder: "https://gitlab.example.com",
        description: "自建 GitLab 填站点地址；留空用 gitlab.com",
      },
    ],
    creds: { clientId: "clientId", clientSecret: "clientSecret" },
  },
  {
    id: "oauth2-microsoft",
    label: "Microsoft Entra ID",
    description: "Microsoft Entra（Azure AD）账号登录",
    provider: "azure",
    scope: "openid,email,profile",
    flags: { azure_tenant: "common" },
    form: [
      { key: "clientId", label: "Client ID（Application ID）", required: true },
      { key: "clientSecret", label: "Client Secret", type: "password", required: true },
      {
        key: "azureTenant",
        label: "Tenant（可选）",
        flag: "azure_tenant",
        placeholder: "common",
        description: "留空 = common（多租户）",
      },
    ],
    creds: { clientId: "clientId", clientSecret: "clientSecret" },
  },
  {
    id: "oauth2-keycloak",
    label: "Keycloak",
    description: "Keycloak（keycloak-oidc；需 Realm 的 OIDC issuer 地址）",
    provider: "keycloak-oidc",
    scope: "openid,email,profile",
    form: [
      {
        key: "issuerUrl",
        label: "OIDC Issuer URL",
        required: true,
        placeholder: "https://auth.example.com/realms/myrealm",
      },
      { key: "clientId", label: "Client ID", required: true },
      { key: "clientSecret", label: "Client Secret", type: "password", required: true },
    ],
    creds: { issuerUrl: "issuerUrl", clientId: "clientId", clientSecret: "clientSecret" },
  },
  {
    id: "oauth2-okta",
    label: "Okta",
    description: "Okta（OIDC 协议；需 Okta 的 issuer 地址）",
    provider: "oidc",
    scope: "openid,email,profile",
    form: [
      {
        key: "issuerUrl",
        label: "OIDC Issuer URL",
        required: true,
        placeholder: "https://my-org.okta.com/oauth2/default",
      },
      { key: "clientId", label: "Client ID", required: true },
      { key: "clientSecret", label: "Client Secret", type: "password", required: true },
    ],
    creds: { issuerUrl: "issuerUrl", clientId: "clientId", clientSecret: "clientSecret" },
  },
  {
    id: "oauth2-generic",
    label: "通用 OIDC",
    description: "任意标准 OIDC IdP（provider = oidc）",
    provider: "oidc",
    scope: "openid,email,profile",
    form: [
      {
        key: "issuerUrl",
        label: "OIDC Issuer URL",
        required: true,
        placeholder: "https://accounts.example.com",
      },
      { key: "clientId", label: "Client ID", required: true },
      { key: "clientSecret", label: "Client Secret", type: "password", required: true },
    ],
    creds: { issuerUrl: "issuerUrl", clientId: "clientId", clientSecret: "clientSecret" },
  },
];

// ——————————————————————————————————————————————————————————————————————————
// 环境变量注册的自定义变体（类似 tunnels-custom.ts 的 command 隧道）
// ——————————————————————————————————————————————————————————————————————————

/** 保留 id：内置变体 + oauth2-proxy 家族名（env 注册不得遮蔽）。 */
const RESERVED_IDS = new Set([...OAUTH2_VARIANTS.map((v) => v.id), "oauth2", "oauth2-proxy"]);

/** 声明键名归一化 → oauth2-proxy TOML 键（snake_case）。友好别名映射：
 *  issuerUrl/issuer-url/issuer_url → oidc_issuer_url；clientId/client-id →
 *  client_id 等（大小写/连字符/下划线均可）。 */
function normalizeLineKey(raw: string): string {
  const snake = raw.toLowerCase().replace(/-/g, "_");
  const ALIASES: Record<string, string> = {
    provider: "provider",
    issuerurl: "oidc_issuer_url",
    clientid: "client_id",
    clientsecret: "client_secret",
    cookiesecret: "cookie_secret",
    scope: "scope",
    setxauthrequest: "set_xauthrequest",
  };
  return ALIASES[snake.replace(/_/g, "")] ?? snake;
}

/** 框架托管键：http_address/upstreams 恒由 provider 生成，声明里写会被忽略
 *  （避免与内置默认重复产生 TOML 键冲突）。 */
const MANAGED_KEYS = new Set(["http_address", "upstreams"]);

/** 解析一条 `key=value;...` 声明 → 变体定义（非法声明 → null + 警告原因）。
 *  - 必须含固定 `provider`（值内不能有占位符）与至少一个配置行；
 *  - `{{token}}` → 必填表单字段；`{{token:default}}` → 可选带默认值；
 *  - 固定值（无占位符）直接携带；键全部归一化为 snake_case TOML 键。 */
export function parseOAuth2VariantDeclaration(id: string, declaration: string): OAuth2VariantDef | null {
  const lines: OAuth2VariantLine[] = [];
  let provider = "";
  let providerTemplated = false;
  const tokens = new Map<string, string | undefined>(); // token → default(undefined=必填)
  for (const seg of declaration.split(";")) {
    const s = seg.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    if (eq <= 0) {
      console.warn(`[service-tunnels] oauth2 variant ${id}: skipping segment "${s}" (expected key=value)`);
      continue;
    }
    const key = normalizeLineKey(s.slice(0, eq).trim());
    const template = s.slice(eq + 1).trim();
    if (!key || !template) continue;
    if (key === "provider") {
      if (TOKEN_RE.test(template)) providerTemplated = true;
      else provider = template;
      continue;
    }
    if (MANAGED_KEYS.has(key)) {
      console.warn(`[service-tunnels] oauth2 variant ${id}: "${key}" is managed by the provider — skipping`);
      continue;
    }
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(template))) {
      const token = m[1] ?? "";
      if (!tokens.has(token)) tokens.set(token, m[2] ?? undefined);
    }
    lines.push({ key, template });
  }
  if (!provider || providerTemplated) {
    console.warn(`[service-tunnels] oauth2 variant ${id}: requires a fixed provider (e.g. provider=oidc)`);
    return null;
  }
  if (!lines.length) {
    console.warn(`[service-tunnels] oauth2 variant ${id}: no config lines declared`);
    return null;
  }
  const form: VariantParamSpec[] = [...tokens.entries()].map(([token, def]) => ({
    key: token,
    label: token,
    ...(def !== undefined ? { default: def, required: false } : { required: true }),
    // token 名含 secret/password → 秘密字段（页面不回显明文，见 secretSet）
    ...(/secret|password/i.test(token) ? { type: "password" as const } : {}),
    description: def !== undefined
      ? `固定参数(默认 ${def})，替换声明中的 {{${token}}}`
      : `必填，替换声明中的 {{${token}}}`,
  }));
  const creds: Record<string, string> = {};
  for (const [token] of tokens) creds[token] = token;
  return {
    id,
    label: id.startsWith("oauth2-") ? id.slice("oauth2-".length) : id,
    description: "环境变量注册的 oauth2 变体（SERVICE_TUNNELS_OAUTH2_VARIANT_*）",
    provider,
    form,
    creds,
    lines,
    source: "env",
  };
}

/** 读取全部 SERVICE_TUNNELS_OAUTH2_VARIANT_* 注册（无效名/遮蔽内置 → 警告跳过）。 */
export function customOAuth2Variants(): OAuth2VariantDef[] {
  const out: OAuth2VariantDef[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(OAUTH2_VARIANT_ENV_PREFIX)) continue;
    const name = key.slice(OAUTH2_VARIANT_ENV_PREFIX.length).toLowerCase();
    const id = `oauth2-${name}`;
    if (!TYPE_NAME_RE.test(name) || RESERVED_IDS.has(id)) {
      console.warn(
        `[service-tunnels] skipping ${key}: invalid or conflicting variant name "${name}"` +
          ` (expected letters/digits/_- lowercase, not a built-in oauth2 variant)`,
      );
      continue;
    }
    const def = parseOAuth2VariantDeclaration(id, (value ?? "").trim());
    if (def) {
      def.source = `env:${key}`;
      out.push(def);
    }
  }
  return out;
}

/** 全部变体：内置 + 环境变量注册（注册顺序：内置在前，env 按变量序）。 */
export function allOAuth2Variants(): OAuth2VariantDef[] {
  return [...OAUTH2_VARIANTS, ...customOAuth2Variants()];
}

/** 变体 id → 定义（未知 id → undefined）。 */
export function oauth2Variant(id: string): OAuth2VariantDef | undefined {
  return allOAuth2Variants().find((v) => v.id === id);
}

/** 全部变体 id（注册顺序）。 */
export function oauth2VariantIds(): string[] {
  return allOAuth2Variants().map((v) => v.id);
}

/** 全部变体 id 集合。 */
export function oauth2VariantIdSet(): Set<string> {
  return new Set(oauth2VariantIds());
}

/** 替换模板里的占位符：`{{token}}` → values[token]（缺省 → `{{token:default}}`
 *  的默认值；都没有 → 空串）。查找大小写不敏感（{{clientId}} == {{CLIENTID}}）。
 *  用于自定义变体配置行组装。 */
export function substituteVariantTemplate(template: string, values: Record<string, string>): string {
  TOKEN_RE.lastIndex = 0;
  return template.replace(TOKEN_RE, (_all, raw: string, def: string | undefined) => {
    const v = values[raw] ?? values[raw.toLowerCase()];
    if (v !== undefined && v !== "") return v;
    return def ?? "";
  });
}

/** 合并配置档凭据（优先级 2/3/4）：按变体 > 共享 > 旧 auth.oidc。 */
export interface OAuth2VariantCreds {
  /** 表单 key → 值（来自配置档；表单/CLI 覆盖不在这里）。 */
  values: Record<string, string>;
  /** 表单 key → 来源描述（"config variants.oauth2-github" 等，供 validate/页面）。 */
  sources: Record<string, string>;
}

export function readOAuth2VariantCreds(configDir: string): OAuth2VariantCreds {
  const cfg = readConfigFile(configDir);
  const oauth2 = cfg.auth?.oauth2 ?? {};
  const legacy = cfg.auth?.oidc ?? {};
  const out: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const pick = (key: string, target: Record<string, string>, source: string): void => {
    if (target[key] !== undefined && target[key] !== null && target[key] !== "" && out[key] === undefined) {
      out[key] = String(target[key]);
      sources[key] = source;
    }
  };
  for (const [vid, creds] of Object.entries(oauth2.variants ?? {})) {
    if (!creds || typeof creds !== "object") continue;
    for (const [k, v] of Object.entries(creds)) {
      if (typeof v !== "string" || v === "") continue;
      if (out[k] === undefined) {
        out[k] = v;
        sources[k] = `config auth.oauth2.variants.${vid}.${k}`;
      }
    }
  }
  for (const k of ["clientId", "clientSecret", "cookieSecret", "issuerUrl"] as const) {
    pick(k, oauth2 as Record<string, string>, `config auth.oauth2.${k}`);
    pick(k, legacy as Record<string, string>, `config auth.oidc.${k}`);
  }
  return { values: out, sources };
}

/**
 * 解析一个变体的完整参数（全优先级）：
 *  - `values`：表单 key → 最终值（显式 opts 覆盖 > 配置档 > 内置固定/默认值）；
 *  - `sources`：key → 来源描述（validate() 缺参提示用）。
 *  opts 为 provider 构造参数（expose 注入 providerParams / site providerParams
 *  unflatten 后的扁平对象）。
 */
export function resolveOAuth2VariantParams(
  def: OAuth2VariantDef,
  configDir: string,
  opts: Record<string, unknown>,
): { values: Record<string, string>; sources: Record<string, string> } {
  const config = readOAuth2VariantCreds(configDir);
  const values: Record<string, string> = {};
  const sources: Record<string, string> = {};
  // 内置固定参数（优先级 5，最低）
  if (def.issuerUrl) {
    values.issuerUrl = def.issuerUrl;
    sources.issuerUrl = `variant ${def.id} (固定)`;
  }
  // 配置档（优先级 2/3/4）
  for (const [k, v] of Object.entries(config.values)) {
    if (values[k] === undefined) {
      values[k] = v;
      sources[k] = config.sources[k] ?? "config";
    }
  }
  // 显式 opts（优先级 1，最高）——表单/CLI/站点 providerParams（大小写不敏感）
  const optsLower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts)) optsLower[k.toLowerCase()] = v;
  for (const spec of def.form) {
    const v = optsLower[spec.key.toLowerCase()];
    if (v !== undefined && v !== null && v !== "") {
      values[spec.key] = String(v);
      sources[spec.key] = "explicit";
    }
  }
  // 可覆盖的预定义参数（scope / 无表单字段的 flags 端点）：显式 opts 覆盖
  // 变体默认（表单/CLI 传 scope=…、gitlab_url=… 等）。
  if (def.scope) {
    const v = optsLower.scope;
    if (v !== undefined && v !== null && v !== "") {
      values.scope = String(v);
      sources.scope = "explicit";
    }
  }
  for (const [flagKey] of Object.entries(def.flags ?? {})) {
    const v = optsLower[flagKey.toLowerCase()];
    if (v !== undefined && v !== null && v !== "") {
      values[flagKey] = String(v);
      sources[flagKey] = "explicit";
    }
  }
  // cookieSecret 不在表单里，单独从 opts/配置档解析（prepare 里自动生成缺省）
  const cookie = opts.cookieSecret;
  if (typeof cookie === "string" && cookie !== "") {
    values.cookieSecret = cookie;
    sources.cookieSecret = "explicit";
  } else if (config.values.cookieSecret !== undefined) {
    values.cookieSecret = config.values.cookieSecret;
    sources.cookieSecret = config.sources.cookieSecret ?? "config";
  }
  // 表单默认值（{{token:default}} / ParamSpec.default）兜底（优先级 5）
  for (const spec of def.form) {
    if (spec.default !== undefined && values[spec.key] === undefined) {
      values[spec.key] = String(spec.default);
      sources[spec.key] = `variant ${def.id} (默认)`;
    }
  }
  return { values, sources };
}

/** 变体必填但未满足的 key（表单 required 且最终值缺失）。 */
export function missingVariantParams(
  def: OAuth2VariantDef,
  values: Record<string, string>,
): string[] {
  return def.form.filter((s) => s.required && (values[s.key] ?? "") === "").map((s) => s.key);
}

/** 变体表单 schema（生成给页面）：在 ParamSpec 上加 `secretSet`——秘密字段
 *  （password）已由配置档携带时页面不回显明文，仅提示「已设置」。 */
export interface OAuth2VariantSchema extends ParamSpec {
  /** 秘密字段已由配置档携带：页面不预填明文，留空 = 回落配置档值。 */
  secretSet?: boolean;
  /** 预定义固定参数（provider/scope/端点等）：只读展示，不可编辑。 */
  fixed?: boolean;
  /** 固定参数的当前值（固定参数用展示；普通参数仍用 default 预填）。 */
  value?: string;
}

/**
 * 每个变体的页面表单：非秘密字段携带 → **默认填入**（default = 携带值，可编辑
 * 覆盖）；**秘密字段（clientSecret 等 password 型）不回显明文**——只标记
 * secretSet（页面显示「已设置」，留空提交 = 回落配置档值），避免 secret 明文
 * 出现在页面 HTML/JS 里。预定义参数（scope/flags 端点、固定 issuerUrl）不再
 * 隐藏——默认值已填入、**可编辑**（用户自建 IdP 可覆盖；提交后库端按显式值
 * 写入）。仅 provider 保持只读（它决定 oauth2-proxy 的 IdP 协议）。
 */
export function oauth2VariantParamSchemas(configDir: string): Record<string, OAuth2VariantSchema[]> {
  const config = readOAuth2VariantCreds(configDir);
  const out: Record<string, OAuth2VariantSchema[]> = {};
  for (const def of allOAuth2Variants()) {
    const specs: OAuth2VariantSchema[] = [];
    // provider 决定 oauth2-proxy 的 IdP 协议——保持只读；其余预定义参数
    // （scope/flags 端点）放开可编辑，默认值 = 变体预设，用户可覆盖。
    if (def.provider) {
      specs.push({
        key: "provider",
        label: "Provider",
        value: def.provider,
        fixed: true,
        description: "oauth2-proxy provider 名（变体固定，不可改）",
      });
    }
    if (def.scope) {
      specs.push({
        key: "scope",
        label: "Scope",
        default: def.scope,
        description: `OAuth scope（默认 ${def.scope}，可覆盖）`,
      });
    }
    // flags（端点等）：已有对应表单字段的（gitlabUrl→gitlab_url、
    // azureTenant→azure_tenant）由该字段编辑，不重复出现；无对应字段的
    // 才补可编辑项（默认值 = 变体常量）。
    for (const [flagKey, flagValue] of Object.entries(def.flags ?? {})) {
      if (def.form.some((s) => s.flag === flagKey)) continue;
      specs.push({
        key: flagKey,
        label: flagKey,
        default: String(flagValue),
        description: "固定配置（端点，可覆盖）",
      });
    }
    // 原始 oauth2-proxy 参数补齐：clientId/clientSecret 已在 def.form；
    // cookieSecret（会话加密密钥）所有变体都放——可选，留空自动生成，
    // 配置档已携带时只标记 secretSet 不回显明文。issuerUrl 仅在需要它的
    // 变体（keycloak/okta/generic，def.form 含 issuerUrl）出现；内置端点
    // 变体（github/google/gitlab/microsoft）由 oauth2-proxy 自带端点，
    // issuerUrl 不适用。
    const carriedCookie = config.values.cookieSecret;
    specs.push(
      carriedCookie
        ? {
            key: "cookieSecret",
            label: "Cookie Secret",
            type: "password",
            secretSet: true,
            placeholder: "已由配置档提供；留空使用配置档值，填写则覆盖",
          }
        : {
            key: "cookieSecret",
            label: "Cookie Secret",
            type: "password",
            description: "会话加密密钥；留空自动生成（跨实例登录态失效时需固定）",
          },
    );
    specs.push(...def.form.map((spec): OAuth2VariantSchema => {
      const cfgKey = def.creds[spec.key];
      const carried = cfgKey ? config.values[cfgKey] : undefined;
      // issuerUrl 固定时不再删除——改只读展示（默认值已填入，不可改）
      if (spec.key === "issuerUrl" && def.issuerUrl) {
        return { ...spec, fixed: true, value: def.issuerUrl, required: false };
      }
      if (!carried) return spec;
      // 秘密字段：明文不进页面；placeholder 提示替换方式
      if (spec.type === "password") {
        return {
          ...spec,
          secretSet: true,
          placeholder: "已由配置档提供；留空使用配置档值，填写则覆盖",
        };
      }
      // 非秘密字段：携带值 → default 预填（可编辑覆盖）
      return { ...spec, default: carried };
    }));
    out[def.id] = specs;
  }
  return out;
}

/** Provider 类型 → 页面元数据（picker 排序/徽标/说明）。 */
export interface AuthProviderMeta {
  label: string;
  description?: string;
  /** 变体：声明式注册的 oauth2-* 类型（内置 + 环境变量注册）。 */
  kind: "builtin" | "oauth2-variant";
  /** 全部必填参数已满足（页面可零输入直接暴露）。 */
  configured: boolean;
  /** 仍需输入的必填参数（configured=false 时）。 */
  needsInput: string[];
}

export function authProviderMetas(configDir: string): Record<string, AuthProviderMeta> {
  const out: Record<string, AuthProviderMeta> = {};
  const config = readOAuth2VariantCreds(configDir);
  for (const def of allOAuth2Variants()) {
    const values: Record<string, string> = {};
    for (const spec of def.form) {
      const cfgKey = def.creds[spec.key];
      const carried = cfgKey && (config.values[cfgKey] ?? "") !== "";
      if (carried || (spec.key === "issuerUrl" && def.issuerUrl) || spec.default !== undefined) {
        values[spec.key] = "1";
      }
    }
    const needsInput = def.form
      .filter((s) => s.required && values[s.key] === undefined)
      .map((s) => s.key);
    out[def.id] = {
      label: def.label,
      description: def.description,
      kind: "oauth2-variant",
      configured: needsInput.length === 0,
      needsInput,
    };
  }
  // 内置类型元数据（label = type；非变体不算「已配置」）
  for (const t of ["authelia", "portal", "basic", "token", "oauth2-proxy"]) {
    out[t] = { label: t, kind: "builtin", configured: true, needsInput: [] };
  }
  return out;
}

/** 列表型配置键判定（自定义变体写 TOML 数组用）。 */
export function isListConfigKey(key: string): boolean {
  return LIST_KEYS.has(key);
}
