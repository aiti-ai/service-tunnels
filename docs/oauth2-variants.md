# OAuth2 变体方案 — 基于 oauth2-proxy 的声明式 auth provider 变体

> 目标：像 `command` 隧道变体（`tunnels-custom.ts`）一样，**用一小段声明
> 定义注册一个 oauth2 auth provider 变体**；固定参数（oauth2-proxy
> `-provider`、端点、scope、凭据）全部**携带**在定义 + 配置档里，
> 页面上**默认填入、零输入直接暴露**，想改现场改（复用 ParamSpec
> `default` 机制——携带值 = 表单字段的默认值）。
>
> 模式参考：oauth2-proxy 自身的 provider 列表（google/github/gitlab/
> keycloak/… + `command` 变体）——每个 provider 只是「一组固定配置 +
> 少量待填参数」。本项目把同样的思想做成**数据驱动**：变体表 = 声明，
> 接线层（expose/proxy-manager/gateway）零改动。内置表 + 环境变量注册
> （`SERVICE_TUNNELS_OAUTH2_VARIANT_*`，§8）两种方式。

## 1. 为什么需要变体

现有 `oauth2-proxy` provider 是"原始 OIDC 手工路径"：expose 表单/CLI 要填
`oidc.issuerUrl / clientId / clientSecret / cookieSecret` 四个字段。对
SaaS IdP（GitHub/Google/GitLab/Microsoft…）端点与 scope 都是**固定的**，
让用户每次手填 issuer 是浪费且易错。

变体方案：内置一张**变体表**，每个变体声明：

- oauth2-proxy 的 `-provider` 值（github/google/gitlab/azure/keycloak-oidc/oidc…）；
- 固定端点（SaaS 变体的 issuer URL、gitlab-url、azure-tenant 等）；
- 固定 scope；
- 凭据来源映射（clientId/clientSecret/issuerUrl 从哪拿：表单 / 站点 / 配置档）；
- 页面表单（凭据未被配置档携带时才出现）。

于是：

```
--auth oauth2-github                          # 配置档已带 clientId/Secret → 页面零输入
--auth oauth2-github --provider-set clientId=x   # 或按需覆盖/现场填
```

## 2. 变体表（内置）

| 变体 id | label | oauth2-proxy `-provider` | 固定参数 | 页面待填（凭据未携带时） |
|---|---|---|---|---|
| `oauth2-github` | GitHub OAuth | github | scope `user:email` | clientId, clientSecret, org(可选) |
| `oauth2-google` | Google OAuth | google | scope `openid,email,profile` | clientId, clientSecret |
| `oauth2-gitlab` | GitLab OAuth | gitlab | scope `openid,email`；gitlab-url=`https://gitlab.com` | clientId, clientSecret, gitlabUrl(可选) |
| `oauth2-microsoft` | Microsoft Entra ID | azure | scope `openid,email,profile`；azure-tenant=`common` | clientId, clientSecret, azureTenant(可选) |
| `oauth2-keycloak` | Keycloak | keycloak-oidc | — | issuerUrl, clientId, clientSecret |
| `oauth2-okta` | Okta | oidc | — | issuerUrl, clientId, clientSecret |
| `oauth2-generic` | 通用 OIDC | oidc | — | issuerUrl, clientId, clientSecret |

> SaaS 变体（github/google/gitlab/microsoft）端点固定；所有变体的凭据一旦由
> 配置档携带，页面表单字段**默认填入**（`default = 携带值`，可编辑覆盖；
> 清空某项 = 回落配置档值）——不输入、不改，直接点「暴露」；想换凭据，
> 改框里内容即可。自托管 IdP 变体（keycloak/okta/generic）的 issuerUrl
> 同样可预先写进配置档自动预填。

## 3. 参数从哪里来（携带 → 默认填入，零输入直点暴露）

优先级（高 → 低）：

```
1. 表单 / CLI --provider-set / 站点 providerParams   （现场覆盖，改框里内容）
2. 配置档 auth.oauth2.variants.<变体id>              （按变体携带）
3. 配置档 auth.oauth2（共享凭据）                    （一组凭据多个变体复用）
4. 配置档 auth.oidc（旧字段，向后兼容）              （原始 oauth2-proxy 路径）
5. 变体定义内置固定参数（端点/scope）
6. 缺 → validate() 报错并给出补法提示
```

携带值作为表单字段的 **default**（复用 ParamSpec 机制）：页面上看到的是
预填好的字段，不输入不改直接暴露；改了就
以表单值为准（优先级 1）；把某字段清空提交 = 该字段不提交 → 回落配置档值。

**秘密字段（clientSecret 等 `type: "password"` 字段）不回显明文**：页面只显示
「已由配置档提供」提示（`secretSet`），value 不写、schema JSON 不含明文——
浏览器与页面源码都看不到；留空提交 = 回落配置档值，填写 = 覆盖。自定义
变体中 token 名含 `secret`/`password` 的（如 `{{clientSecret}}`）自动按秘密
字段处理。

### 配置档形态（`configDir/service-tunnels.json`）

```jsonc
{
  "auth": {
    // —— 变体共享凭据（所有 oauth2-* 变体共用）——
    "oauth2": {
      "clientId": "...",
      "clientSecret": "...",
      "cookieSecret": "",            // 可选；留空自动生成
      "variants": {                  // 按变体覆盖/补齐
        "oauth2-github":   { "clientId": "...", "clientSecret": "..." },
        "oauth2-keycloak": { "issuerUrl": "https://auth.example.com/realms/myrealm",
                             "clientId": "...", "clientSecret": "..." }
      }
    },
    // —— 旧字段（原始 oauth2-proxy 路径，向后兼容）——
    "oidc": { "issuerUrl": "...", "clientId": "...", "clientSecret": "..." }
  }
}
```

## 4. 实现

### 4.1 `src/providers/oauth2-variants.ts`（新增，变体表）

```ts
interface OAuth2VariantDef {
  id: string;                       // 注册名 = auth provider type（"oauth2-github"）
  label: string;                    // 页面显示名
  description?: string;
  provider: string;                 // oauth2-proxy -provider 值
  issuerUrl?: string;               // 固定 issuer（SaaS 变体）
  scope?: string;                   // 固定 scope
  flags?: Record<string, string>;   // 固定额外配置键（如 gitlab-url）
  form: VariantParamSpec[];         // 待填参数（凭证未携带时页面显示）
  creds: Record<string, string>;    // 表单 key → 配置档键（携带即从表单消失）
}
```

- `readOAuth2VariantConfig(configDir)`：读 `auth.oauth2` + 旧 `auth.oidc`；
- `resolveVariantCreds(def, configDir, opts)`：按 §3 优先级合并，返回
  `{ values, sources }`（sources 供 `validate()`/页面显示"凭据来自配置"）；
- `oauth2VariantParamSchemas(configDir)`：每个变体生成 `ParamSpec[]`——
  **配置档携带的字段默认填入**（`default = 携带值`），不删除、可编辑；
- `authProviderMetas(configDir)`：每个 provider 的 `{ label, description,
  configured, needsInput, kind }`（页面渲染 picker + "✓已配置/已预填" 徽标）。

### 4.2 `src/providers/oauth2-proxy.ts`（变体支持）

- `OAuth2ProxyProviderOptions.variant?: string`；构造时 `type` 动态化
  （`oauth2-github` 等）；缺省保持 `"oauth2-proxy"` 原始路径（向后兼容）；
- `prepare()`：变体路径把解析结果写成 oauth2-proxy TOML——
  `provider = def.provider`、`oidc_issuer_url`（变体固定或解析值）、
  `client_id/client_secret/cookie_secret`、`scope`、`def.flags` +
  表单 flag 字段（`org → github-org`、`gitlabUrl → gitlab-url`、
  `azureTenant → azure-tenant`）；
- `validate()`：变体路径缺必填（表单 required 且未携带）→ 报
  `oauth2-github: missing clientSecret — set config.json auth.oauth2 or pass clientSecret`；
- 配置注入防护不变：所有写进 TOML 的值先过 `validateOidcUrl/Secret`
  （控制字符拒绝）再 `tomlEscape`；
- `setupConfig()` 设置页带上变体 label/issuer。

### 4.3 `src/auth-registry.ts`（注册 + 表单/元数据）

- 构造器为每个变体注册工厂：`(c, o) => new OAuth2ProxyProvider(c, {...o, variant})`；
- `authProviderSchemas(configDir)` 合并变体动态 schema（依赖配置档）；
- 新增 `authProviderMetas(configDir)`。

### 4.4 接线层改动（最小）

| 文件 | 改动 |
|---|---|
| `src/config.ts` | `ServiceTunnelsConfigFile.auth?: { oidc?, oauth2? }` |
| `src/index.ts` | `schemas.authMetas()`；`providerOrder()` 变体按「已配置优先」排序 |
| `src/daemon-server.ts` | `/schemas` 返回 `authMetas`；`expose` 校验 `providerParams` 为对象 |
| `src/ui.ts` | 暴露页 auth 下拉数据驱动（label + ✓已配置），按需渲染变体参数输入框，POST 带 `providerParams` |
| `src/cli.ts` | 零改动（`--auth oauth2-github` 直接可用；`--provider-set` 已按 schema 校验） |

## 5. 安全

- 变体固定参数是**内置常量**（不受用户输入影响）；用户输入只进
  `validateOidcUrl/Secret`（控制字符/长度拒绝）→ `tomlEscape`（防 TOML 注入，
  同 frpc INI 注入同类防护）；
- 表单字段 key 白名单 = 变体 `form` 声明；CLI `--provider-set` 走
  `applyParamSets`（未知 key 报错）；daemon RPC 校验 `providerParams` 为对象；
- `clientSecret` 永不写入日志/状态文件（沿用现有脱敏策略）；
- 每个变体是独立 `type#site` 实例 → 独立侧车端口、独立配置、独立用户库目录。

## 6. 使用示例

```bash
# 1) 配置档携带凭据后，页面/CLI 零输入
sts expose 3000 --auth oauth2-github --tunnel cloudflared

# 2) 或现场填（优先级最高）
sts expose 3000 --auth oauth2-keycloak \
  --provider-set issuerUrl=https://auth.example.com/realms/myrealm \
  --provider-set clientId=myapp --provider-set clientSecret=***

# 3) 站点级携带（site add 存 providerParams）
sts site add host --provider oauth2-google --provider-set clientId=... --provider-set clientSecret=...
sts expose 8080 --site host --auth oauth2-google

# 4) 页面：快速暴露 → 认证方式选「GitHub OAuth ✓已配置」→ 暴露
```

OIDC 回调白名单/域名验证文件机制与原始 oauth2-proxy provider 完全一致
（`/oauth2/callback` 需在 IdP 注册；`setupConfig` 设置页 + 验证文件联动）。

## 7. 扩展：加一个新变体

1. `oauth2-variants.ts` 变体表加一条（label/provider/固定参数/form/creds）；
2. 注册自动完成（registry 遍历表）；表单/页面/CLI/元数据全自动；
3. 用户侧也可在 `configDir/providers/*.js` 用 `paramSchemas` 导出
   叠加自定义变体（沿用现有插件机制）。

对照「加一个新 provider」检查清单（docs/auth-provider.md §9）：本次只加
**声明**，不写类、不写接线、不写表单——全部继承 oauth2-proxy 侧车实现。

## 8. 环境变量注册（类似 command 隧道，零代码）

像 `SERVICE_TUNNELS_TUNNEL_COMMAND_<NAME>` 注册隧道类型一样，环境变量
`SERVICE_TUNNELS_OAUTH2_VARIANT_<NAME>` 注册一个自定义 oauth2 变体
（新 provider 类型 = `oauth2-<name>`，小写）：

```bash
# 声明：key=value 用 ; 分隔；键自动归一化为 oauth2-proxy TOML 键
#   issuerUrl → oidc_issuer_url；clientId → client_id；kebab/camel 均可
# 值里的 {{token}} → 表单必填参数；{{token:default}} → 可选带默认值
# 固定值（无占位符）直接携带（页面上默认填入）
export SERVICE_TUNNELS_OAUTH2_VARIANT_MYIDP=\
  "provider=oidc;issuerUrl=https://auth.example.com/realms/r;"\
  "clientId={{clientId}};clientSecret={{clientSecret}};"\
  "gitlab-url={{gitlabUrl:https://gitlab.com}};github-org={{org}};"

sts expose 3000 --auth oauth2-myidp              # 表单填 clientId/Secret（可配置档携带预填）
sts expose 3000 --auth oauth2-myidp --provider-set clientId=x --provider-set clientSecret=y
```

- 声明里的键可写任意 oauth2-proxy 配置项（`provider`/`scope`/`gitlab_url`/
  `github_org`/`azure_tenant`/…甚至 `command`——oauth2-proxy 的 command
  provider 也能这么声明）；
- 列表型键（`github_org`/`github_team`/`allowed_groups`/`email_domains`）
  自动写 TOML 数组（值逗号分隔）；
- `{{token}}` 仍可用配置档 `auth.oauth2.variants.<id>` 携带 → 表单默认填入
  （与内置变体同一套机制）；
- 缺必填 token / 值含控制字符 → 启动前 fail-fast（`validate()`/`prepare()`），
  值一律 TOML 转义；
- 无效名（非 `[a-z0-9][a-z0-9_-]*`）、遮蔽内置变体（如 `oauth2-github`）
  → 警告跳过（与 command 隧道同策略）。
