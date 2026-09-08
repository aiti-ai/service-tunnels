# port-identity — 监听端口的 HTTP 服务识别（title + favicon）

状态：已实现（含服务页签/用户自定义识别 §5）。

## 1. 背景与目标

端口列表（UI dashboard、daemon IPC `port.list`、`st discover`）只有
**端口号 + 进程 cmdline**，用户很难一眼看出每个端口跑的是什么。本期给
"列出监听端口"加一层轻量 HTTP 探测：

- **document title**：`GET /` 取 HTML `<title>`（截断 120 字符，实体解码）；
- **favicon**：`<link rel*=icon>` 的 href（普通 icon 优先于 apple-touch-icon）；
  无 link 则默认探测 `/favicon.ico`；取回后转 `data:` URL，UI 直接 `<img>`
  展示，无需二次请求；
- **元信息**：HTTP status / Content-Type / Server 头，供 tooltip
  （如 `http 200 · nginx`）。

效果：端口卡片从 `3000 node /usr/local/bin/vite` 变成
`[icon] Vite · Dev Server`（cmdline 降为次要行）。

## 2. 实现（src/port-identity.ts）

### 2.1 探测流程

```
identifyPort(port)
  ├─ GET http://127.0.0.1:port/          （900ms 超时，body 上限 64KB）
  ├─ 明文失败（TLS 痕迹/断连）→ GET https://… （rejectUnauthorized: false）
  ├─ v4 全失败 → 同样流程再试 ::1        （应用可能只绑 v6）
  ├─ 重定向：最多 3 跳，目标必须仍为回环；外网目标停在 30x（协议仍如实标 http）
  └─ HTML 语义（content-type / <html> / 有 title）→ favicon 解析 + 取回
```

### 2.2 安全边界

- **只探测本机回环端口**（127.0.0.1 / ::1）——探测对象来自本机端口枚举，
  不引入新的可达面；
- **不外呼**：重定向目标非回环即停（探测不产生外网流量）；
- **有界**：doc 64KB / favicon 32KB 上限 + 900ms 超时 + 整体硬截止
  （超时+250ms），socket 显式销毁（L4 纪律，防 keep-alive 挂起）；
- **无副作用**：GET / 与用户在浏览器打开该端口等价；不发 POST。

### 2.3 成本控制

- 结果按端口缓存：成功 **5min** / 失败（tcp/无人监听）**30s**；缓存挂
  `globalThis`（与 discovery 缓存同风格，热重载不丢）；
- UI 10s 轮询 `/api/live` 时几乎零成本（实机：12 端口首探 786ms，缓存命中 0ms）；
- favicon data URL 随轮询下发，故二进制上限 32KB（base64 后 ~43KB）；
  超限只留 `faviconUrl` 供 tooltip/详情使用；
- `image/x-icon` 是"万能桶"标签：能从魔数嗅探出具体类型（png/gif/jpeg/
  svg/webp/ico）时优先嗅探，否则信声明；
- link 内联 `data:image/svg+xml,…`（URL-encoded，可能含引号）统一转
  base64 再下发，避免破坏 HTML 属性。

### 2.4 开关

`SERVICE_TUNNELS_NO_PORT_IDENTITY=1` 整体关闭（`enrichWithIdentity` 原样
返回，不附 identity 字段）。

## 3. 数据 shape 与接入点

```ts
interface PortIdentity {
  protocol: "http" | "https" | "tcp"; // tcp = 非 HTTP(S) 或探测失败
  status?: number;
  title?: string;
  favicon?: string;      // data: URL
  faviconUrl?: string;   // 来源地址（未取回/超限时也有）
  contentType?: string;
  server?: string;
}
```

| 接入点 | 行为 |
| --- | --- |
| daemon `port.list`（IPC） | `enrichWithIdentity(filtered)`，每项附 `identity` |
| `/api/live`（embedded 兜底） | 同上（daemon 不在时本地路径一致） |
| `/api/port-detect?port=` | 响应加 `identity`（缓存命中零成本；表单侧可用） |
| `enrichWithIdentity(ports)` | 库级 API（index 未导出，按需再开）；入参不被修改 |
| `identifyPort / peekIdentity / clearIdentityCache` | 单端口探测 / 只读缓存 / 测试辅助 |

## 4. UI 展示（ports tab）

`src/ui/client/ports.js` 端口卡片头：

- `identity.favicon` → `<img class="svc-icon">`（18px 圆角，紧挨端口号）；
- `identity.title` → `.svc-title` 主行，cmdline 降为 `dim` 次行；
- tooltip = `protocol status · server`（技术串，不进 i18n）；
- 无 title / tcp 端口 → 外观与原来一致（零回归）。

CSS：`src/ui.ts` 内联样式块（`.svc-icon` / `.svc-title`）。

## 5. 服务页签 + 用户自定义识别（已实现）

用户愿景：**端口只是标识的一种；用户应能按自己的理解命名服务**，并且这层
"服务识别"要出现在每一个列出端口的位置。

### 5.1 识别优先级（已实现）

```
用户 label（identity.label）> 探测 title > 进程 cmdline/comm > 端口号
```

- `identity.label` 由 port.list 合并下发（探测层不填）；有 label 且有
  title 时，tooltip 附 `探测: <title>`；
- UI 主行显示 `label || title`，cmdline 降为次要行。

### 5.2 存储与写入（已实现）

- `state.json` 新增 `serviceLabels: { [port: string]: string }`（
  `RuntimeState`，readState/emptyState 兜底 `{}`）；按端口存储（进程重启
  端口漂移可接受——开发场景端口比 pid 稳定）；
- daemon IPC `port.label.set` `{ port, label }`：trim + 截断 80 字符，
  空 label = 清除条目；非法端口抛错；
- UI `POST /api/port-label`：daemon 优先（它是 state.json 写者），
  embedded 兑底直接 `updateState`；
- port.list 合并：`identity = { ...probed, label }`（daemon 与 embedded
  兑底同逻辑）。

### 5.3 UI 交互（已实现）

- 端口卡片行尾新增 ✎ 按钮（`.svc-rename`，hover 才显眼，
  stopPropagation 不触发展开）；点击 prompt 输入（预填当前 label，
  留空清除，取消不动）——与 presets 命名同一交互模式；
- 保存后 `loadLive()` 刷新，toast 确认；i18n 键
  `ui.ports.rename/renamePrompt/renamed/detected`（中英）。

### 5.4 "每一个位置"（部分实现）

宿主应用（embedder）自持端口下拉时，消费 `port.list` 即可拿到合并后的
`identity`（label + title + favicon），展示自动对齐。daemon IPC 是唯一
真源；embedded 兑底路径同逻辑。

### 5.5 已知取舍

- 探测 title 可能是框架默认页（"Welcome to nginx!"）而非用户心智——
  这正是 label 存在的意义；
- 401/404 等错误页如实展示 status；title 来自错误页时（如 nginx
  "401 Authorization Required"）也算有效线索；
- HTTPS 自签一律放行（本机服务），不做证书校验。

## 6. 测试

`test/port-identity.test.mjs`（10 case）：title 实体解码/截断、icon 优先级、
内联 SVG data URL base64 化、默认 /favicon.ico + 魔数嗅探（x-icon 万能桶）、
回环重定向跟随、纯 TCP、JSON API、缓存命中零请求、外网重定向不跟随、
`enrichWithIdentity` 不可变入参。

`test/service-labels.test.mjs`（daemon e2e）：`port.label.set` 写入 →
`port.list` 合并（label + 探测 title 共存）→ 非法端口拒绝 → state.json
持久化 → daemon 重启后仍合并 → 空 label 清除。
