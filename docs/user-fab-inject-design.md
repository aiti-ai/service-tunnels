# 用户信息 FAB 注入（user-fab inject）设计方案

> 状态：待审核（未实施）
> 仓库：service-tunnels（库原生能力，不依赖宿主/扩展）

## 1. 背景与目标

当前 basic/authelia/portal 三种网关认证只有"登录"，没有"退出"，用户在受保护页面上也**不知道自己登录的是谁**。

目标：库原生的 JS 注入——在受保护的应用页面上注入一个**用户信息 FAB**：

- 默认**右下角**悬浮按钮
- 可拖动，**支持屏幕四边停靠**（复用 aiti-devtools launcher 的 fab 拖动机制）
- 点击展开面板：显示**用户名**、认证方式
- **退出登录**按钮

非目标（v1 不做）：

- 不做物理适配 counter-zoom（那是 aiti-devtools 自绘 UI 对抗无 viewport meta 页面的场景；宿主应用页面一般有正常 viewport）
- 不做菜单/多按钮展开（v1 单按钮 + 单面板）
- 不做 token 模式的 FAB（Bearer 无会话语义，见 §6）

## 2. 现状盘点（可复用基础设施）

| 设施 | 现状 | 复用方式 |
|---|---|---|
| 静态响应注入 | `GatewayHost.inject`（`GatewayInject{html,position,recompress}`），nginx `sub_filter '</head>'` + map 按 `Sec-Fetch-Mode` 只对主页面导航注入；`nginxQuote` 字节转义保证任意 JS 安全进入替换串 | user-fab 作为**库内置注入源**与用户自定义 `inject` 并存拼接 |
| authz 端点 | portal `GET {base}/api/authz/auth-request` 200 时返回 `X-St-Auth-User: <name>` 头（portal.ts:1806）；authelia authz 返回标准 `Remote-User` 头 | FAB 运行时 fetch 回显端点拿用户名（§4.3） |
| nginx auth_request | `location /` 已有 `auth_request → authzPath`（fwd-auth 系）；basic 用 nginx 原生 `auth_basic` | `/__st_auth__` 回显 location 同链路复用 |
| fab 拖动机制 | `examples/dbg-widget/src/launcher/{drag.js,fab.js}`：`makePointerDrag`（pointercancel 必达/late 捕获/阈值判定）+ edge 停靠 + localStorage 持久化 + 视口 clamp | **复制核心逻辑**（不 import）：阈值拖动、四边停靠、`localStorage` 存 `{edge, x, y}`、resize 重锚定 |
| boolean 开关渲染 | 扩展 SchemaForm 已支持 `type:"boolean"` 渲染 ON/OFF 开关（0.3.49+）；`coerceParamValue` 字符串→boolean（0.3.52+） | 新 schema 字段直接获得开关 UI + 类型转换 |

## 3. 总体设计

```
浏览器                          nginx gateway                    portal provider
──────                          ─────────────                    ───────────────
GET / (受保护页面)
  ◄── HTML + <script __st_fab__>     │
      (head 注入, 静态 JS)           │
                                    │
FAB init: fetch /__st_auth__ ──►  location = /__st_auth__
  ◄── {"user":"user1",              auth_request → authz   ──►   authz?who=1
       "displayName":"User 1",      auth_request_set $st_user     (portal: JSON)
       "provider":"portal"}         proxy_pass → authz 端点        (authelia: 头)
                                    │
点击「退出登录」
  location = /portal-xxx/logout ►  location {portalBase}/ 转发 ──► GET /logout
  ◄── 302 登录页（cookie 已清）                                   清 session cookie
```

要点：

1. **注入内容 = 静态 JS（无用户数据）+ 运行时 fetch 用户名**——不在 nginx/sub_filter 层做字符串拼接（无法安全转义 HTML，用户名含 `</script>` 会注坏页面）；用户名由回显端点返回 JSON，天然防 XSS。
2. **回显端点 `/__st_auth__`**：per-provider 实现统一语义（§4.3），始终走同一条已认证链路（auth_request / auth_basic），未登录 401 → FAB 不渲染。
3. **登出端点**：portal 新增 `GET {base}/logout`；authelia 跳第一方 `{autheliaBase}/logout`；basic 用强制 401 覆盖缓存凭据（§4.4）。

## 4. 详细设计

### 4.1 注入链路（gateway.ts）

`GatewayHost` 新增选项：

```ts
interface GatewayHost {
  /** 注入「登录信息按钮」（悬浮 FAB：显示登录用户名 + 退出登录，可拖动四边
   *  停靠）。默认 false（显式开启）；仅 auth != "none" 时生效。 */
  loginInfoButton?: boolean;
}
```

conf 生成逻辑（`writeHostFile` / `generateGatewayNginx`）：

- `loginInfoButton && mode !== "none"` 时：
  1. **注入 HTML**：`<script id="__st_fab__">/* user-fab.js 内联 */</script>` 追加到现有 `inject` 内容之后（两个注入源拼接共用一个 sub_filter 槽位：`normalizeInject` 结果 + fabJS，或都不存在则单独创建）。导航过滤/map 机制、`Accept-Encoding` 剥离、gzip 重压全复用现有注入管道。
  2. **回显 location**（server 块）：

    ```nginx
    # fwd-auth 系（portal/authelia）：
    location = /__st_auth__ {
      auth_request /${authzPath};
      auth_request_set $st_user $upstream_http_x_st_auth_user;   # portal
      auth_request_set $st_user2 $upstream_http_remote_user;     # authelia
      proxy_pass http://127.0.0.1:${authPort}/${authzPath}?who=1;
      # portal authz?who=1 直接返回 JSON（§4.3）；authelia 透传其 authz 响应
    }

    # basic：
    location = /__st_auth__ {
      auth_basic <同 realm>;
      auth_basic_user_file <同 file>;
      root ${nginxRoot}/empty;      # 预置空文件 __st_auth__ → 200 空体
      add_header Content-Type application/json always;
      add_header X-St-Auth-User $remote_user always;
    }
    ```

    basic 的 JSON 体由 JS 端从头拼（`{"user": h.getResponseHeader('X-St-Auth-User')}`）——头同源可读。
  3. **登出 URL 不进 conf**（JS 端从回显 JSON 拿 `logoutUrl`，§4.3），避免 host 级再开变量槽。

- `loginInfoButton` 与用户自定义 `inject`（如 aiti-devtools 注入）**并存不互斥**：拼接顺序 = 自定义 inject 在前、fab 在后。

### 4.2 user-fab.js（注入的组件，~220 行内联 IIFE）

结构（Shadow DOM 隔离宿主 CSS）：

```html
<st-fab>            (position:fixed, z-index:2147483646, touch-action:none)
  #btn              40px 圆钮：👤 或用户名首字符；hover 提示 "用户信息"
  #panel            点击展开：用户名 / displayName / 认证方式徽标 / [退出登录]
</st-fab>
```

行为：

- **初始化**：`fetch('/__st_auth__', {credentials:'same-origin'})`
  - 200 → 解析 JSON `{user, displayName?, provider, logoutUrl}` → 渲染 FAB
  - 401/网络错误 → **不渲染**（无会话或非受保护上下文，静默退出）
  - 超时 3s → 不渲染
- **拖动**（从 drag.js 移植的最小实现）：
  - `pointerdown` 记录起点；位移超 6px 阈值才算拖动（纯点击不触发，click 留给展开）
  - `window` 级 `pointermove/pointerup/pointercancel` + `lostpointercapture` 兜底（触屏手势被系统取消时必达结束）
  - 拖动中 `setPointerCapture`（late 捕获）
  - 松手**四边停靠**：计算距四边最小距离，吸附到最近边 + 沿边 clamp 进视口
  - `localStorage['st_fab_pos'] = {edge, x, y}`（x/y = 沿边偏移像素）；resize/rotate 时重新 clamp
  - 默认位置：`{edge:'bottom', x: viewportW - 56, y: 0}`（右下角 16px 边距）
- **退出登录**：`location.href = logoutUrl`（服务端负责清 cookie + 302）
- **样式**：深色玻璃（`backdrop-filter: blur`，不支持时纯色降级）；`all: initial` + Shadow DOM 双保险；面板宽 ~200px，按钮小屏缩小到 36px

### 4.3 用户名获取（per-provider）

回显端点统一返回语义（portal 返回 JSON；authelia/basic 由 JS 拼装）：

| Provider | 实现方式 | 返回 |
|---|---|---|
| **portal** | `authz` 端点支持 `?who=1`：200 时返回 `{"user","displayName","provider":"portal","logoutUrl":"{base}/logout?next="}`（portal.ts +15 行） | JSON 全量 |
| **authelia** | `/__st_auth__` proxy_pass 到 authelia authz；JS 读 `Remote-User` 头；`logoutUrl = {autheliaBase}/logout`（JS 从回显头 `X-Auth-Portal-Base`？**v1：库已知 authelia basePath**——gateway conf 生成时把 `logoutUrl` 写进注入 JS 的常量槽（静态值非用户数据，无转义问题） | 头 + 静态常量 |
| **basic** | 空文件 + `add_header X-St-Auth-User $remote_user`；JS 读头；无真登出（§4.4） | 头 |
| **token** | v1 不注入 FAB（`userFab` 传了也忽略 + log 提示） | — |

> logoutUrl 的传递权衡：portal 从回显 JSON 拿（动态、无注入污染）；authelia/basic 在注入 JS 尾部以 `window.__ST_FAB_CFG__={logoutUrl:"..."}` 静态写入——都是**服务端常量**，不经过用户输入，无 XSS 面。

### 4.4 登出（per-provider）

| Provider | 方案 |
|---|---|
| **portal** | 新增 `GET {base}/logout[?next=]`：清 `st_portal_session`（+ 2FA 中间票）cookie，`Set-Cookie` 过期；302 → `{base}/login?next=`。**CSRF**：登出是低危操作（清自己会话），GET 可接受（业界通行 authelia/logout 也是 GET/POST 皆可）；v1 GET。 |
| **authelia** | 跳第一方 `{autheliaBase}/logout`（authelia 自带，清其会话） |
| **basic** | 无服务端会话；经典做法：JS 先 `fetch('/__st_auth__', {headers:{Authorization:'Basic ' + btoa('logout:logout')}})` 用无效凭据覆盖浏览器缓存的凭据，再 reload → 浏览器弹认证框。若浏览器策略不允许（Safari 新版），面板提示"关闭浏览器窗口完成登出"。 |

### 4.5 配置面

**库 expose opts**（`expose()` / `auth.expose()`）：

```ts
expose(port, { ..., loginInfoButton?: boolean })   // 默认 false（显式开启）；透传 gateway host
```

**AUTH_PARAM_SCHEMAS**：不动现有 portal/authelia schema——`loginInfoButton` 是**通道级**选项（跟 auth provider 无关，basic/authelia/portal 都适用），加在 expose 表单的通道参数区（与 `inject[]` 并列），扩展端 `exposeService` 透传。schema 形态：

```ts
// 扩展端通道表单新字段（ServicesDialog AuthExposeSection）
{ key: "loginInfoButton", label: "显示登录信息（页面右下角按钮：用户名 + 退出登录，可拖动）", type: "boolean", default: false }
```

> 命名语义直白（"显示登录信息"而非内部术语 FAB）；默认 false——注入属于用户可见的页面改动，公开时显式勾选才生效，不惊讶宿主页面。

## 5. 安全考量

| 风险 | 对策 |
|---|---|
| 用户名 XSS | 用户名**不进注入 HTML**（静态 JS 无用户数据）；运行时 fetch JSON → `textContent` 赋值（从不 innerHTML） |
| 注入 JS 本身被宿主 CSP 拦 | inline `<script>` 在严格 `script-src` 下不执行——与现有 `inject` 机制同限制（sub_filter 注入本质如此）；v1 接受（宿主应用多为宽松 CSP）；v2 可选外链 `/__st_fab__.js`（nginx internal serve，绕过大部分 CSP） |
| 回显端点信息泄露 | `/__st_auth__` 只回**已认证**请求的**用户名**（本就是请求者自己的）；未登录 401 无信息 |
| 登出 CSRF | 只清请求者自己会话（GET 登出业界通行）；next 白名单仅本站路径（复用登录页 next 的既有校验） |
| 拖动与宿主页面冲突 | Shadow DOM + `touch-action:none` 仅作用于 FAB 把手；click/拖动阈值区分不吞宿主交互 |
| FAB 遮挡宿主 UI | 可拖走 + localStorage 记忆；40px 小尺寸；v1 不做"隐藏"按钮（拖到角落即可） |

## 6. 边界与限制

- **token 模式**：Bearer 无浏览器会话，FAB 无意义——`loginInfoButton` 忽略并 log。
- **`auth:"none"`**：无登录即无用户——不注入。
- **prepend 模式共存**：`loginInfoButton` 固定用 head 模式槽位（`</head>` 前）；自定义 inject 是 prepend 时 fab 仍走 sub_filter——两条注入指令独立，nginx 过滤器链支持多次 sub_filter（不同 pattern）。
- **多 host**：每个 expose host 独立注入/回显 location，`injectVarName` 命名隔离已有。
- **iframe 嵌套页**：注入管道对 nested-navigate 同样注入（现有 map default 行为），但 JS 端 `window.top !== window.self` 时**跳过渲染**——避免嵌套页出现多个重叠 FAB；注入脚本仍会加载（成本：几 KB 内联脚本执行）。

## 7. 测试计划

| 用例 | 断言 |
|---|---|
| portal expose + loginInfoButton:true → GET / | HTML 含 `__st_fab__` 脚本；XHR/fetch 请求不注入 |
| 登录后 fetch /__st_auth__ | 200 JSON `{user, displayName, provider, logoutUrl}` |
| 未登录 fetch /__st_auth__ | 401，FAB 不渲染 |
| GET /logout | cookie 过期头 + 302 登录页；之后访问受保护路径 401 |
| authelia host | /__st_auth__ 透传 Remote-User 头；登出跳 authelia /logout |
| basic host | /__st_auth__ 200 + X-St-Auth-User；FAB 显示用户名 |
| loginInfoButton:false / auth:none / token | 不注入 |
| 与自定义 inject 并存 | 两段注入都生效（顺序：自定义在前 fab 在后） |
| nginxQuote 往返 | 注入 JS 含引号/中文/`</script>`（转义后）不注坏 |
| 单测 | gateway conf 生成快照（含 /__st_auth__ 块）；portal authz who=1；logout 端点 |
| e2e（复用 test/gateway 真实 nginx 用例模式） | 302→login→cookie→200 全链路 + 注入标记 + who + logout |

## 8. 实施步骤（建议拆分）

1. **portal.ts**：authz `?who=1` JSON + `GET /logout`（+单测）
2. **gateway.ts**：`loginInfoButton` 选项 → conf（回显 location + fabJS 注入拼接 + `__ST_FAB_CFG__` 常量槽）+ `user-fab.ts`（生成 JS 的模块，~220 行含拖动）（+conf 快照单测）
3. **expose.ts / index.ts**：`loginInfoButton` 选项透传（+单测）
4. **扩展端**：AuthExposeSection 通道表单 boolean 开关 + i18n（复用现有开关渲染，改动极小）
5. **e2e**：真实 nginx 网关用例（test/ 现有模式）+ 手工隧道验证（拖动/停靠/登出/多 provider）
6. 发版 + 扩展 bump + 部署

预估：库 ~450 行（fab JS 220 + gateway 120 + portal 30 + expose/透传 40 + 测试），扩展 ~30 行。

---

### 附：已决议（review 记录）

1. **命名与默认值**：字段名 `loginInfoButton`（表单文案「显示登录信息（页面右下角按钮：用户名 + 退出登录，可拖动）」），**默认 false** 显式开启——注入是用户可见的页面改动，不惊讶宿主。
2. **iframe**：JS 端 `window.top !== window.self` 跳过渲染（避免多 iframe 多 FAB）。
3. **basic 登出**：无效凭据覆盖在 Safari 不可靠 → v1 降级为面板提示文案「关闭浏览器窗口完成登出」。
