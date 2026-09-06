# 网络体检与智能暴露建议（`st doctor` / UI「体检」）设计方案

> 状态：**方案评审稿**（实现前定稿）。
> 关联：`ipv6-direct-expose-design.md`（mode ipv6 已实现，本方案复用其探测原语）、
> `expose-landscape-plan.md`（provider 矩阵）、`portmap/probe.ts`（UPnP/NAT-PMP 探测已有）、
> `ddns-registry.ts`（**通道插件化的结构参照**：providerProfiles / profiles / entries 三层）。

---

## 0. 一句话结论

新增 **`st doctor`**（别名 `st netcheck`）与 UI「体检」tab：一条**分阶段、事件驱动**
的诊断流水线——静态探测（出口 IP / NAT / IPv6 / 代理 / DNS / 网关 UPnP / 防火墙 /
隧道端点）逐项即时上报；随后**真实起一个 Echo 端口逐个建立候选隧道**，用**可插拔的
多通道外部回连**（check-host 多节点拨测 / hackertarget 响应头回读 / microlink /
allorigins / 自建探针……任一被封自动切换）验证外网可达性；**建议随每个实测结果滚动
刷新**（不等全部测完），最终按评分给出 Top3 方案（每条带人话理由 + 一键命令/预填表单）。

防误判核心：Echo 协议用 **「数字加几」（n+delta，delta 随机）+ 随机 tag（body 与
响应头双通道回显）** 做内容级校验——缓存命中/运营商劫持页/隧道默认错误页/本地假 200
全部可识别。验证结论按**置信级**分层（外部内容级 > 外部头级 > 外部可达级 > 仅本机自证）。

三条设计支柱：
1. **回连通道插件化**（参考 `ddns-registry` 的 providerProfiles/profiles/entries 分层）：
   内置 7+ 通道，支持库 API / env / 配置文件三种注册方式，自建探针 15 行模板兜底。
2. **异步事件流**：`runNetcheck(opts, onEvent)` 单项完成即回调；CLI 边测边打印，
   daemon job 增量拉取，**建议(Phase D)滚动更新**（quick 初步建议 → 每次实测完成重算）。
3. **多通道冗余 + 交叉验证**：按能力过滤 → 并发前 N → 熔断降权；**单通道结果只算
   初步（unconfirmed），≥2 个通道一致才升级为确认（confirmed）**；结论冲突时
   保守降级——单通道被封/误报不影响整体结论。

---

## 1. 背景与目标

### 1.1 问题

expose 有 5 种模式（tunnel × 9 provider / proxy / both / portmap / ipv6）、
9 类隧道 provider、5 类认证——**小白用户面对表单不知道怎么选**：
- 不知道自己是不是 NAT 后面、有没有公网 IPv6、路由器支不支持 UPnP；
- 不知道哪个隧道服务在自己的网络（尤其 CN 受限网络）能用；
- 就算选了，也不知道"建好的隧道是不是真的外网可达"（TCP 能连 ≠ 服务可用，
  实测本网络 hopto:22 TCP 不通；而可达的服务也可能被污染/建站失败）。

### 1.2 目标

1. **一条命令看清网络**：`st doctor` 边测边输出结构化网络画像（人话 + `--json`）。
2. **实测代替猜测**：对免账号/已配凭据的 provider 真实建立临时隧道并验证回环。
3. **可信且不被单点封禁**：多通道外部回访 + 内容级校验（echo n+delta），
   通道可插拔、可自建，置信级如实分层。
4. **智能建议，实时反馈**：每个探测/实测项完成即推送事件；建议滚动刷新，
   用户在 5 秒内就能看到第一版建议。
5. **零残留**：诊断过程产生的端口/隧道进程全部自动回收；不上传任何用户数据。

### 1.3 非目标

- 不做长延迟质量监测（连续盯几小时）——那是 guardian/监控的活；
- 不在诊断中替代 expose 的任何安全检查（`allow-auth-none`、D4 零转发语义不动）；
- 不引入新运行时依赖（通道全部为 `fetch`/`dgram`/`dns` 级实现）；
- 不保证对"高级对抗网络"给出绝对正确结论——置信级如实分层。

---

## 2. 回连通道实测调研（多通道冗余的依据）

> "让外部访问用户新开的 expose"是关键难题：**用户本机访问自己的隧道 URL 不能
> 证明外网可达**（本地 DNS 劫持/hairpin/代理缓存都可能假成功），必须有外部视角。
> 实测环境：CN 家宽（联通出口），日期 2026-08。**结论先行：不同网络环境可用通道
> 不同，没有任何单一通道能保证常通——通道必须是清单 + 插件，而不是硬编码一个。**

### 2.1 通道实测总表

| 通道 | 类型 | 免 key | CN 家宽实测 | 海外网络 | 能拿到的证据 |
|---|---|---|---|---|---|
| **check-host.net** `check-http/tcp/ping/dns` | 多节点拨测 | ✓ | ✅ 全端点可用 | ✅ | 状态码 / TCP 握手 / 各节点 RTT（异步 request_id → 轮询结果） |
| **api.hackertarget.com** `/httpheaders/?q=<url>` | 响应头回读 | ✓ | ✅ 可用 | ✅ | 目标真实响应头（含 `x-st-echo` tag）→ **头级内容校验** |
| **api.microlink.io** `/?url=` | 元数据抓取 | ✓(限额) | ✅ 可用 | ✅ | 目标可达 + 元数据（title/description）→ 辅助证据 |
| **api.allorigins.win** `/raw?url=` | 全文读代理 | ✓ | ⚠ TCP 通但 HTTP 超时 | ✅ | **完整 body** → E2 全内容校验 |
| **api.codetabs.com** `/v1/proxy?quest=` | 全文读代理 | ✓ | ⚠ HTTP 超时 | ✅ | 完整 body |
| **test.cors.workers.dev** `/?<url>` | CF Workers 读代理 | ✓ | ❌ TLS reset（SNI 干扰） | ✅ | 完整 body |
| **r.jina.ai** `/<url>` | URL reader | ✓(限流) | ❌ TCP 不通 | ✅ | body（text 化，需宽容校验） |
| **sslip.io** | 魔法域名（IP→域名） | ✓ | ✅（AAAA 正确） | ✅ | 让 check-host 接受 IPv6 目标 |
| api64.ipify / icanhazip / ip.sb | 出口 IP | ✓ | ✅（`api.ipify.org` 不可达——**多源必须**） | ✅ | 出口 v4/v6 |
| myip.ipip.net / cip.cc | 出口 IP+地理 | ✓ | ✅ | — | 出口 IP + 城市/运营商 |
| 1.1.1.1 / cloudflare DoH | 受限指标 | ✓ | ❌ 超时/reset（**失败本身是信号**） | ✅ | 受限网络评级 |

> 出口 IP 通道在 Phase A 使用；§3 的通道插件体系覆盖"回连探测"全部通道。

### 2.2 check-host 调用协议（内置主通道实现基准）

```
# 1) 提交探测（Accept: application/json 必须）
GET https://check-host.net/check-http?host=<url-encoded target>&max_nodes=3
→ {"ok":1,"request_id":"4a34a30bk9af","permanent_link":"...","nodes":{...}}

# 2) 轮询结果（每 2s，最多 30s）
GET https://check-host.net/check-result/<request_id>
→ {"de4.node.check-host.net":[[1,0.024,"OK","200","104.20.23.154"]], ...}
#    元组: [ok(1/0), 耗时秒, 消息, HTTP状态码, 对端IP]

# 其余端点：/check-tcp?host=<host:port>、/check-ping?host=<host>、/check-dns?host=<host>&type=A
```

实测要点：`check-http` **接受非标端口**（`http://ip:8443/`——portmap 外证可用）；
**拒绝裸 IPv6 字面量**（`invalid_url`）→ 用 sslip.io 域名变通（已验证 AAAA 正确、
check-http 接受并发起 v6 请求）；部分节点无 v6 路由（`No such device or address`）
→ `max_nodes=6` + 节点容错，一个节点成功即可判定。

### 2.3 置信级与交叉验证（诚实分层，单源不作数）

| 级别 | 名称 | 达成条件 | 含义 |
|---|---|---|---|
| **E2** | 外部内容级 | 外部回读完整 body 且 `verifyEchoBody` 通过（allorigins/codetabs/jina/自建探针） | 外网确实访问到了**我们的 echo**（最强） |
| **E1h** | 外部头级 | hackertarget 类读到响应头且 `x-st-echo` tag 匹配 | 外网到达了 echo 真身（body 未见，次强） |
| **E1** | 外部可达级 | check-host 节点 200/TCP 握手成功 + 对端 IP 与隧道域一致 + 自证内容级通过（组合判定 E1+） | 外网能到达隧道入口 |
| **L1** | 本机自证级 | 本机经隧道 URL 请求（×2 次不同挑战）+ echo 校验通过 | 隧道建立 + 本机视角可用；**不证明外网可达** |
| **U** | 未知 | 全部通道失败 | 如实说明 |

**确认标记（confirmed / unconfirmed / conflict）**——置信级回答"证据强度"，
确认标记回答"几个独立来源同意"：

| 标记 | 条件 | 展示 |
|---|---|---|
| `confirmed` | **≥2 个不同通道**给出非 U 且互相不矛盾的结果（默认还要求 kind 不同，如 probe-multi + fetch-proxy） | 绿勾；直接支撑建议高分 |
| `unconfirmed` | 仅 1 个通道给出结果（其余全失败/被禁用） | 黄问号；结论保留但降权，注明"单源，建议复核" |
| `conflict` | 通道结论矛盾（如 check-host 可达 but 回读通道拿到劫持页） | 红叹号；按 `onConflict` 取保守值，UI 展开双方证据 |

单源场景（用户只配了自建探针）可显式 `policy.singleSourceOk: true` 接受
unconfirmed 直接生效——默认不接受，宁缺毋滥。

---

## 3. 通道插件化设计（参照 `ddns-registry` 三层结构）

### 3.1 为什么参照 ddns

`ddns-registry.ts` 已验证的模式：**provider 元数据动态枚举**（`providerMetas()`）、
**凭据与目标分离的三层配置**（providerProfiles → profiles → entries）、
**配置文件 + env + 库 API 三种注册入口**。netcheck 通道面临完全同构的问题
（多个外部服务 × 各自参数 × 启用组合），直接复用该心智模型。

### 3.2 Channel 接口（`src/netcheck/channel-types.ts`）

```ts
export type ChannelKind = "probe-multi" | "fetch-proxy" | "header-reader" | "meta-reader" | "custom-http";

export interface ChannelCaps {
  http: boolean;            // 能对 URL 发 HTTP
  tcp: boolean;             // 能对 host:port 发 TCP 握手
  dns: boolean;             // 能做 DNS 对账
  ipv6: boolean;            // 能访问 v6 目标（直连/域名）
  bodyRead: "full" | "headers" | "meta" | "none";
  multiNode: boolean;       // 多节点（结果含 per-node RTT）
}

export interface ChannelProbeRequest {
  kind: "http" | "tcp" | "dns";
  target: string;                       // 完整 URL 或 host:port
  challenge: { n: string; d: string; tag: string };  // echo 挑战(拼进 URL)
  timeoutMs: number;
}

export interface ChannelProbeResult {
  ok: boolean;
  level: "E2" | "E1h" | "E1" | "L1" | "U";
  status?: number;
  nodes?: Array<{ id: string; ok: boolean; ms?: number; msg?: string; ip?: string }>;
  verify?: { pass: boolean; reason?: string };       // echo 校验(能读 body/头时)
  raw?: unknown;                                     // 原始响应(诊断日志用, 截断)
  error?: string;
}

export interface NetcheckChannel {
  id: string;                        // "check-host" / "hackertarget" / ...
  kind: ChannelKind;
  caps: ChannelCaps;
  /** 默认权重（调度排序 + 不一致投票），越大越优先。 */
  weight: number;
  /** 可选预检：通道自身可达性（结果按 id 缓存，参照 cloudflaredNeedsEdge 的一次性缓存模式）。 */
  healthCheck?(): Promise<boolean>;
  run(req: ChannelProbeRequest): Promise<ChannelProbeResult>;
}
```

**不变式**：通道只回答"目标 + 挑战 → 结果与校验"，不理解隧道业务；
评分与置信聚合在 `advise.ts`/`live.ts`，通道可被完全替换。

### 3.3 三层配置（`<configDir>/netcheck-channels.json`）

```jsonc
{
  // 第一层：通道参数/凭据（≈ ddns 的 providerProfiles）
  "channelProfiles": {
    "uptimerobot":  { "apiKey": "u***" },
    "my-vps":       { "endpoint": "https://probe.example.dev/check", "secret": "s***" }
  },
  // 第二层：通道实例（引用内置 id 或 profile；≈ ddns 的 profiles）
  "channels": [
    { "id": "check-host",   "enabled": true,  "maxNodes": 3 },
    { "id": "hackertarget", "enabled": true },
    { "id": "microlink",    "enabled": true },
    { "id": "my-vps",       "profile": "my-vps", "kind": "custom-http",
      "caps": { "bodyRead": "full", "ipv6": true }, "weight": 90 }
  ],
  // 第三层：调度策略（≈ ddns 的 entries：一次诊断怎么用这些通道）
  "policy": {
    "parallel": 2,            // 同时在途通道数
    "confirm": {              // ★ 交叉验证：单源不作数
      "minChannels": 2,       // ≥2 个通道一致才 confirmed
      "requireDifferentKind": true,  // 且 kind 不同（probe-multi + fetch-proxy…）
      "onConflict": "conservative"   // 冲突取保守（低）置信级；可选 byWeight
    },
    "afterConfirmed": "stop-new", // 确认后不再派发新通道；在途通道跑完作天然复核
    "breakAfterFails": 2,     // 连续失败 N 次 → 本轮熔断该通道
    "prefer": ["my-vps"],     // 有自建探针时优先
    "singleSourceOk": false   // 仅一个通道可用时是否接受单源结论（默认否）
  }
}
```

- 未配置时使用**内置默认**：check-host + hackertarget + microlink 并发 2、
  **双通道交叉确认**、冲突保守降级；allorigins/codetabs/cors-workers/jina 为
  **后备池**（前述通道熔断后顶上，凑满第二个确认源）——它们在海外网络可用，
  正好互补。
- 缺省文件的读取/容错语义对齐 `readDdnsConfigs`（损坏/缺失 → 空配置不报错）。

### 3.4 注册入口（三种，对齐现有扩展习惯）

1. **库 API**：`st.netcheck.registerChannel(ch: NetcheckChannel)` / `listChannels()` /
   `removeChannel(id)` —— 嵌入方（pi-web 等）注入自有探针。
2. **env（零文件）**：参考 `customTunnelTemplates()` 的
   `SERVICE_TUNNELS_TUNNEL_COMMAND_*` 模式——
   `SERVICE_TUNNELS_NETCHECK_CHANNEL_MYVPS='{"kind":"custom-http","endpoint":"https://...","secret":"...","weight":90}'`。
3. **配置文件**：§3.3 的 `netcheck-channels.json`（持久、UI 可管理）。

优先级：库 API > env > 配置文件（同名 id 覆盖）；全部来源合并去重后进入调度。

### 3.5 内置通道清单（v1 全部零依赖实现）

| id | kind | caps 摘要 | 实现要点 |
|---|---|---|---|
| `check-host` | probe-multi | http/tcp/ping/dns, multiNode, bodyRead:none | 异步提交+轮询；ipv6 走 sslip.io 域名；节点容错 |
| `hackertarget` | header-reader | http, bodyRead:headers | GET `/httpheaders/?q=`；解析响应头文本；校验 `x-st-echo` tag |
| `microlink` | meta-reader | http, bodyRead:meta | 元数据 JSON；status=success 且 url 回显一致 → E1 级佐证 |
| `allorigins` | fetch-proxy | http, bodyRead:full | `/raw?url=`；body → `verifyEchoBody` → E2 |
| `codetabs` | fetch-proxy | http, bodyRead:full | 同上（不同端点，互为热备） |
| `cors-workers` | fetch-proxy | http, bodyRead:full, ipv6 | `test.cors.workers.dev/?<url>` |
| `jina-reader` | fetch-proxy | http, bodyRead:full | text 化输出 → 校验器宽容模式（子串匹配 tag） |
| **`custom-http`** | custom-http | 按 profile 声明 | **通用自建探针模板**（下） |

### 3.6 自建探针（终极兜底：服务永远不会"被封"）

`custom-http` 通道约定一个 15 行可部署的探针契约：
`GET <endpoint>?url=<target>&timeout=<ms>` + 头 `x-st-probe-secret` →
返回目标原始 body（透传 content-type）。文档给出 Cloudflare Worker / Val.town /
VPS(nginx+任意后端) 三个模板（Worker 版 ≈10 行），企业内网/重度用户部署在
自己的 VPS/Workers 上——**回连链路的可用性由用户自己掌控**，这是对
"公共通道被封"的最终答案。secret 防探针被滥用为开放代理。

---

## 4. Echo 服务与校验协议（防误判核心）

### 4.1 设计原则

探测请求带**每次随机的挑战值**，响应必须是对挑战的**确定性变换**——任何缓存
（旧响应）、劫持页（固定内容）、默认错误页（ngrok ERR_* / localtunnel 提示页）、
假 200（透明代理）都无法构造出正确变换。

### 4.2 HTTP Echo

```
请求  GET /echo?n=<u32 随机>&d=<1..9 随机>&tag=<8hex 随机>
响应  200, content-type: application/json
      x-st-echo: <tag>                       ← 头级通道(hackertarget)的校验锚点
      cache-control: no-store
      {"v":"<n+d>","n":"<n>","d":"<d>","tag":"<tag>","srv_ms":<服务器毫秒>}

内容完整性（加强项）
请求  GET /echo/pattern?size=<4096..65536>&seed=<8hex>
响应  size 字节确定性 pattern（seed 派生）→ 逐字节比对，测压缩/截断/改写。
```

校验器为**纯函数**（`verifyEchoBody(body, {n,d,tag})` / `verifyEchoHeaders(hdrs, tag)`），
CLI / daemon / 通道实现 / 测试四处复用：

| 场景 | 现象 | 判定 |
|---|---|---|
| `v === n+d` 且 `tag` 一致 | — | ✅ 真回环 |
| `v === n_old + d_old` | 缓存命中 | ⚠ 缓存/复用响应 |
| 非 JSON / 固定 HTML | portal/劫持页/隧道错误页 | ⚠ 内容被替换（附 body 摘要） |
| 头 `x-st-echo` 匹配但无 body | 头级通道（hackertarget） | ✅ E1h |
| 连接拒绝/超时 | 隧道没建立/上游不通 | ❌ 不可达 |
| RTT < 5ms（公网目标） | 本地透明劫持嫌疑 | ⚠ 附 RTT 对比 |

### 4.3 TCP Echo（仅限暴露为 host:port 形态的隧道：bore raw / ssh raw / frpc tcp / portmap / ipv6）

```
请求  12B: "STNC" + u32be(seq 随机) + u32be(delta 1..9)
响应  12B: "STNR" + u32be(seq+delta) + u32be(delta)
校验  magic + seq+delta（防 RST 注入/中间盒假连接）；空闲 3s 断开；一连接多轮挑战。
注意  serveo/localhost.run/pinggy 经 ssh -R 固定映射 80/443 得到 https URL ——
      属 HTTP 形态，不走 TCP echo。
```

### 4.4 Echo Server 形态

- `src/echo.ts`：`startEchoServer(opts) → { httpPort, tcpPort?, stop() }`。
- 默认只绑 `127.0.0.1`；**仅 portmap/ipv6 直连验证**临时绑 `0.0.0.0`/`::` 并即时关
  （try/finally + 总超时兜底）；端口 `pickFreePort`；不注册进 discovery 白名单。

---

## 5. 诊断流水线（事件驱动）

### 5.1 事件模型（"边测边出"的核心契约）

```ts
export type NetcheckEvent =
  | { type: "phase-start";  phase: "A"|"B"|"C"|"D"; label: string; total?: number }
  | { type: "probe-done";   probeId: string; item: string;          // A/B 每个探测项
      verdict: string; ok: boolean; ms: number; detail?: unknown }
  | { type: "tunnel-est";   provider: string; url: string; ms: number }        // C: 隧道建立
  | { type: "tunnel-fail";  provider: string; error: string; ms: number }
  | { type: "channel-result"; provider: string; channel: string;               // C: 每通道回连
      level: "E2"|"E1h"|"E1"|"L1"|"U"; ok: boolean; ms: number; detail?: string }
  | { type: "verdict-confirmed"; provider: string; verdict: string;             // ★ ≥minChannels 通道一致
      confirmed: boolean; sourcesOk: number; conflict?: string }
  | { type: "advice-update"; advice: Advice[]; basis: "probe"|"live";           // ★ 滚动建议
      note: string }
  | { type: "phase-end";    phase: string; summary: string }
  | { type: "summary"; report: NetcheckReport; text: string; markdown: string }  // ★ 最终汇总
  | { type: "done"; report: NetcheckReport }
  | { type: "error"; message: string }
  | { type: "cancelled"; report?: NetcheckReport };   // 取消也带部分汇总
```

**API**：`runNetcheck(opts, onEvent) → Promise<NetcheckReport>`；`onEvent` 在每个
单项完成时同步触发（不缓冲整阶段）。另返回句柄 `{ cancel() }`（取消 = 停止派发新
探测 + finally 回收已有临时资源，**已收集结果照常汇总**，`report.truncated=true`；
cancel 对在途通道/隧道建立注入 AbortSignal（通道 `run(req)` 与取消共用 signal）。

**事件文案 i18n**：`label/summary/note/detail` 等人读字段一律带
`{ key, params }`（i18n key），**不在事件里内嵌已翻译字符串**——daemon 与 UI
语言可能不同（CLI 侧 `translate(lang, key, params)` 就地渲染，UI 侧 `UI_MSG` 表）。

### 5.2 两档模式

| 模式 | 覆盖 | 时长预算 | 反馈节奏 |
|---|---|---|---|
| `--quick`（默认） | A + B + D | **8-15s** | A 每项 1-2s 出一条；A/B 完即出**初步建议**（basis:"probe"） |
| `--full` | A + B + C + D | **45-120s**（可取消） | C 每个 provider 建立即报 → 每通道回连即报 → **每次实测后建议重算** |

### 5.3 Phase A — 本机网络画像（并行，逐项上报）

| # | 探测项 | 手段（复用优先） | 产出 |
|---|---|---|---|
| A1 | 系统与接口 | `os.networkInterfaces()`、`defaultGateway()`（portmap/probe） | 网卡清单 / 网关 IP |
| A2 | 出口 IPv4 | 多源并发（ipify64/icanhazip/ip.sb/ipip）任二成功；**不一致 → "存在代理/分流"** | 出口 v4 + 一致性 |
| A3 | 出口 IPv6 | `detectPublicIpv6` + v6 源 | 出口 v6（或无） |
| A4 | NAT 判定 | 本机 v4 vs 出口 v4；`classifyExternalIp` | 公网直连 / NAT / CGNAT |
| A5 | IPv6 全球地址 | `ipv6Diagnose()`（已有） | 有无 global |
| A6 | 代理检测 | env / scutil / 注册表 + A2 佐证 | 直连 / 系统代理 |
| A7 | 受限网络评级 | 并发小探针（1.1.1.1、DoH、google、baidu） | open / restricted / cn-typical |
| A8 | DNS 健康 | 解析 3 个隧道域名 + 保留段启发式 | 每域名 ✓/⚠/✗ |
| A9 | 网关能力 | `probePortmap()`（已有） | UPnP ✓/✗、PCP ✓/✗ |
| A10 | 防火墙 | `detectFirewall()`（已有） | 后端 |
| A11 | 工具就绪 | tools.ts `resolveToolPath()`（只探测，不触发下载） | 就绪/可下载/缺失 |

### 5.4 Phase B — 隧道服务端点可达（并行，~2-3s）

每 provider 握手端点 TCP/TLS 探测（CN 家宽实测基线：

```
tunnel.ngrok.com:443 ✓   region1.v2.argotunnel.com:7844 ✓   api.cloudflare.com:443 ✓
localtunnel.me:443 ✓     serveo.net:22 ✓                    localhost.run:22 ✓
free.pinggy.io:443 ✓     bore.pub:2200 ✓                    natapp.cn:443 ✓
tunnel.hopto.org:22 ✗（TCP 可达 ≠ 服务可用 —— 正是要 Phase C 实测的原因）
```

> 端点表为常量（`netcheck/probe.ts` 顶部），**实现时逐个对照官方文档校准**
> （natapp.cn 是官网而非隧道服务端点、bore.pub 公共服可用性需实测）。表驱动：
> 改一行即可，不影响流程代码。

cloudflared 附 SRV 查询（复用 `cloudflaredEdgeArgs`/`cloudflaredNeedsEdge`）——
SRV 失败但 443 通是 CN 典型态，直接进建议文案。账号型 provider（ngrok/natapp）
扫 `tunnels.json` 已配 token 决定是否进 C；未配置则 B 到顶并注明"需注册"。

### 5.5 Phase C — 真实 Expose 回环实测（逐 provider 串行，事件密集区）

```
echo = startEchoServer({loopback:true})           # 诊断期常驻, 结束统一关
for type in [serveo, localhost.run, pinggy, cloudflared, localtunnel, bore, (ngrok 若有 token)]:
  1. 起临时隧道 name="doctor:<type>" → emit tunnel-est / tunnel-fail
     （超时：ssh 系 25s / cloudflared 40s / 其他 30s）
  2. L1 自证：本机 fetch(tunnelUrl/echo?n&d&tag) ×2 次（不同挑战，防偶发碰撞）
     → verifyEchoBody → emit
  3. 通道并发（policy.parallel）：按 caps 过滤通道 → healthCheck 缓存 → 排序取前 N
     → 每通道完成即 emit channel-result（含 level）
  4. ★ 交叉验证（channel-aggregator 纯函数，随每份 channel-result 重算）：
     - 第 1 个通道出结果 → 初步 verdict（unconfirmed）→ 继续派发其余通道；
     - ≥minChannels(2) 个通道一致且 kind 不同 → emit verdict-confirmed(confirmed)
       → afterConfirmed=stop-new：不再派发新通道，在途通道跑完作天然复核；
     - 结论矛盾 → onConflict=conservative 取低值 + conflict 文案；
     - 全部通道用尽仍 <2 源 → unconfirmed（或 singleSourceOk 时放行）；
     - 主池熔断 → 后备池顶替（allorigins→codetabs→cors-workers→jina）凑第二源。
  5. 聚合该 provider 最终置信级（E2>E1h>E1；含 confirmed/unconfirmed/conflict 标注）
  6. ★ advice-update（basis:"live"）—— 立即重算建议推送
  7. finally: t.stop()

**Echo 形态选择**：HTTP echo 是所有 provider 的**主验证**（任何隧道都能透传 HTTP）；
TCP echo 仅对**暴露为 host:port 形态**的隧道附加执行（bore raw、ssh raw 模式、
frpc tcp、portmap、ipv6 直连）——serveo/localhost.run/pinggy 经 ssh -R 固定映射
得到的是 https URL（非 raw 端口），只能走 HTTP echo。伪代码中自证/回连均按此分派。

**直连类结果同样记入 liveTests**（provider = "portmap" / "ipv6-direct"，
verdict 同一枚举），保证报告矩阵单一来源。
```

直连类（A4/A9/A5 可用时）：portmap → `ensurePortmap(doctor-ephemeral)` + echo 绑
0.0.0.0 → E1 外证 `http://<外部IP>:<port>/echo...`（check-host 已验证接受非标端口）
→ 即时回收；ipv6 → echo 绑 `::` + **sslip.io 域名**外证（`max_nodes=6` 容错无 v6
节点；已配 DDNS 域名则优先真域名）→ 即时回收。防火墙放行沿用 portmap/firewall
模块（事后撤销）。

产出**能力矩阵**（随事件逐行填充；确认标记随交叉验证升级）：

```
provider      建立     自证       外部回连(通道)                          RTT        结论
serveo        ✓ 3.2s   ✓ n+7 ×2   E1+ [check-host 3/3] ✓confirmed         82-140ms   可用(E1+ 确认)
localtunnel   ✓ 1.8s   ✓ n+2 ×2   E2 [allorigins] + E1h [hackertarget] ✓ 65-120ms   可用(E2 确认)
bore          ✓ 2.4s   ✓ n+9 ×2   E1 [check-host 2/3] 单源 unconfirmed    90-150ms   可用(单源，建议复核)
cloudflared   ✗ SRV    —         —                                 —          规避
```

### 5.6 最终汇总（summary——事件流的收口）

流水线结束（正常完成 / 出错 / **中途取消**）时，把散落的事件归拢为**一份最终汇总**：

1. **`NetcheckReport`**（单一权威结构，`done`/`summary` 事件与返回值三处同一对象）：

```ts
interface NetcheckReport {
  schemaVersion: 1;
  meta: {
    startedAt: string; durationMs: number; mode: "quick"|"full";
    truncated?: boolean; cancelled?: boolean;
    tool: { version: string };
  };
  environment: {          // Phase A 归拢
    os: string; gateway?: string;
    egressIpv4?: string; egressIpv4Consistent: boolean;
    egressIpv6?: string; hasGlobalIpv6: boolean;
    nat: "public"|"nat"|"cgnat"|"unknown";
    proxy?: string; netClass: "open"|"restricted"|"cn-typical";
    dns: Array<{ host: string; ok: boolean; note?: string }>;
    upnp?: boolean; pcp?: boolean; firewall?: string;
    tools: Array<{ name: string; state: "ready"|"downloadable"|"missing" }>;
  };
  endpoints: Array<{ provider: string; host: string; reachable: boolean;  // Phase B
                     ms?: number; note?: string }>;
  liveTests: Array<{                                                       // Phase C
    provider: string; established: boolean; url?: string; establishMs?: number;
    selfCheck?: { pass: boolean; attempts: 2; detail: string };            // L1(×2 挑战)
    channels: Array<{ channel: string; kind: ChannelKind;
                      level: "E2"|"E1h"|"E1"|"U";
                      ok: boolean; ms?: number; nodes?: number; error?: string }>;
    verdict: "E2"|"E1+"|"E1"|"L1"|"fail"|"skipped";
    confirmed: boolean;      // ★ ≥minChannels 通道一致（交叉验证）
    sourcesOk: number;       // 给出有效结果的通道数
    conflict?: string;       // 通道结论矛盾时的说明
  }>;
  advice: Advice[];        // Phase D 最终建议（含 basis/confidence）
  channelsUsed: string[];  // 本次实际参与回连的通道（含熔断记录）
}
```

2. **多格式渲染**（`src/netcheck/format.ts`，纯函数，与报告同版本）：

```
formatReport(report, "text")      // 终端友好汇总块（CLI 结尾与事件流区分：『══ 体检报告 ══』框）
formatReport(report, "markdown")  // 一页纸 Markdown（可贴 issue/README/发 IM）
formatReport(report, "json")      // JSON.stringify(report, null, 2)
```

Markdown 模板（人话先行，机器数据附后）：`# service-tunnels 网络体检报告` →
一句话结论（Top1 建议 + 理由）→ 环境画像表 → 端点矩阵 → 实测矩阵（含通道明细与
置信级）→ Top3 建议卡（命令代码块）→ 元信息（时长/模式/truncated）→
`<details>` 完整 JSON（折叠）。

3. **取消/失败也汇总**：`truncated/cancelled` 如实标注，已完成部分完整可导出
   ——半程结果同样能贴出去问人。

### 5.7 Phase D — 智能建议（评分纯函数，随事件滚动）

```ts
interface Advice { id: string; score: number;
                   confidence: "E2"|"E1+"|"E1"|"L1"|"none";
                   confirmed: boolean;        // ★ 交叉验证标记（unconfirmed 降权）
                   title: string; why: string[]; caveats: string[]; cmd: string; }
```

确认标记参与评分：`confirmed` 实测 +满分值；`unconfirmed` 按该 provider 实测分的
60% 计（caveats 注明"单源结论，建议复核"）；`conflict` 取保守置信级再降 10 分。
这样**两个通道都通过**的 provider 天然排在单通道通过的之前——交叉验证直接
反映到建议排序。

评分规则（`netcheck-advise.ts` 常量表，可测试可调参）：

```
基础分              实测加分/减分                     环境修正
ipv6 直连    70      +20 外证通过, -30 失败             稳定免依赖（宣传位）
portmap      65      +20 外证通过                      CGNAT → 硬过滤
                                                       v4 public 直连 → 并入本条
                                                       （无独立 direct 模式, 不建议
                                                       不存在的命令; UPnP 直通时同分）
cloudflared  60      +20 实测通过                      SRV 失败 → -40; cn-typical -5
serveo/lt.run/pinggy 55  +15 实测 +10 E1 +5 E2        免账号 +5; 60min 限时 -5(Caveat)
localtunnel  55      同上                              国内访问延迟样本展示
bore         50      同上(需下载二进制 -5)
ngrok        60      +15 实测                          有 token +10 / 无 -15(提示注册)
natapp       45      端点可达 +10                      cn-typical +15; 付费 token(Caveat)
frpc 自建     40      (需自建服务器, 默认不推荐位)       cn-typical +10
proxy(vhost) 50      本地/局域网场景单独提示, 不与公网方案混排
```

quick 模式（无 Phase C）：所有条目按基础分+环境修正排序，confidence 全为
none（"未实测"角标）；`+20 外证通过` 等实测加分仅 full 模式生效。

- **滚动逻辑**：A/B 完成给初步建议（confidence 全为 none，note="基于探测，未实测"）；
  C 每完成一个 provider，实测置信级覆盖对应项并重算排序；**verdict-confirmed
  （第二源到齐）再刷新一次**——用户能看到结论从"单源黄问号"升级为"双源绿勾"。
  UI 建议卡片实时重排，CLI 追加"建议(更新)"块——**用户 5s 内看到第一版建议，
  全程无需等最后**。
- 硬过滤：实测失败 → 移出 Top3（矩阵保留失败原因）；工具缺失且不可下载 → 降权提示。
- **建议命令的目标端口**：CLI 位置参数 `st doctor [port]`（缺省 3000）；UI 侧取
  expose 表单当前端口。所有 `cmd` 生成走同一函数（单测覆盖）。
- 输出 Top3 + 完整矩阵 + 下一步命令（`st expose 3000 --mode ipv6 --auth auto` 或
  UI 一键预填）；固定注入安全文案（`--auth auto` 默认；`allow-auth-none` 语义提示）。
- **全失败兜底**：Top3 为空时建议区输出排查指引——摘要（哪些阶段失败/网络评级/
  代理状态）+ 分支文案（有代理→"关代理重试或配 tunnel proxy"；cn-typical→
  "考虑自建 frpc/zrok server 或 natapp"；全部通道不可达→"出站可能被管控，
  `st doctor --no-net` 看本地画像"）。绝不出空报告。
- **最终汇总**：`done` 前必发 `summary` 事件（§5.6）——同一 NetcheckReport 渲染为
  text/markdown/json 三形态；UI 侧即"体检报告"卡片的渲染来源。

---

## 6. CLI 形态（流式输出）

```
st doctor [port]                # quick: 画像 + 端点可达 + 建议 (8-15s, 边测边出)
                                #   [port] 可选: 想暴露的目标端口(建议命令用, 缺省 3000)
st doctor --full                # + 真实隧道实测 (45-120s, Ctrl-C 安全取消)
st doctor --json                # 结尾汇总输出 JSON (嵌入方/CI)
st doctor --md                  # 结尾汇总输出 Markdown 报告
st doctor --format json|md|text # 显式指定汇总格式 (默认 text)
st doctor -o report.md          # 汇总写入文件 (与 --format 组合; stdout 保持事件流)
st doctor --events              # NDJSON 事件流到 stdout (程序化消费: 逐行解析, 含 summary 事件)
st doctor --only a,c            # 只跑部分阶段
st doctor --providers serveo,cloudflared
st doctor --no-net              # 离线画像: 跳过全部外呼项
                                #   (跑 A1/A5/A6/A10/A11; 跳过 A2/A3/A7/A8 与 B/C)
st netcheck ...                 # 别名
st doctor channels list|enable <id>|disable <id>   # 通道管理(读写 netcheck-channels.json)
```

输出规则：**默认交互模式**事件/进度走 **stderr**、最终汇总走 stdout（`-o` 时走
文件、stdout 只留一句"报告已写入 …"）；**`--events` 模式**为机器消费，事件流
（NDJSON，含最后一行 `summary`）整体走 **stdout**，此模式下人读汇总仅写 `-o`
文件。`--events` 与 `--format` 可并存。

终端行为（进度走 stderr，结果/`--json` 走 stdout 便于管道）：
`onEvent` 直通——每个 `probe-done`/`tunnel-est`/`channel-result` 立即打印一行
（阶段前缀 + 耗时）；`advice-update` 打印"建议(初步/第N次更新)"块。
`--events` 模式把 NetcheckEvent 原样 NDJSON 输出（嵌入方无需解析终端 UI）。

```
$ st doctor --full
[A2] 出口 IPv4  61.x.x.x (4/4 源一致)              0.8s
[A4] NAT        是（私网段 192.168.1.x / 网关 192.168.1.1）  1.2s
[A5] IPv6       无全球地址
[A9] 网关       UPnP ✓  NAT-PMP ✗
[B ] serveo ✓  localhost.run ✓  cloudflared ✓(SRV✗)  bore ✓  hopto ✗
[建议·初步] 1. portmap(UPnP) 85  2. serveo 70  3. localtunnel 68   ← B 完即出
[C ] serveo        建立B 3.2s  自证✓(n+7)  check-host 3/3 E1+ 82-140ms
[建议·更新] 1. portmap 88  2. serveo 81(E1+)  3. localtunnel 68
[C ] localtunnel   建立B 1.8s  自证✓(n+2)  allorigins E2 ✓  65-120ms
[C ] cloudflared   ✗ SRV 失败（CN 典型）
[建议·最终] 1. portmap(UPnP) 88  st expose 3000 --mode portmap --auth auto
            2. serveo 81(E1+)  st expose 3000 --tunnel serveo --auth auto
            ⚠ serveo 为第三方临时域名，适合演示；长期服务建议 portmap + DDNS。
```

退出码：0 = 至少一条可用建议；1 = 全部不可用；2 = 参数错误；130 = 取消。

## 7. UI 形态（daemon API + 「体检」tab，增量轮询）

- `ui-api.ts` 新端点（沿用 if 分发 + 轮询风格）：
  - `POST /api/netcheck-start` `{mode, providers?}` → `{jobId}`；单例 job（409 返当前进度）。
  - `GET /api/netcheck-status?job=<id>&since=<n>` →
    `{phase, progress, events: Event[](since 起的增量), advice?, result?}`
    —— 前端 1s 轮询、按 `events.length` 续传，**逐条渲染事件流**；
    `progress` = 已完成探测项/估算总数（A 固定 11 项 + B 端点数 +
    C 的 provider×(1 建立+2 自证+通道数)，job 状态机维护）。
  - `POST /api/netcheck-stop` → `cancel()`（finally 回收全部临时资源）。
  - `GET/POST /api/netcheck-channels` → 通道清单/启停（读写 netcheck-channels.json）。
- `src/ui/client/doctor.js`：tab「体检 Doctor」
  - quick / full 两档启动 → 分阶段进度 + **事件流逐条点亮**；
  - **建议卡片实时重排**（advice-update 驱动；初步建议灰显"未实测"，实测后转实色）；
  - 能力矩阵表随 channel-result 填充；
  - 每条建议带「按此方式暴露」→ 跳 exposes tab 预填 mode/tunnel 并高亮；
  - **体检报告卡**（summary 事件驱动）：「复制 Markdown」「下载 .md」「复制 JSON」
    三个导出动作（纯前端渲染，无需新端点）；
  - 通道管理入口（清单 + 启停 + 自建通道表单）。
- i18n：`i18n.ts` 增 `netcheck.*` 键（中英；人话文案走 i18n，不硬编码）。

## 8. 模块落点与实现顺序

```
src/echo.ts                     Echo server + verifyEchoBody/Headers/TcpEcho（纯函数校验器）
src/netcheck/channel-types.ts   NetcheckChannel 接口 + 事件类型（§3.2/§5.1 契约）
src/netcheck/channels/          内置通道：check-host.ts / hackertarget.ts / microlink.ts /
                                allorigins.ts / codetabs.ts / cors-workers.ts / jina.ts /
                                custom-http.ts + index.ts（注册表/合并/env 解析）
src/netcheck/channel-registry.ts  配置读写(三层 netcheck-channels.json, 容错对齐 readDdnsConfigs)
                                  + 调度器(过滤/并发/交叉验证聚合/熔断/后备池)
src/netcheck/probe.ts           Phase A/B（复用 ipv6/portmap/firewall/tools, 只读无副作用）
src/netcheck/live.ts            Phase C（临时隧道编排 + 通道调度消费, 全部 ephemeral）
src/netcheck/advise.ts          Phase D 评分规则（常量表 + 纯函数）
src/netcheck/format.ts          NetcheckReport → text|markdown|json 渲染（纯函数）
src/netcheck/index.ts           runNetcheck(opts, onEvent) 编排 + cancel + job 状态机
                                  + 最终 summary（含取消/失败路径的归拢）
```

- 导出：`index.ts` 增 `st.netcheck.{run,registerChannel,listChannels,channels}`；
  `cli.ts` 加 `doctor` 分支；`ui-api.ts` 加四端点；`usage()` 更新。
- 实现顺序（每步独立可测、独立可交付）：
  1. `echo.ts` + 校验器单测（无网络）；
  2. `channel-types` + `check-host`/`hackertarget` 两通道（联网测试打标记）；
  3. `channel-registry` + 调度器单测（mock 通道注入——插件接口的第一次实战验证）；
  4. `probe.ts`（A/B）+ `advise.ts` 规则单测（固定输入断言建议序与滚动重算）；
  5. `live.ts` + 编排（onEvent 全链路）；6. CLI（含 `--events`）；7. UI（API + tab）；
  8. 通道管理端点 + 自建探针模板文档（`docs/netcheck-channels.md`）。

## 9. 安全与资源边界

1. **临时资源零残留**：`doctor:*` 隧道、端口映射、echo 端口在 finally + 总超时
   （full 上限 150s）+ 退出钩子三重兜底回收；`st stop-all` 可兜底。
2. **echo 不是服务**：仅诊断期存在；绑定面最小化；无持久化/文件访问；不产生
   enrollment 语义。
3. **外呼内容**：隧道类回连目标 URL 仅含隧道随机子域 + echo 随机挑战；
   **直连类外证（portmap/ipv6）目标必然含用户公网 IP:port**（会发给 check-host——
   该地址本就是公网暴露面；报告 markdown 对直连目标打码）；不发送用户 token；
   自建探针 secret 走请求头不落 URL/日志。
3b. **平台边界**：`defaultGateway()` 仅 Linux/macOS（/proc/route）——Windows 上
   A9（网关/UPnP）输出 unknown 并提示手动映射；其余探测项跨平台（Node API +
   fetch）。纯函数单测覆盖三平台语义。
4. **节流与配额**：check-host 每次诊断 ≤12 次提交；hackertarget 免费档按日限额 →
   放后备池且失败不重试；通道短路（E2 达成即取消其余）本身就是节流。
5. **安全语义不绕行**：诊断不创建任何可复用放行；建议文案固定 `--auth auto`；
   `allow-auth-none` 与 D4 在 doctor 任何路径不受影响。
6. **daemon 单例 job**：并发诊断 409 + 当前进度，防资源互踩。

## 10. 测试与验收

- **纯函数单测**（无网络）：echo 校验器全分支；TCP echo round-trip；sslip.io 编码；
  check-host 结果元组解析（含 no-ipv6 节点）；**通道注册表合并语义**
  （文件/env/库 API 覆盖、损坏文件容错）；**调度器**（mock 通道：并发数、**交叉验证：单源 unconfirmed / 双源一致 confirmed /
  冲突保守降级 / 后备池凑第二源 / afterConfirmed 停派**、熔断、weight 投票）；
  advise 评分与滚动重算（固定输入断言 Top3，含 unconfirmed 60% 降权断言）；
  **format.ts**：同一报告三形态渲染（md 含完整 JSON 折叠块、truncated 标注、
  text 框线对齐）、schemaVersion 兼容。
- **本地 e2e**（`pickFreePort`）：echo 起→HTTP/TCP 验证→stop 无残留；job 取消回收。
- **联网 e2e**（`NETCHECK_E2E=1` 才跑）：check-host 对真实 echo 隧道验证一条；
  hackertarget 头级校验一条。
- **验收标准**：
  1. 事件契约：`--events` 逐行可解析；首个 `advice-update`（初步）在 quick 模式
     ≤8s 出现；C 阶段每个 provider 完成后必有 `advice-update`；
  2. **最终汇总**：任何结束方式（done/error/cancelled）都产出且仅产出一次
     `summary`；`--json`/`--md`/`-o report.md` 输出可被 `JSON.parse` / 渲染器直接
     消费；取消场景 report.truncated=true 且已完成部分完整；
  3. **交叉验证 + 通道插件化**：mock 双通道一致 → confirmed 且建议分高于单源；
     仅单通道可用 → unconfirmed 降权；两通道矛盾 → conflict + 保守值；
     单通道 + singleSourceOk=true → 正常生效；mock 通道注册（其余禁用）可完成
     一次 full 诊断——**通道可完全替换、单点封禁不阻塞**；
  4. `NetcheckReport`/`NetcheckEvent` schema 文档化且 `--json` 字段稳定；
  5. quick ≤15s / full 无残留（`st status` 对账）；CN 与海外网络各跑一轮建议序符合
     §2 实测预期；`npm test` 全绿 + typecheck 通过；README/cli.md 同步。

## 11. 风险与明确不做

| 风险 | 处置 |
|---|---|
| 公共通道被单点封禁 | **多通道 + 后备池 + 熔断顶替**；自建探针兜底（链路由用户自控） |
| hackertarget/microlink 免费限额 | 后备池位 + 失败不重试 + 通道健康缓存 |
| check-host 限速 | 节流 + 短路省调用 + 降级 L1 明示 |
| 部分节点无 IPv6 | max_nodes=6 + no-ipv6 节点容错（错误形态已实测） |
| sslip.io 第三方依赖 | 仅诊断期临时域名（结束即失效）；生产走 DDNS |
| ssh 系隧道跨境握手慢 | 建立超时分档 + provider 间隔离 + 事件即时反馈（用户可中途取消） |
| 免账号服务政策变化 | provider/通道全部常量表驱动，B/C 结果自动反映，评分可调 |
| 严格出站审计网络 | `--no-net` 离线画像；全部外呼 HTTPS 443（7844 只探不建） |

**明确不做**：不做常驻监控告警；不做隧道服务账号自动注册；不做绕过
`allow-auth-none` 的免认证实测；不把诊断结果自动写入 expose 配置（建议永远只建议，
执行永远显式）；不提供公开共享的自建探针服务（模板给用户自部署，规避滥用与运维负担）。
