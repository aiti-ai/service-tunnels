# 内部可信客户端放行 — 内存轮换 token + 进程凭证旁路

> 状态：**已实现（待你验收）**。方案 C 全部落地：内存轮换 token ring 主层
> + Linux 进程凭证探针增强层（非 Linux 降级为纯 token）。核心 ring 单测 8/8、
> proxy 旁路集成测试 8/8、探针单测 4 pass+1 skip 全过；全量回归 0 失败。
> 探针默认不 wire（嵌入方按需 `createServiceTunnels({ verifyInternalProcess:
> createLinuxProcessProbe() })`）。详见 §4 改动点清单与 §9 验收结果。

## 1. 目标与背景

### 1.1 用户场景
嵌入方（pi-work 的 service-tunnels 扩展）集成 service-tunnels 时，希望**库直接接管
登录、拦截所有请求**（proxy self 已部分实现：`st.self` + allowlocal 门禁 +
`st.proxy.resolve()` 进程内决策）。但拦截后，**AI 内部用 curl / fetch 发起的请求也会
被认证阻断**——AI 没有浏览器会话、不会自动带 cookie/走登录页。

### 1.2 用户的两个想法
1. **临时 token**：设置一个不落盘、带 TTL、定期轮换的 token，内部 bash 拿到（环境
   变量注入），请求时带上 `Authorization: Bearer <token>` → 放行。
2. **进程凭证追踪**：追踪请求是否来源于内部子进程；若子进程持有相关环境变量
   （`SERVICE_TUNNELS_MARKER`），**直接放行**（子进程无需带 token）。

## 2. 现状分析（已有机制，避免重复造轮子）

| 机制 | 位置 | 形态 | 是否适用本场景 |
|---|---|---|---|
| 落盘 token provider | `src/providers/token.ts` | `tokens.json`（0600，只存 sha256）、长期、按 site、可管理/撤销 | ❌ 长期机器凭证，不适合"AI 会话级临时、自动轮换" |
| pi-web self-forward token | `pi-web-ext/.../proxy-shared.ts`（**不在库内**） | 内存 `Map`、30s TTL、URL query `__piSelfFwd` | ⚠️ 每个宿主自己抄一遍；放 URL query 不如 Bearer 标准 |
| `SERVICE_TUNNELS_MARKER` | `src/marker.ts` | 库 init 生成 per-process marker，stamp 到所有 spawn 子进程；`/proc/<pid>/environ` 可查 | ✅ **想法②的技术基础已存在** |
| /proc 进程树/端口反查 | `src/discovery.ts` | `/proc/net/tcp`→pid、`/proc/<pid>/environ` 读 marker、`findPortListeners` | ✅ **想法②的反查基础设施已存在** |
| allowlocal 门禁 | `src/expose-self.ts` + `index.ts` `st.self` | allowlocal=false 拦截所有裸直连（含回环） | ✅ 与本机制正交（一个管"是否要认证"，一个管"认证如何旁路"） |

**关键发现**：想法②"TCP 拿不到对端 pid"是误区——TCP socket API 拿不到，但
`/proc/net/tcp` 能反查出占住某 ephemeral port 的 pid，库里 discovery.ts 已在用。

## 3. 方案设计

### 3.1 整体架构（推荐：两者结合，分层）

```
请求到达 proxy (TCP)
  │
  ├─① resolveServiceHost：host 解析 + enrollment（既有逻辑，不变）
  │
  ├─② 内部旁路判定 internalBypass（新增）：
  │     ├─ verifyInternalToken(auth)   ← 主层（想法①）：内存轮换 ring 校验 Bearer
  │     └─ verifyInternalProcess(remoteAddr) ← 增强层（想法②）：/proc 反查 marker（预留）
  │     命中 → 跳过 basic/token/forward-auth，直接走 pipe/forward
  │
  └─③ 既有认证 gate（internalBypass=false 时执行）：basic/token/forward-auth
```

- **主层（必做，跨平台）**：`InternalTokenRing`——不落盘、TTL、定期轮换 + 天然
  overlap（老 token 在自身 TTL 内仍有效，rotate 时刻正在飞的请求不 401）。宿主把
  当前 token 通过环境变量注入子进程，子进程 curl 带 Bearer 即放行。
- **增强层（Linux 优先，可降级）**：进程凭证追踪——复用 `marker.ts` + `discovery.ts`
  的 /proc 反查，对 `remoteAddress` 是回环的请求，反查 pid → environ marker → 命中
  放行。**子进程完全不用改 curl**。非 Linux / 探测失败 → 返回 false（降级为纯 token）。
  带短 TTL 缓存避免每请求扫 /proc。

### 3.2 为什么用 Bearer header 而非 URL query token
pi-web 现有 self-forward token 放 URL query。本库方案改用 `Authorization: Bearer`：
- 标准（RFC 6750），curl/fetch/各类 HTTP 客户端原生支持；
- 不污染 URL（query token 会被 access log / Referer 泄露）；
- 与既有落盘 token provider 一致（`verifyBearerToken` 同形态）。

### 3.3 InternalTokenRing 数据结构

```
ring: RingEntry[]  // 容量 ringSize（默认 3）
RingEntry = { token: string|null, hash: string, issuedAt, expiresAt }
```

- 仅**最新**条目保留 `token` 原文（供 `envForChild()` 重复注入子进程）；rotate 后老
  条目 `token` 置空，只留 `hash`（overlap 期内仍可校验）。
- TTL 默认 15min、轮换间隔默认 5min → overlap = 10min（老 token 在自身 TTL 内有效）。
- 校验 constant-time（`timingSafeEqual`）、fail-closed、按需 prune 过期。
- 进程退出即全部失效（不落盘 = 不残留）。

### 3.4 API 形态（`st.internalTokens`，避开已占用的 `st.internal`）

```ts
st.internalTokens: {
  currentToken(): string;                          // 当前原文（注入子进程用）
  envForChild(): { ST_INTERNAL_TOKEN: string;      // spawn(cmd, args, { env: {...process.env, ...envForChild()} })
                   ST_INTERNAL_TOKEN_EXPIRES: string };
  verify(authorization: string | undefined): boolean; // 进程内校验（嵌入方 middleware 可直调）
  rotate(): void;                                  // 手动轮换（测试 / 怀疑泄露）
  status(): { size, ttlMs, rotateIntervalMs, current: {issuedAt, expiresAt, rotatesAt}|null }; // 不含秘密
  stop(): void;
}
```

宿主用法示例：
```ts
const st = createServiceTunnels();
// 启动 AI 子进程（bash）时注入 token：
spawn('bash', [], { env: { ...process.env, ...st.internalTokens.envForChild() } });
// 子进程内：curl -H "Authorization: Bearer $ST_INTERNAL_TOKEN" http://...
```

### 3.5 接入点
- `ServiceHostResolveContext`（`proxy.ts`）新增 `verifyInternalToken?` + `verifyInternalProcess?`。
- `resolveServiceHost` 开头算 `internalBypass`，gate 调用包一层 `gate`（bypass 时返回
  null 跳过认证 backend），forward-auth/basic gate 加 `!internalBypass` 守卫。
- `ProxyOptions` / `ProxyManagerOptions` 透传两字段。
- `createServiceTunnels` 创建 `InternalTokenRing`，wire `verifyInternalToken` 到
  `ProxyManager`，暴露 `st.internalTokens`，shutdown 时 `stop()`。

## 4. 改动点清单

### 4.1 已实现（待方案确认后收口命名）
| 文件 | 改动 | 状态 |
|---|---|---|
| `src/internal-token.ts` | 新增 `InternalTokenRing` 类 | ✅ 单测 8/8 |
| `test/internal-token.test.mjs` | ring 单测 | ✅ 全过 |
| `src/proxy.ts` | `ServiceHostResolveContext` + `ProxyOptions` 加两字段；`resolveServiceHost` 加 `internalBypass` + `gate` 包装；3 处 gateBackend 调用 + 2 处 forward-auth/basic gate 加守卫；`createProxyServer` 两处 ctx 透传 | ✅ 编译通过 |
| `src/proxy-manager.ts` | `ProxyManagerOptions` 加两字段；`start`/`resolve` 透传 | ✅ 编译通过 |
| `src/index.ts` | import + `ServiceTunnelsOptions`（internalToken/verifyInternalProcess）；`ServiceTunnels` interface 加 `internal` 字段；创建 ring + wire ProxyManager；暴露 API；shutdown stop | ⚠️ **`internal` 名字与 `InternalRegistry` 冲突，待改名 `internalTokens`** |

### 4.2 待做（方案确认后）
1. `src/index.ts`：`internal` → `internalTokens`（interface 字段 + 暴露对象 + 注释），跑通编译。
2. 集成测试：`test/proxy.test.mjs` 加 case——带内部 token 的请求旁路 basic/forward-auth。
3. 想法②（若确认做）：新增 `src/internal-process-probe.ts`——`createLinuxProcessProbe`，
   复用 `marker.ts` 的 `getMarker()` + `discovery.ts` 的 /proc 反查，带 TTL 缓存；
   非平台返回 false。`createServiceTunnels` 默认**不**wire（由嵌入方按需传入
   `opts.verifyInternalProcess`），避免核心路径引入 /proc 依赖。
4. 文档：`docs/` 加 API 说明；`CHANGELOG.md` 记一条。
5. pi-work 扩展侧（宿主）：把 `st.internalTokens.envForChild()` 注入 AI bash 子进程，
   用 `st.internalTokens.verify` 替换自实现的 self-forward token——**这是宿主侧改动，
   在 pi-work 仓库，不在本库 PR 范围**，但方案里要说明迁移路径。

## 5. 影响面
- **核心决策路径**：`resolveServiceHost` 是所有 vhost 请求的必经之路。新增的
  `internalBypass` 在**所有 vhost、所有 site、所有 provider**之前判定。**风险**：
  若 token 泄露/进程凭证误判 → 绕过全部认证。缓解见 §6。
- **性能**：token 校验是内存 hash 比对（µs 级），可忽略。想法②的 /proc 反查需缓存
  （见 §6）。
- **兼容性**：两字段均可选，缺省 `undefined` → `internalBypass` 恒 false → 行为与
  现有完全一致，零回归。`st.internalTokens` 是新增 API，不影响既有调用方。
- **跨平台**：主层纯 JS（crypto），全平台。想法②仅 Linux（macOS 需 lsof、Windows 无）。

## 6. 风险与缓解
| 风险 | 缓解 |
|---|---|
| token 泄露 → 绕过认证 | 不落盘（重启失效）+ TTL 短（默认 15min）+ 定期轮换 + overlap 窗口窄；进程凭证探针仅认 marker（= 本库 spawn 的后代），不认任意回环 |
| 轮换瞬间正在飞的请求 401 | 天然 overlap：老 token 在自身 TTL 内仍有效，rotate 只生成新 token 不立即废老 token |
| 进程凭证反查 /proc 性能 | 带 TTL 缓存（key=remoteAddress ephemeral port，TTL≈连接生命周期 60s）；非 Linux 直接 false |
| TIME_WAIT 端口复用误判（同一 ephemeral port 被新连接复用） | 缓存 TTL 设短（≤60s）+ 校验时同时确认 pid 仍存活（读 /proc/<pid> 失败即判否） |
| `internalBypass` 范围过大（覆盖所有 vhost） | 设计如此（内部客户端需访问任意已 enroll 的服务）；enrollment（D4）仍生效——未 enroll 的端口仍 403，token 只旁路"认证"不旁路"enrollment" |
| 命名 `internal` 冲突 | 改 `internalTokens`（已识别） |

## 7. 测试计划
- ✅ `internal-token.test.mjs`：currentToken/verify/rotate overlap/ringSize 裁剪/status 不泄密/autoRotate/stop/clamp（8 case，已过）
- ⏳ `proxy.test.mjs` 集成：basic vhost + 带 internal token → 200（旁路）；不带 → 401；forward-auth vhost 同；未 enroll 端口带 token 仍 403（enrollment 不被旁路）
- ⏳ 想法②（若做）：mock /proc 或在 Linux CI 跑真实进程反查

## 8. 待确认决策点（请拍板）

1. **实现深度**（最关键）：
   - [ ] C：token ring（主层）+ 进程凭证探针（增强层，Linux，可降级）——推荐
   - [ ] A：只做 token ring（想法①），跨平台纯 token
   - [ ] D：先做 token ring + 预留 `verifyInternalProcess` 接口（probe 实现留 stub 返回 false），后续再补②
   - [ ] B：只做进程凭证追踪（想法②），AI 不改 curl（仅 Linux）
2. **API 命名**：`st.internalTokens`（推荐，避 `internal` 冲突）/ 其他？
3. **环境变量名**：`ST_INTERNAL_TOKEN` + `ST_INTERNAL_TOKEN_EXPIRES`（推荐）？
4. **默认参数**：TTL=15min、轮换=5min、ringSize=3——可接受？
5. **想法②的探针是否默认 wire**：推荐**不**默认 wire（嵌入方按需传 `opts.verifyInternalProcess`），避免核心路径引入 /proc 依赖。同意？
6. **已实现代码处置**：核心 ring + proxy 接入已写并单测通过，是保留并收口命名，还是要按确认后的方案调整？

## 9. 验收结果（方案 C 全部落地）

### 9.1 决策采纳
用户确认方案 **C**（token ring 主层 + 进程凭证探针增强层）。次要点按推荐默认执行：API `st.internalTokens`、环境变量 `ST_INTERNAL_TOKEN`(+`_EXPIRES`)、TTL=15min/轮换=5min/ringSize=3、探针不默认 wire、已写代码保留收口。

### 9.2 改动文件清单
| 文件 | 性质 | 内容 |
|---|---|---|
| `src/internal-token.ts` | 新增 | `InternalTokenRing` 类（不落盘、TTL、定期轮换+overlap、constant-time 校验） |
| `src/internal-process-probe.ts` | 新增 | `createLinuxProcessProbe()`（marker + /proc 反查 + TTL 缓存，非 Linux 降级 false） |
| `src/proxy.ts` | 改 | `ServiceHostResolveContext`/`ProxyOptions` 加 `verifyInternalToken?`+`verifyInternalProcess?`；`resolveServiceHost` 加 `internalBypass`+`gate` 包装；3 处 gateBackend 调用 + 2 处 forward-auth/basic gate 加守卫；`createProxyServer` 两处 ctx 透传 |
| `src/proxy-manager.ts` | 改 | `ProxyManagerOptions` 加两字段；`start`/`resolve` 透传 |
| `src/index.ts` | 改 | import+导出；`ServiceTunnelsOptions` 加 `internalToken`/`verifyInternalProcess`；创建 ring + wire ProxyManager；`ServiceTunnels` interface 加 `internalTokens`；暴露 API；shutdown stop ring |
| `test/internal-token.test.mjs` | 新增 | ring 单测 8 case |
| `test/proxy-internal-bypass.test.mjs` | 新增 | 旁路语义 8 case（enrollment/allowlist 不被旁路、tokenFile gate 被旁路、overlap） |
| `test/internal-process-probe.test.mjs` | 新增 | 探针 5 case（含 Linux 真实回环 e2e） |
| `docs/internal-token-design.md` | 新增 | 设计 + 技术评估 + API |
| `CHANGELOG.md` | 改 | 0.3.73 条目 |

### 9.3 测试结果
- `internal-token.test.mjs`：8/8 ✅
- `proxy-internal-bypass.test.mjs`：8/8 ✅
- `internal-process-probe.test.mjs`：4 pass + 1 skip（非 Linux 降级 case 在 Linux 跳过）✅
- 全量回归：**292 tests / 289 pass / 0 fail / 3 skip**（基线 271 + 新增 21：ring 8 + bypass 8 + probe 5，probe 非Linux降级 case 在 Linux 跳过）✅
- `tsc --noEmit`：通过

### 9.4 关键语义保证（测试已覆盖）
- internalBypass **只旁路认证**，不旁路 enrollment（未 enroll 端口带 token → 403）
- internalBypass **不旁路 allow-list**（isAllowed=false 带 token → 403）
- fail-closed：错误/过期 token → 401
- overlap：rotate 后老 token 在 TTL 内仍放行
- 进程凭证探针：只认回环 + 只认继承 marker env 的子进程（未继承不命中）

### 9.5 遗留与后续
- **pi-work 宿主侧迁移（不在本库）**：pi-web-ext 的自实现 self-forward token（`proxy-shared.ts`）可改用 `st.internalTokens.envForChild()` + `st.internalTokens.verify()`，并把 AI bash 子进程注入 token / 或 wire `createLinuxProcessProbe()` 免 token。需在 pi-work 仓库单独 PR。
- **token 刷新通知**：当前子进程在 token 过期前需重启或 IPC 刷新拿到新 token；overlap 窗口已给足宽限（默认老 token 在 TTL 内仍有效，多数场景够用）。若要做"token 即将过期主动通知子进程"，可加一个 `onRotate(prevToken, newToken)` 回调或宿主 IPC 推送——当前未做，列为后续增强。
- **探针默认 wire 取舍**：当前默认不 wire（嵌入方显式传入），避免核心路径对非 Linux 环境引入 /proc 读取。若未来想让库"开箱即用"地支持想法②，可加 `ServiceTunnelsOptions.autoWireProcessProbe?: boolean`，但需权衡 /proc 读取在每次请求路径上的开销与缓存策略。
