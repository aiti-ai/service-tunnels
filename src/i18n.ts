/**
 * 最小依赖多语:零新增 npm 依赖,自实现 catalog lookup。
 *
 * 设计(国际化 npm 包):
 *  - **数据默认英文**:schema 字段(label/description/placeholder/linkTitle)
 *    与 CLI/UI 文案的默认值都是英文;中文(及其他语言)通过语言包覆盖。
 *  - 默认语言英文;探测到中文环境(LANG/LC_ALL 以 zh 开头)或显式
 *    --lang zh / ?lang=zh 才出中文。
 *  - key 形态: `tunnel.<type>.<key>.<field>` / `auth.<type>.<key>.<field>` /
 *    `cli.*` / `ui.*`。schema 字段的翻译 id 由 withSchemaI18nKeys() 自动注入。
 *  - 加语言 = 加一个字典;CLI / API(?lang=) / 设置页共用同一 catalog。
 */
export type Lang = "zh" | "en";

export const CATALOG: Record<Lang, Record<string, string>> = {
  en: {
    // ── CLI ─────────────────────────────────────────────────────────
    "cli.unknownArg": "Unknown argument: {arg}",
    "cli.usage.global": "Global: --config-dir <dir> / --cache-dir <dir> (or SERVICE_TUNNELS_CONFIG/CACHE)",
    "cli.usage.lang": "--lang <zh|en> (default: from LANG / LC_ALL — English unless Chinese)",
    "cli.schemasHint": "Data-driven param schema (clients render forms from this)",

    // ── daemon UI panel ─────────────────────────────────────────────
    "ui.title": "service-tunnels admin panel",
    "ui.nav.dashboard": "Overview",
    "ui.nav.tunnels": "Tunnels",
    "ui.nav.users": "Users",
    "ui.nav.sites": "Sites",
    "ui.nav.config": "Config",
    "ui.nav.expose": "Quick expose",
    "ui.confirmDeleteTunnel": "Delete tunnel {name}?",
    "ui.promptUsername": "Username:",
    "ui.promptPassword": "Password:",
    "ui.confirmDeleteUser": "Delete user {name}?",
    "ui.promptNewPassword": "New password:",
    "ui.totpEnrollTitle": "Enable 2FA for {name}:\n\nAdd in your Authenticator app:\n{otpauth}\n\n{secretHint}",
    "ui.totpEnrollSecretHint": "or enter the secret manually: {secret}\n\n",
    "ui.totpEnrollEnterCode": "Enter the 6-digit code to activate:",
    "ui.totpActivated": "✅ 2FA activated",
    "ui.totpCodeWrong": "❌ Wrong code, try again",
    "ui.confirmDisableTotp": "Disable 2FA?",
    "ui.promptSiteName": "Site name (lowercase letters/digits/hyphens, e.g. host):",
    "ui.promptSiteProvider": "Auth provider (portal/authelia/basic/oauth2-proxy, Enter=auto):",
    "ui.promptSiteDomain": "Site domain (optional, e.g. web.example.com):",
    "ui.confirmDeleteSite": "Delete site {name}?",
    "ui.confirmDeleteSiteUser": "Delete user {name} of site {site}?",
    "ui.dash.systemStatus": "System status",
    "ui.dash.daemon": "Daemon:",
    "ui.status.running": "Running",
    "ui.status.stopped": "Stopped",
    "ui.status.notStarted": "Not started",
    "ui.dash.activeTunnels": "Active tunnels: {n}",
    "ui.dash.registeredUsers": "Registered users: {n}",
    "ui.dash.quickActions": "Quick actions",
    "ui.dash.exposePort": "Expose port",
    "ui.dash.manageTunnels": "Manage tunnels",
    "ui.dash.manageUsers": "Manage users",
    "ui.tunnels.list": "Tunnel list",
    "ui.th.name": "Name",
    "ui.th.type": "Type",
    "ui.th.status": "Status",
    "ui.th.url": "URL",
    "ui.th.actions": "Actions",
    "ui.empty.tunnels": "No tunnels",
    "ui.badge.favorite": "Recommended",
    "ui.btn.start": "Start",
    "ui.btn.stop": "Stop",
    "ui.btn.delete": "Delete",
    "ui.btn.addTunnel": "Add tunnel",
    "ui.users.list": "User list",
    "ui.th.username": "Username",
    "ui.th.displayName": "Display name",
    "ui.th.totp": "2FA",
    "ui.empty.users": "No users",
    "ui.status.enabled": "Enabled",
    "ui.status.disabled": "Not enabled",
    "ui.btn.setPassword": "Change password",
    "ui.btn.enableTotp": "Enable 2FA",
    "ui.btn.disableTotp": "Disable 2FA",
    "ui.btn.addUser": "Add user",
    "ui.config.title": "Current config",
    "ui.sites.title": "Sites (auth realms)",
    "ui.sites.hint": "Each site = its own provider instance + user database, no sharing. Virtual host: <code>&lt;port&gt;-&lt;label&gt;.st.localhost</code>",
    "ui.th.site": "Site",
    "ui.th.provider": "Provider",
    "ui.th.auth": "Auth",
    "ui.th.domain": "Domain",
    "ui.th.addr": "Address",
    "ui.badge.default": "Default",
    "ui.auth.open": "Open",
    "ui.auth.yes": "Auth",
    "ui.btn.users": "Users",
    "ui.btn.addSite": "Add site",
    "ui.sites.example": "e.g.:",
    "ui.sites.localExposes": "Local exposes (proxy mode)",
    "ui.th.port": "Port",
    "ui.th.localAddr": "Local address",
    "ui.th.baseDomain": "Base domain",
    "ui.empty.exposes": "No proxy exposes",
    "ui.siteUsers.title": "Site {name} · Users",
    "ui.siteUsers.hint": "Independent user database for this site (provider: {provider}) — separate from other sites.",
    "ui.btn.back": "Back to sites",
    "ui.expose.title": "Quick expose a port",
    "ui.label.localPort": "Local port",
    "ui.placeholder.port": "e.g. 3000",
    "ui.label.mode": "Mode",
    "ui.option.tunnel": "tunnel (public)",
    "ui.option.proxy": "proxy (local vhost, no tunnel)",
    "ui.option.both": "both",
    "ui.label.auth": "Auth",
    "ui.option.auto": "auto (auto-select)",
    "ui.option.none": "none (no auth)",
    "ui.meta.configured": "configured",
    "ui.meta.needsInput": "missing:",
    "ui.label.site": "Site (auth realm)",
    "ui.option.default": "default",
    "ui.label.tunnelType": "Tunnel type (tunnel/both modes)",
    "ui.option.cloudflared": "cloudflared (recommended)",
    "ui.btn.expose": "Expose",
    "ui.secretProvided": "Provided by config (not shown); empty = use config value, fill = override",
    "ui.linkTitleDefault": "Get",
    "ui.secretProvidedHint": "✓ Provided from config (secrets not shown; editable, clear = fall back to config)",
    "ui.fieldsHint": "Fill in below, or write to config.json auth.oauth2 to pre-fill",
    "ui.expose.progress": "Exposing...",
    "ui.expose.success": "✅ Exposed!<br>",
    "ui.expose.failed": "❌ Expose failed: ",
    "ui.unknownError": "Unknown error",
    "ui.requestFailed": "❌ Request failed: ",
    "ui.tunnelsAdd.title": "Add tunnel",
    "ui.label.name": "Name",
    "ui.placeholder.name": "e.g. web",
    "ui.dangerous": "⚠️ dangerous",
    "ui.label.target": "Target port",
    "ui.placeholder.target": "e.g. 4180",
    "ui.btn.add": "Add",
    "ui.confirmCommand": "type \"command\" executes your command directly (dangerous). Continue?",
    "ui.add.success": "✅ Added!",
    "ui.add.failed": "❌ Add failed: ",
  },

  zh: {
    // ── tunnel schemas(数据默认英文;zh 覆盖)────────────────────────
    "tunnel.ngrok.domain.label": "固定域名",
    "tunnel.ngrok.domain.description": "绑定固定域名(需 ngrok 账号支持);留空用随机域名",
    "tunnel.ngrok.token.label": "Authtoken",
    "tunnel.ngrok.token.description": "未认证的 ngrok 会直接退出(ERR_NGROK_4018);token 注入 NGROK_AUTHTOKEN",
    "tunnel.ngrok.token.linkTitle": "获取 token",
    "tunnel.frpc.server.label": "frps 地址",
    "tunnel.frpc.server.description": "frps server host:port",
    "tunnel.frpc.token.label": "Token",
    "tunnel.frpc.token.description": "frps 共享 token(可选)",
    "tunnel.frpc.domain.label": "自定义域名",
    "tunnel.frpc.domain.description": "custom_domains;留空用 localhost",
    "tunnel.ssh.host.label": "SSH 服务器",
    "tunnel.ssh.host.description": "ssh -R 目标服务器(必填,转发到该服务器公网端口;自建/云主机均可)",
    "tunnel.ssh.host.placeholder": "目标服务器",
    "tunnel.ssh.user.label": "用户名",
    "tunnel.ssh.user.description": "user@host;留空用当前用户",
    "tunnel.ssh.user.placeholder": "wind",
    "tunnel.ssh.port.label": "SSH 端口",
    "tunnel.ssh.port.description": "ssh -p",
    "tunnel.ssh.remotePort.label": "远程端口",
    "tunnel.ssh.remotePort.description": "-R <remotePort>:127.0.0.1:<target>;留空=target",
    "tunnel.serveo.host.label": "serveo 镜像",
    "tunnel.serveo.user.label": "用户名",
    "tunnel.serveo.port.label": "SSH 端口",
    "tunnel.cloudflared.domain.label": "Hostname",
    "tunnel.cloudflared.domain.description": "命名隧道主机名;留空=随机 trycloudflare",
    "tunnel.natapp.token.label": "Authtoken",
    "tunnel.natapp.token.description": "natapp 认证令牌(注册后从隧道列表复制);客户端需先经官网安装脚本下载",
    "tunnel.natapp.token.linkTitle": "下载客户端 + 获取 token",
    "tunnel.natapp.domain.label": "自定义域名",
    "tunnel.natapp.domain.description": "绑定固定域名(需 VIP);留空用随机域名",
    "tunnel.natapp.server.label": "服务器",
    "tunnel.natapp.server.description": "VIP 绑定自定义域名时填分配的服务器(可选)",
    "tunnel.localtunnel.domain.label": "Subdomain",
    "tunnel.localtunnel.domain.description": "固定子域名;留空=随机",
    "tunnel.bore.server.label": "bore server",
    "tunnel.bore.server.description": "bore server 地址(host 或 host:port);默认 bore.pub:7835(公共服务器,免注册);自建填你的服务器 IP:端口(如 1.2.3.4:7835)",
    "tunnel.bore.remotePort.label": "远程端口",
    "tunnel.bore.remotePort.description": "-p 请求固定端口;留空=server 随机分配",
    "tunnel.bore.token.label": "Secret",
    "tunnel.bore.token.description": "-s 共享密钥;server 未设 secret 则留空",
    "tunnel.command.cmd.label": "命令",
    "tunnel.command.cmd.description": "任意 shell 命令;URL 从输出解析",
    "tunnel.command.cmd.placeholder": "ssh -R 80:127.0.0.1:<port> serveo.net",

    // ── auth provider schemas ───────────────────────────────────────
    "auth.authelia.basePath.label": "Base 路径",
    "auth.authelia.basePath.description": "authelia 路径(仅字母数字,不能有连字符);默认随机",
    "auth.authelia.basePath.placeholder": "/authelia...",
    "auth.authelia.policy.label": "策略",
    "auth.authelia.policy.option.one_factor": "单因素(仅密码)",
    "auth.authelia.policy.option.two_factor": "双因素(密码 + TOTP)",
    "auth.authelia.policy.option.deny": "拒绝全部",
    "auth.portal.basePath.label": "Base 路径",
    "auth.portal.basePath.description": "登录页路径;默认随机(如 /portal-sneaky-capybara)",
    "auth.portal.basePath.placeholder": "/portal-...",
    "auth.oauth2-proxy.oidc.issuerUrl.label": "OIDC Issuer URL",
    "auth.oauth2-proxy.oidc.issuerUrl.placeholder": "https://accounts.example.com",
    "auth.oauth2-proxy.oidc.issuerUrl.linkTitle": "oauth2-proxy 配置文档",
    "auth.oauth2-proxy.oidc.cookieSecret.description": "留空自动生成",

    // ── CLI ─────────────────────────────────────────────────────────
    "cli.unknownArg": "未知参数: {arg}",
    "cli.usage.global": "全局:--config-dir <dir> / --cache-dir <dir>(或 SERVICE_TUNNELS_CONFIG/CACHE)",
    "cli.usage.lang": "--lang <zh|en>(默认跟随 LANG/LC_ALL,非中文环境出英文)",
    "cli.schemasHint": "数据驱动参数 schema(客户端据此渲染表单)",

    // ── daemon UI panel ─────────────────────────────────────────────
    "ui.title": "service-tunnels 管理面板",
    "ui.nav.dashboard": "概览",
    "ui.nav.tunnels": "隧道管理",
    "ui.nav.users": "用户管理",
    "ui.nav.sites": "站点管理",
    "ui.nav.config": "配置",
    "ui.nav.expose": "快速暴露",
    "ui.confirmDeleteTunnel": "确定删除隧道 {name}?",
    "ui.promptUsername": "用户名:",
    "ui.promptPassword": "密码:",
    "ui.confirmDeleteUser": "确定删除用户 {name}?",
    "ui.promptNewPassword": "新密码:",
    "ui.totpEnrollTitle": "为 {name} 启用 2FA:\n\n在 Authenticator 应用中添加:\n{otpauth}\n\n{secretHint}",
    "ui.totpEnrollSecretHint": "或手动输入密钥: {secret}\n\n",
    "ui.totpEnrollEnterCode": "输入 6 位验证码以激活:",
    "ui.totpActivated": "✅ 2FA 已激活",
    "ui.totpCodeWrong": "❌ 验证码错误,请重试",
    "ui.confirmDisableTotp": "确定禁用 2FA?",
    "ui.promptSiteName": "站点名(小写字母/数字/短横线,如 host):",
    "ui.promptSiteProvider": "认证 provider(portal/authelia/basic/oauth2-proxy,回车=auto):",
    "ui.promptSiteDomain": "站点域名(可选,如 web.example.com):",
    "ui.confirmDeleteSite": "确定删除站点 {name}?",
    "ui.confirmDeleteSiteUser": "确定删除 {site} 的用户 {name}?",
    "ui.dash.systemStatus": "系统状态",
    "ui.dash.daemon": "守护进程:",
    "ui.status.running": "运行中",
    "ui.status.stopped": "已停止",
    "ui.status.notStarted": "未启动",
    "ui.dash.activeTunnels": "活跃隧道: {n} 个",
    "ui.dash.registeredUsers": "注册用户: {n} 个",
    "ui.dash.quickActions": "快速操作",
    "ui.dash.exposePort": "暴露端口",
    "ui.dash.manageTunnels": "管理隧道",
    "ui.dash.manageUsers": "管理用户",
    "ui.tunnels.list": "隧道列表",
    "ui.th.name": "名称",
    "ui.th.type": "类型",
    "ui.th.status": "状态",
    "ui.th.url": "地址",
    "ui.th.actions": "操作",
    "ui.empty.tunnels": "暂无隧道",
    "ui.badge.favorite": "推荐",
    "ui.btn.start": "启动",
    "ui.btn.stop": "停止",
    "ui.btn.delete": "删除",
    "ui.btn.addTunnel": "添加隧道",
    "ui.users.list": "用户列表",
    "ui.th.username": "用户名",
    "ui.th.displayName": "显示名",
    "ui.th.totp": "2FA",
    "ui.empty.users": "暂无用户",
    "ui.status.enabled": "已启用",
    "ui.status.disabled": "未启用",
    "ui.btn.setPassword": "改密",
    "ui.btn.enableTotp": "启用2FA",
    "ui.btn.disableTotp": "禁用2FA",
    "ui.btn.addUser": "添加用户",
    "ui.config.title": "当前配置",
    "ui.sites.title": "站点列表(认证域)",
    "ui.sites.hint": "每个站点 = 独立的 provider 实例 + 用户库,互不共享。虚拟主机:<code>&lt;port&gt;-&lt;label&gt;.st.localhost</code>",
    "ui.th.site": "站点",
    "ui.th.provider": "Provider",
    "ui.th.auth": "认证",
    "ui.th.domain": "域名",
    "ui.th.addr": "地址",
    "ui.badge.default": "默认",
    "ui.auth.open": "开放",
    "ui.auth.yes": "认证",
    "ui.btn.users": "用户",
    "ui.btn.addSite": "添加站点",
    "ui.sites.example": "如:",
    "ui.sites.localExposes": "本地暴露(proxy 模式)",
    "ui.th.port": "端口",
    "ui.th.localAddr": "本地地址",
    "ui.th.baseDomain": "base 域名",
    "ui.empty.exposes": "暂无 proxy 暴露",
    "ui.siteUsers.title": "站点 {name} · 用户管理",
    "ui.siteUsers.hint": "该站点(provider: {provider})的独立用户库——与其它站点互不影响。",
    "ui.btn.back": "返回站点列表",
    "ui.expose.title": "快速暴露端口",
    "ui.label.localPort": "本地端口",
    "ui.placeholder.port": "例如: 3000",
    "ui.label.mode": "模式",
    "ui.option.tunnel": "tunnel(公网隧道)",
    "ui.option.proxy": "proxy(本地虚拟主机,无隧道)",
    "ui.option.both": "both(两者)",
    "ui.label.auth": "认证方式",
    "ui.option.auto": "auto(自动选择)",
    "ui.option.none": "none(无认证)",
    "ui.meta.configured": "✓已配置",
    "ui.meta.needsInput": "缺:",
    "ui.label.site": "站点(认证域)",
    "ui.option.default": "default(默认)",
    "ui.label.tunnelType": "隧道类型(tunnel/both 模式)",
    "ui.option.cloudflared": "cloudflared(推荐)",
    "ui.btn.expose": "暴露",
    "ui.secretProvided": "已由配置档提供(页面不回显);留空使用配置档值,填写则覆盖",
    "ui.linkTitleDefault": "获取",
    "ui.secretProvidedHint": "✓ 已从配置档提供(秘密字段不回显;均可修改覆盖,清空回落配置档值)",
    "ui.fieldsHint": "以下字段可现场填写,或写入 config.json auth.oauth2 后自动预填",
    "ui.expose.progress": "正在暴露...",
    "ui.expose.success": "✅ 暴露成功!<br>",
    "ui.expose.failed": "❌ 暴露失败: ",
    "ui.unknownError": "未知错误",
    "ui.requestFailed": "❌ 请求失败: ",
    "ui.tunnelsAdd.title": "添加隧道",
    "ui.label.name": "名称",
    "ui.placeholder.name": "例如: web",
    "ui.dangerous": "⚠️ 危险",
    "ui.label.target": "目标端口",
    "ui.placeholder.target": "例如: 4180",
    "ui.btn.add": "添加",
    "ui.confirmCommand": "type \"command\" 会直接执行你输入的命令(危险)。确定继续?",
    "ui.add.success": "✅ 添加成功!",
    "ui.add.failed": "❌ 添加失败: ",
  },
};

/** 翻译查找:当前语言 → en 回退 → 原 key(便于发现漏翻)。{name} 插值。 */
export function t(lang: Lang, key: string, params: Record<string, string> = {}): string {
  const msg = CATALOG[lang]?.[key] ?? CATALOG.en[key] ?? key;
  return msg.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

/** 语言探测:默认英文;显式参数或 LANG/LC_ALL 以 zh 开头 → 中文。 */
export function resolveLang(explicit?: string, env: NodeJS.ProcessEnv = process.env): Lang {
  const raw = (explicit ?? env.LANG ?? env.LC_ALL ?? "").trim().toLowerCase();
  if (raw === "zh" || raw === "zh_cn" || raw === "zh-cn" || raw === "zh_tw" || raw === "zh-hk" || raw.startsWith("zh_") || raw.startsWith("zh-")) {
    return "zh";
  }
  return "en";
}

import type { ParamSpec } from "./tunnels.ts";

/** 注入稳定翻译 id(与文案解耦):调用方按 id 用自己的 i18n 翻译,
 *  数据默认英文;未命中回退内置值。形态:
 *   tunnel.<type>.<key>.label / description / placeholder / linkTitle
 *   auth.<type>.<key>.label / ...  */
export function withSchemaI18nKeys<T extends ParamSpec>(
  ns: "tunnel" | "auth",
  type: string,
  specs: T[],
): T[] {
  return specs.map((s) => ({
    ...s,
    ...(s.label ? { labelKey: `${ns}.${type}.${s.key}.label` } : {}),
    ...(s.description ? { descriptionKey: `${ns}.${type}.${s.key}.description` } : {}),
    ...(s.placeholder ? { placeholderKey: `${ns}.${type}.${s.key}.placeholder` } : {}),
    ...(s.linkTitle ? { linkTitleKey: `${ns}.${type}.${s.key}.linkTitle` } : {}),
    ...(s.options && s.options.some((o) => o.label)
      ? {
          options: s.options.map((o) => ({
            ...o,
            ...(o.label ? { labelKey: `${ns}.${type}.${s.key}.option.${o.value}` } : {}),
          })),
        }
      : {}),
  }));
}

/** 按语言本地化 schema 字段:en = 数据默认(原样返回);zh 等语言按翻译 id
 *  覆盖 label/description/placeholder/linkTitle/option label。
 *  未命中保持原值(英文默认)。 */
export function localizeSpecs(specs: ParamSpec[], lang: Lang): ParamSpec[] {
  if (lang === "en") return specs;
  return specs.map((s) => {
    const out: ParamSpec = { ...s };
    const tr = (key: string | undefined, fb: string | undefined) =>
      key ? t(lang, key) : (fb ?? "");
    if (s.labelKey) out.label = tr(s.labelKey, s.label);
    if (s.descriptionKey) out.description = tr(s.descriptionKey, s.description);
    if (s.placeholderKey) out.placeholder = tr(s.placeholderKey, s.placeholder);
    if (s.linkTitleKey) out.linkTitle = tr(s.linkTitleKey, s.linkTitle);
    if (s.options) {
      out.options = s.options.map((o) =>
        o.labelKey ? { ...o, label: tr(o.labelKey, o.label) } : o,
      );
    }
    return out;
  });
}

/** 按语言本地化整张 schema 表({type → specs})。 */
export function localizeSchemas(
  schemas: Record<string, ParamSpec[]>,
  lang: Lang,
): Record<string, ParamSpec[]> {
  if (lang === "en") return schemas;
  return Object.fromEntries(
    Object.entries(schemas).map(([type, specs]) => [type, localizeSpecs(specs, lang)]),
  );
}
