# service-tunnels 适配套件（Adaptation Kit）

> 让**任何跑得起来代码的工具/插件**都能通过 service-tunnels 对外暴露端口。
> 四层接入，成本从薄到厚：CLI（任何语言一行）→ 库（JS/TS 内嵌）→
> **daemon IPC（任意语言原生协议，本文件给出完整规范）** → env 零代码扩展点。
> 另含对外 schema 契约（冻结承诺）与参考实现规格。

---

## 0. 四层接入总览

| 层 | 入口 | 适合对象 | 成本 | 状态 |
|---|---|---|---|---|
| L1 | `sts expose <port> --json`（CLI，任意语言 spawn） | 脚本 / 编辑器插件 / CI | 一行命令 | ✅ 现成，--json 已全覆盖（§1.2） |
| L2 | `createServiceTunnels()`（JS/TS 库） | Electron 应用 / CLI 工具 / vite 插件 | ~10 行 | ✅ 现成（examples/） |
| L3 | **daemon JSON-RPC**（unix socket / Windows TCP+secret） | Go/Java/Python/Rust 原生客户端 | 50-100 行 | ✅ 现成，协议见 §3 |
| L4 | `SERVICE_TUNNELS_TUNNEL_COMMAND_*` / `SERVICE_TUNNELS_OAUTH2_VARIANT_*` | 任何想注册自有隧道/IdP 的一方 | 0 代码 | ✅ 现成，语法见 §4 |

---

## L1. CLI（任何语言一行）

```bash
sts expose 5173 --auth auto --json          # → { url, loginUrl, tunnel, provider, ... }
sts expose 5173 --mode both --tunnel cloudflared --auth auto --json
sts tunnel list --json
sts auth token create --description "ci" --expires +7d --json   # 机器访问（Bearer）
```

### 1.2 `--json` 覆盖审计（2026-08 全量核对 cli.ts）

| 命令族 | --json | 说明 |
|---|---|---|
| discover / internal list / status | ✅ | 机器可读端口/进程/状态 |
| tunnel list/add/start/stop/remove | ✅ | add 返回 `{added}`，start 返回 TunnelInfo（含 url） |
| expose | ✅ | 返回 ExposeResult（url/loginUrl/tunnel/provider） |
| proxy start/stop/status | ✅ | status 含 bindings |
| auth providers / user list/add/set-password/remove | ✅ | add 未显式给密码时返回一次性随机密码 |
| auth totp enroll/disable/status / secret | ✅ | enroll 返回 base32 secret + otpauthUrl |
| auth token list/create/revoke | ✅ | create 返回 token（仅一次） |
| sites list/get/add/remove | ✅ | |
| schemas（tunnels/authProviders） | ✅ | 表单契约（§5） |
| config get/show/path | ✅ | |
| ssh domain/key/host | ✅ | SSH 网关域管理 |
| daemon start/stop/status | ✅ | status 为 JSON；start 幂等 |
| ui / daemon logs | ❌ 不适配 | 交互式/流式，机器客户端勿用 |

**结论：操作类命令已全部机器可读**，L1 接入方无需等待任何补齐。

---

## L2. 库内嵌（JS/TS）

```ts
import { createServiceTunnels } from "service-tunnels";
const st = createServiceTunnels({ configDir, cacheDir });   // 专属目录（0600）
const res = await st.auth.expose(5173, { auth: "auto", tunnelType: "cloudflared" });
console.log(res.url);                                       // 公网 URL
st.on("tunnel:url" | "tunnel:stop", (e) => { /* 刷新 UI */ });
await st.shutdown();                                        // 退出清理
```

- 完整宿主集成模式（site 隔离/中间件即网关）见 `examples/host-integration.ts`。
- **Electron 宿主（VS Code 等）**：传 `nodePath: process.execPath`，库自动
  `ELECTRON_RUN_AS_NODE=1`（v0.3.32+，research F2/P1）。

---

## L3. daemon IPC 协议规范（任意语言原生客户端）

### 3.1 寻址（state.json）

daemon 运行后，`<cacheDir>/state.json`（0600）写入：

```json
{
  "daemon": { "pid": 1234, "ipc": "unix:///home/u/.cache/service-tunnels/daemon.sock" }
  // Windows: "ipc": "tcp://127.0.0.1:51234", "ipcSecret": "<32字节 hex>"
}
```

| 平台 | 传输 | 鉴权 |
|---|---|---|
| POSIX | `unix://` 后为 socket 路径（0600 文件系统门） | 无需额外头 |
| Windows | `tcp://127.0.0.1:<port>` HTTP POST | 必须带 `x-service-tunnels-auth: <ipcSecret>` |

### 3.2 帧格式

请求（每行一个 JSON，`\n` 结尾）：

```json
{"id": 1, "method": "expose", "params": {"port": 5173, "auth": "auto", "tunnelType": "cloudflared"}}
```

响应（服务端按行回写）：

```json
{"id": 1, "result": {"url": "https://...", "tunnel": "cf1", "provider": "portal"}}
{"id": 1, "error": "expose: auth \"none\" is banned on this host (allow-auth-none=false) — pass --auth auto/<provider>"}
```

- `id` 客户端自增即可（服务端原样回显）；`params` 可省略（`null`）。
- Windows 路径：HTTP POST 到根路径，`content-type: application/json`，body 同上。

### 3.3 方法目录（全量，2026-08 核对 daemon-server.ts）

**查询**

| 方法 | params | 返回 |
|---|---|---|
| `ping` | — | `{pong: true, pid}` |
| `discover` | `{force?}` | `ServicePortInfo[]`（排除框架端口） |
| `internal.list` | — | 框架辅助端口（nginx/authelia/redis…） |
| `proxy.status` / `proxy.bindings` | — | 代理状态 / 已登记绑定（D4） |
| `schemas` | `{lang?}` | 表单契约 + `authNoneAllowed`（§5） |
| `port.detect` | `{port}` | `{protocol, tunnelTypes, httpTunnelOnly}` |

**隧道（纯透传通道）**

| 方法 | params | 说明 |
|---|---|---|
| `tunnel.list` / `tunnel.get` | — / `name` | TunnelInfo（含 running/pid/url） |
| `tunnel.add` | `TunnelConfig` | **`type:"command"` 必须带 `dangerous:true`**（shell 门） |
| `tunnel.start` / `tunnel.stop` / `tunnel.remove` / `tunnel.stopAll` | `name` / … | start 返回含解析出的 url |

**暴露（一键流程）**

| 方法 | params | 说明 |
|---|---|---|
| `expose` | `{port, mode?, site?, tunnelType?, tunnelName?, tunnelParams?, providerParams?, auth?, provider?, protocol?, policy?, nginxPort?, autheliaPort?, redisPort?, proxyPort?, baseDomain?, basePath?, bypassPaths?, allowAuthNone?, allowToolDownload?, dangerous?, force?}` | 返回 `ExposeResult`（url/loginUrl/tunnel/provider）。`tunnelParams`/`providerParams` 必须是对象；`auth` none 且主机禁止时拒绝（sticky 开关）；`autheliaReloadCmd` 禁止过 IPC |

**认证 / 用户 / token**

| 方法 | params | 说明 |
|---|---|---|
| `auth.user.list` | `{provider?, site?}` | 按 provider 分组（无秘密） |
| `auth.user.add` | `{name, password, displayName?, provider?, site?}` | 返回 `{ok, providers}` |
| `auth.user.set-password` / `auth.user.remove` | … | 同上 |
| `auth.totp.enroll` | `{name, provider?, site?, label?}` | 返回 base32 secret + otpauthUrl |
| `auth.totp.disable` / `auth.totp.status` | … | |
| `auth.token.create` | `{description?, expiresAt?, provider?, site?}` | 返回 token（仅一次） |
| `auth.token.list` / `auth.token.revoke` | `{id?…}` | |
| `auth.none.allowed` | — | auth none 是否被禁止（客户端据此隐藏选项） |

**站点（认证域）与 SSH 网关**

| 方法 | params | 说明 |
|---|---|---|
| `site.list` / `site.add` / `site.remove` | `{name, …cfg}` / `name` | 独立用户库隔离 |
| `ssh.domain.list/create/remove/stop/start` | `{domain, forwardPort, …}` | SSH 反向网关（TCP） |
| `ssh.key.add/generate/list/remove` | `{domain, publicKey}` / … | 客户端公钥 |

### 3.4 安全边界（客户端必须知道）

1. **`dangerous` 门**：`tunnel.add`/`expose` 的 `type:"command"` 必须显式
   `dangerous:true`，否则拒绝——UI 需确认对话框。
2. **auth-none 粘性禁止**：`allowAuthNone=false`（参数/env/配置任一层）时，
   `auth` none 的 expose 直接拒绝，单次 true 无法覆盖。
3. **双入口校验**：IPC 边界与 start() 都做 fail-closed 校验（ssh 选项注入 /
   frpc INI 注入 / 路径穿越 / 端口越界）。
4. **operator-only 参数**：`autheliaReloadCmd`（shell 命令）不接收 IPC。
5. Windows 客户端必须带 secret 头；错误/缺失一律 403 + 审计日志。

### 3.5 最小客户端（Go，POSIX）

```go
package main

import (
	"bufio"; "encoding/json"; "fmt"; "net"; "os"
)

func rpc[T any](sock, method string, params any) (*T, error) {
	conn, err := net.Dial("unix", sock)
	if err != nil { return nil, err }
	defer conn.Close()
	req, _ := json.Marshal(map[string]any{"id": 1, "method": method, "params": params})
	fmt.Fprintf(conn, "%s\n", req)
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil { return nil, err }
	var resp struct { Result T; Error string }
	_ = json.Unmarshal([]byte(line), &resp)
	if resp.Error != "" { return nil, fmt.Errorf("%s", resp.Error) }
	return &resp.Result, nil
}

func main() {
	state, _ := os.ReadFile(os.Args[1]) // <cacheDir>/state.json
	var s struct{ Daemon struct{ Ipc string } `json:"daemon"` }
	_ = json.Unmarshal(state, &s)
	sock := s.Daemon.Ipc[len("unix://"):]
	if _, err := rpc[map[string]any](sock, "ping", nil); err != nil { panic(err) }
	res, err := rpc[map[string]any](sock, "expose", map[string]any{
		"port": 5173, "auth": "auto", "tunnelType": "cloudflared",
	})
	if err != nil { panic(err) }
	fmt.Println(res) // {url, loginUrl, tunnel, provider}
}
```

Python 简版 + Windows 变体（requests/urllib + secret 头）见
`examples/ipc-client-python/`（规划）。

---

## L4. env 零代码扩展点

```bash
# 自定义隧道（模板 {{token}} = 表单参数；{{localport}} = 被暴露端口）
SERVICE_TUNNELS_TUNNEL_COMMAND_sshbox="ssh -R {{port}}:127.0.0.1:{{localport}} myuser@host"
# URL 声明（可选，避免输出解析）：命令输出 ST_TUNNEL_URL:<url> 即显式声明
SERVICE_TUNNELS_TUNNEL_COMMAND_box="echo ST_TUNNEL_URL:https://myapp.example.com && ssh -R 80:127.0.0.1:{{localport}} u@h"

# 自定义 oauth2 变体（provider 参数，{{token}} 为表单字段）
SERVICE_TUNNELS_OAUTH2_VARIANT_MYIDP="provider=oidc;issuerUrl=https://auth.example.com/realms/r;clientId={{clientId}};clientSecret={{clientSecret}}"
```

- 注册后**自动出现在所有 schema 驱动客户端**（CLI `--tunnel-set`、daemon
  `schemas` RPC、UI 表单、VS Code 插件向导）——零代码、零改库。
- 安全：占位符值按字面量单引号转义注入（`;`/`|`/`$`/反引号全部惰性化），
  控制字符 fail-closed 拒绝；`command` 类型在 daemon 边界仍需
  `dangerous:true`。

---

## 5. schema 契约（对外冻结承诺）

`schemas` RPC 返回（示例）：

```json
{
  "tunnels": {
    "cloudflared": [{ "key": "hostname", "type": "string", "label": "Hostname", "required": false, "default": "", "placeholder": "random.trycloudflare.com", "labelKey": "tunnel.cloudflared.hostname.label" }],
    "ngrok": [ { "key": "token", "type": "password", "required": false, "link": "https://dashboard.ngrok.com/authtokens", "linkTitle": "Get authtoken" } ]
  },
  "metas": { "cloudflared": { "label": "cloudflared", "tcp": false, "account": false } },
  "authProviders": { "portal": [{ "key": "basePath", "type": "string", "placeholder": "/portal-..." }] },
  "authMetas": { "portal": { "label": "portal", "configured": true } },
  "authNoneAllowed": true
}
```

**ParamSpec 字段**：`key`（嵌套用 `.`，如 `oidc.issuerUrl`）、`label`、
`type`（string/number/boolean/password）、`description`、`link/linkTitle`、
`default`、`placeholder`、`required`、`options[]`、`fixed/value`（只读）、
i18n key（`labelKey`/`descriptionKey`/`placeholderKey`/`linkTitleKey`）。

**冻结承诺（对外客户端）**：
1. 字段**只增不减**；新增字段缺省不影响旧客户端；
2. **版本已落地**（v0.3.32+）：`schemas` RPC 返回 `versions: {tunnel, auth}`
   （库实例 `st.schemas.versions()` 同构）；客户端**必须**断言兼容；
3. **形状断言测试已落地**（`test/schemas-freeze.test.mjs`，8 项）：字段全集
   冻结基线、key/type/options/fixed 形状、隧道 9 类型 + 认证 5 内置基线、
   本地化注入字段也在冻结集合内——新字段必须显式加入基线，否则 CI 挂；
4. 破坏性变更（删字段/改语义）才 bump `TUNNEL_SCHEMAS_VERSION` /
   `AUTH_SCHEMAS_VERSION`（当前均 =1），且必须同步更新冻结测试基线；
5. 客户端渲染规则：未知字段忽略、`options` 枚举优先、`fixed` 只读、
   `required` 缺省=false。i18n：优先 `labelKey` 查本地表，未命中回退内置
   中文（与库 `localizeSchemas` 同语义）。

---

## 6. 参考实现规格（Phase 3 交付）

| 参考实现 | 接入层 | 行为 | 状态 |
|---|---|---|---|
| `examples/vite-plugin/` | L2 | `configureServer` 拿端口 → 可选暴露，终端打印 URL，关闭自动清理 | ✅ 已落地（含 README） |
| `examples/ci-github-actions/` | L1/L3 | 起 daemon（CLI 自动）→ expose → `auth token create`（Bearer）→ 验证 → trap stop-all | ✅ 已落地（workflow + 脚本 + README） |
| `examples/ipc-client-go/` | L3 | state.json 解析 + ping + expose + tunnel.list（POSIX unix socket） | ✅ 已落地（go.mod + main.go + README，编译通过 + 真机冒烟） |
| `examples/ipc-client-python/` | L3 | Windows HTTP+secret 变体 | 未开始（可后补） |

## 7. 接入方检查清单

- [ ] 端口归属：expose 门禁是"同 OS 用户"（verifyPortOwner），非进程树；
      跨用户暴露需 `--force`（库/CLI 均支持）。
- [ ] 认证默认开：`--auth auto`（Windows→portal 零二进制；Linux/macOS→authelia）。
- [ ] 机器访问用 `auth token create`（Bearer header），不要塞用户密码。
- [ ] 自定义隧道过 daemon 必须 `dangerous:true`（shell 执行门）。
- [ ] 目录隔离：多实例/多客户端用各自 cacheDir，勿共享 state.json
      （单写入者假设）。
- [ ] 退出清理：库调用 `shutdown()`；daemon 模式 `daemon stop` 或等
      guardian（父进程死亡回收）。
