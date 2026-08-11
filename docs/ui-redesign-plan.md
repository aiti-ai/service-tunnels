# UI 重设计实施计划（本次执行）

> 依据：`docs/ui-redesign.md`（设计文档，已按审计修订）。本文档是**执行计划**：
> 按里程碑拆到任务级，标注文件/验收/风险；本轮会话实施范围 = M0a + M0b + M0c + M1，
> 浏览器验证用 chrome-devtools。

## 实施范围与顺序

| 里程碑 | 内容 | 本轮 |
|---|---|---|
| M0a | 库侧：`exposes()` 补 `startedAt` + proxy `running` 按 binding + 多通道默认命名 | ✅ 实施（src/index.ts、src/expose.ts + test/exposes-meta.test.mjs） |
| M0b | daemon：expose 注册表 + `expose.list`/`expose.stop` RPC + 元数据持久化 | ✅ 实施（src/state.ts、src/daemon-server.ts + test/expose-registry.test.mjs） |
| M0c | UI API：`/api/status`（静态）+ `/api/live`（动态）+ `/api/expose` 参数扩展 + Host 白名单 | ✅ 实施（src/ui.ts + test/validation.test.mjs 更新） |
| M1 | SPA 壳 + Ports 页签（候选列表/展开/直连/暴露表单/已开暴露） | ✅ 实施（src/ui.ts 重写 + 表单防重置修复） |
| M0b-ssh | ssh provider site 化 + 任意协议（库侧语义变更，独立任务） | ✅ 实施（src/ssh/manager.ts `ensure` + expose.ts `provider=ssh` 拦截 + index.ts 内嵌 SshManager/st.ssh + daemon 自动建域 + UI 表单 ssh 选项 + test/ssh-provider.test.mjs） |
| M2 | Exposes 详情 + 日志 + Users（矩阵 + TOTP 模态 + **ssh 公钥管理**）+ Tokens 模态化 | ✅ 实施（详情模态含日志尾部 + 日志文件列表 View；site 详情四块视图；Tokens 创建一次性展示） |
| M3 | Sites（详情分块 Users/SSH keys/Tokens）+ Config tab + i18n 补齐 | ✅ 实施（Sites 详情三块 tabs；Config 只读 JSON + 目录；i18n 补齐） |

## 任务分解

### M0a — 库侧 exposes 元数据（src/index.ts, src/expose.ts）

- T1. exposes Map 记录 `startedAt: Date.now()`（expose 成功时）。
- T2. `exposes()` 输出补 `startedAt`。
- T3. `exposes()` 的 proxy 模式 `running`：`localUrl` 为空（startTransport:false 宿主）时
  改按 `proxy.bindings()` 命中判定（修 pi-web 宿主补丁问题）。
- T4. 多通道默认命名：`expose.ts` 默认名 `expose-<port>` 带 provider/site 后缀
  （site ≠ default 或 provider 显式时追加 `-<site>`/`-<provider>`；tcp 保留 `-tcp`）。
- 验收：`npm test` 绿；新增 `test/exposes-meta.test.mjs`（proxy 模式 running、startedAt）。

### M0b — daemon expose 注册表（src/daemon-server.ts）

- T5. daemon 内存 `exposeRegistry: Map<name, ExposeRecord>`（name/port/mode/provider/
  protocol/site/urls/label/startedAt/tunnelName）；expose handler 成功后写入。
- T6. `expose.list` RPC：注册表全量 + running（proxy 按 binding 命中）+ 掩码 params
  （从 tunnels.configs 匹配 name，token 类只留末 4 位）。
- T7. `expose.stop` RPC：tunnel 模式 `tunnels.stop(name)`；proxy 模式（name 以
  `proxy:` 开头）→ `proxy.removeBinding(port,label)` + 注册表删除 + host 注销。
- T8. 注册表持久化 state.json（`exposes` 块；重启 hydrate），`expose.list` 合并
  持久化与运行态。
- 验收：curl 冒烟 `expose → list → stop`（tunnel/proxy 两模式）。

### M0c — UI API（src/ui.ts 路由层）

- T9. `GET /api/status`（静态）：providers/providerOrder/defaultProvider/tunnelSchemas/
  tunnelMetas/authProviderSchemas/authMetas/tunnelTcpSupport/userManagers/totpProviders/
  sites/tools/allowAuthNone/daemon status/运行模式。
- T10. `GET /api/live`（动态）：ports（daemon port.list 优先，降级进程内+internal 过滤）/
  internal/tunnels/exposes（daemon expose.list）/proxy status。
- T11. `POST /api/expose` 参数扩展：mode/provider/policy/protocol/tunnelParams/
  providerParams/user/ngrokAuthtoken/allowAuthNone/site 透传 daemon。
- T12. `POST /api/expose-stop` / `expose-stop-all` → daemon `expose.stop`/`tunnel.stopAll`
  + bindings 清理。
- T13. Host 白名单：POST 校验 Host ∈ 127.0.0.1/localhost/::1（带端口）。
- 验收：`npm test` 新增 `test/ui-api.test.mjs`（Host 校验/expose 参数透传）。

### M1 — SPA 壳 + Ports 页签（src/ui.ts 重写）

- T14. SPA 壳：tabbar（Ports/Exposes/Users/Tokens/Sites/Tools）+ hash 路由 +
  10s `/api/live` 轮询 + 静态 `/api/status` 加载 + CSRF meta + 中英 UI_MSG。
- T15. Ports 页签：候选端口列表（daemon 排除内部端口）→ 行展开：直连 URL /
  已开暴露（URL 组+状态+停止）/ 暴露表单（schema 驱动：mode/provider/site/policy/
  protocol/tunnelParams/providerParams，auth-none 泄露确认）。
- T16. 暴露动作：POST /api/expose → 成功弹 URL（打开/复制）→ 刷新 live。
- 验收：chrome-devtools 打开 `sts ui` → 起测试服务 → 列端口 → proxy 暴露 →
  虚拟主机 URL → 停止。

## 测试策略

1. **单测**：`node --test test/*.test.mjs`（新增 exposes-meta / ui-api 两个测试文件）。
2. **构建**：`npm run build`（tsc + dts 修复）干净。
3. **浏览器验证（chrome-devtools MCP）**：
   - 起一个测试 HTTP 服务（任意端口）+ `node dist/cli.js ui --no-browser --port <空闲>`
   - chrome_devtools 打开 `http://127.0.0.1:<uiPort>` → 截图/snapshot 验证 Ports 列表
   - 展开端口 → 填表单 proxy 暴露 → 验证虚拟主机 URL 出现 → 停止 → 列表移除
   - console 无错误；network 观察 `/api/status`+`/api/live` 轮询。

## 实施中发现并修复的真实 bug（本轮）

1. **detectProtocol 泄漏**（src/gateway.ts）：HTTP(S) 探测用默认 keep-alive agent，探测 socket
   滞留 → 每次 expose 泄漏一个 socket 并挂住事件循环（`node --test` 不退出、长驻进程 FD 泄漏）。
   改原生 net/tls 探测（每条 socket 显式 destroy）。
2. **ssh 网关密钥热重载 fire-and-forget**（src/ssh/manager.ts `#refreshGatewayKeys`）：
   addKey/generateKey/removeKey 后 `void gateway.close().then(重启)` 不等待——重启链与 shutdown/
   rmSync 竞态：目录已删后 loadHostKeys 同步抛错变成 unhandledRejection，重启的 `gw.start`
   绑定新 socket 挂住事件循环。改 await + `d.gateway !== old` 守卫（stop 后不复活监听器），
   keys.* 变 async。

## 浏览器验证（chrome-devtools，已完成）

- 起测试服务 `node /tmp/st-ui-test/app.mjs 5173` + `node dist/cli.js ui --port 4190`（embedded 模式）。
- chrome-devtools 打开 `http://127.0.0.1:4190/`：tabbar/端口列表（5173 在列）/直连 URL/暴露表单全部渲染正确。
- 表单 mode=proxy+auth=none → POST /api/expose → `proxy:5173:` 记录 + binding 注册 + localUrl
  `http://5173.st.localhost:4180`；浏览器打开该 vhost URL → 真实返回测试服务内容。
- 停止按钮（确认窗）→ binding 移除 + 记录删除（bindings=0）。
- console 零错误；网络流 = 静态 /api/status 一次 + /api/live 10s 轮询 + POST 全 200。
- 发现并修复两个真实问题：① 嵌入模式端口发现用错函数（进程树→当前用户监听，对齐 daemon port.list）；
  ② 10s 轮询重渲染清空用户表单输入（userEditing 守卫）。
- **ssh provider 验证（M0b-ssh）**：表单 provider 下拉含 ssh → 选中后协议选择器隐藏（强制 tcp）、
  提示「公钥随 site，任意协议经端口转发」→ 暴露 → `expose-5173-ssh-tcp`（provider=ssh,
  protocol=tcp）+ ssh 域 `default` 自动供给（端口自动分配）→ ssh 网关返回 SSH banner
  （ssh2js）→ Users 矩阵 ssh 列公钥数 + 上传/生成/撤销。
- 最终：`npm test` 181 tests / 180 pass / 0 fail；`npm run build` 干净。

## 待办任务

### TODO-1：暴露原子化 + 失败即彻底清理（fail-clean / stop-clean）

**原则**（替代原「拆双运行状态」方案）：暴露是**原子操作**——要成全成，要败全败。
任一组分失败 → 回滚清理本次已起的全部组件，不留半残留；下次用时按需重启（代价小）。
成功后 `running=true` 天然正确，不存在「网关活着但入口死了」的半状态。

**残留点清单**（现状审查确认，失败/停止路径均未清理）：

| 组件 | 残留场景 | 现状 |
|---|---|---|
| ssh 域（`SshManager`） | provider=ssh 暴露的隧道失败 / `expose.stop` | 域继续 listening（本机可连），不清理 |
| nginx gateway（per-expose） | **daemon 模式每次 expose 建独立 nginx**（expose ctx 未传共享单例 → `ctx.gateway ?? new GatewayController`）；隧道失败或停止 | `tunnelFailure` 只返回错误不停 nginx；`expose.stop` 不停 → 进程累积 |
| provider 实例（portal/authelia 等） | 隧道失败（`provider.start()` 已起） | 残留运行 |
| redis（共享单例） | authelia 全部暴露停止后 | 空转不回收 |
| proxy transport（4180） | 最后一条 binding 移除后 | 空转不回收 |
| 隧道进程组 | 隧道启动失败（如 ngrok 8013） | 可能留子进程/管道句柄 |

**实现要点**：
- **nginx gateway / redis 是共享单例 → 不清**（进程生命周期内常驻，与其他暴露共存；重新起 nginx
  比保留代价大）。清理只针对 per-expose 组件：隧道进程 → ssh 域 → provider 实例。
- `src/daemon-server.ts`：**补共享 nginx gateway 单例**（daemon 进程内建一个 GatewayController
  传给 exposeFlow ctx.gateway，消除 per-expose nginx 累积的根因）；redis 同理接共享单例。
- `src/expose.ts`：统一回滚——`exposeFlow` 失败路径（`tunnelFailure` 及各 return error 点）
  按逆序清理本次已起的 per-expose 组件：隧道进程 → ssh 域（sshEnsureDomain 建的，记入 ctx）→
  provider；共享单例不动。
- `src/index.ts` / `src/daemon-server.ts`：`st.tunnels.stop` 与 `expose.stop` 补完整清理
  （per-expose 的 ssh 域 + provider；nginx/redis 共享单例不清），proxy 模式补 transport 空转回收。
- 隧道启动失败时清理其进程组残留（`tunnels.stop(name)` 已在部分路径；失败路径统一调用）。
- **废弃原 TODO-1 双状态方案**（running + gatewayRunning 不再需要——无半状态可展示）。

**验收**：
1. provider=ssh + 隧道失败 → ssh 域被清理（`ssh.get(site).listening === false` / 域删除），
   provider 实例停止；**共享 nginx/redis 单例不清**；重新暴露可再次自动建域。
2. `expose.stop` 后该暴露关联的 ssh 域/provider 全部停止，nginx/redis 单例保持运行；
   连续起停多次无 per-expose nginx/provider 累积。
3. daemon 模式只存在一个共享 nginx（`pgrep nginx` 数量稳定），redis 同理。
4. `npm test` 全绿（含新增 fail-clean 断言）。

**状态**：✅ 已完成（2026-08；`src/expose.ts` 失败回滚（隧道+ssh 域+provider）+ daemon 共享 nginx/redis 单例 + `expose.stop`/`st.tunnels.stop` ssh 域清理；`test/fail-clean.test.mjs` 3 用例；ssh-provider 测试适配新语义）

### TODO-2：provider/tunnel 参数变体（Presets —— 「另存为常用」）

**需求**：暴露表单填好隧道/认证参数后，底部出现「另存为常用」→ 输入名字 → 存入**该
tunnel/provider 类型的命名变体**。后续下拉直接选用、自动带入参数；可编辑/删除。
密码/token 类字段**加密存储、不回显**，修改时输入新值覆盖，不输入则用已存值
（placeholder 提示「已保存，留空使用已存值」）。

**参照**：env 注册自定义 tunnel（`SERVICE_TUNNELS_TUNNEL_COMMAND_*`）与 oauth2 变体
（`SERVICE_TUNNELS_OAUTH2_VARIANT_*`）的「声明式定义 → 表单可选」机制；preset 是
运行时保存的**实例参数**（同一类型下的命名配置），与之同构。

| 项 | 内容 |
|---|---|
| 存储 | `ServiceTunnelsConfigFile` 加 `tunnelPresets` / `authPresets`（按类型分组的命名变体）；`writeConfigFile` 持久化（configDir/service-tunnels.json） |
| 加密 | 敏感字段（ParamSpec.type=password 或 key 匹配 token/secret/password/key）用 **AES-256-GCM** 加密存储；密钥首次生成存 cacheDir `presets.key`（0600）；密文格式 `enc:v1:<iv>:<tag>:<data>`；解密失败视为损坏跳过 |
| 库侧 API | `st.presets`：`list(kind, type)` / `save(kind, type, name, params)` / `remove(kind, type, name)` / `get(kind, type, name)`（get 返回解密后明文供应用，但 UI 回显永远只给掩码/空） |
| daemon RPC | `preset.list/save/remove`（配置档读写 + 加密同库侧；IPC 边界同现有 config 写入） |
| UI 表单 | 有参数输入时底部显示「另存为常用」；参数区上方/旁下拉列出该类型的已存 preset（`<name>` + 参数摘要）；选中 → 非敏感字段带入、敏感字段留空 + placeholder「已保存，留空使用已存值」；编辑模态：改名/参数/敏感新值覆盖/删除 |
| 暴露应用 | 提交时敏感字段为空 → 从该 preset 存储值合并进 `tunnelParams`/`providerParams`（daemon 侧或库侧完成合并）；未选 preset 且字段留空 → 不传（现状） |
| 测试 | `test/presets.test.mjs`：save/read 往返、敏感字段密文落盘（不含明文）、留空用已存值、覆盖新值、解密失败跳过、UI API 冒烟 |

**验收**：表单填 ngrok authtoken → 另存为「我的ngrok」→ 下拉选择带入（token 留空 + 提示）→
提交成功且隧道用的是已存 token；配置档里 token 是密文；编辑改名/覆盖/删除生效；`npm test` 全绿。

**状态**：✅ 已完成（2026-08；`src/presets.ts` AES-256-GCM 加密 + `st.presets` API + daemon `preset.*` RPC + UI 参数分组 preset 栏（下拉选用/另存为/删除/敏感留空合并）；`test/presets.test.mjs` 覆盖 save/list/get/remove/密文落盘/覆盖/空值/跨实例解密）

### TODO-3（调研）：后端接口暴露给调用者的服务（前端组件化降为次要）

**问题**：当前 `/api/*` 整套操作接口嵌在 `src/ui.ts`（独立 127.0.0.1 HTTP 服务）里。
外部调用者的服务（pi-web 等嵌入方）**怎么安全、低成本地拿到这些后端接口**，而不用
各自重写适配层（pi-web 现在自写了 400+ 行 route.ts 做 st.* → HTTP 映射）。

**目标（组件化愿景）**：组件化后，**pi-web 的自写适配层被库组件自然取代**——不做迁移、
不重写，挂载/引入即用：
- `app/api/service-tunnels/route.ts`（400+ 行 st.* → HTTP 映射）→ 库的 `createServiceApiHandler`
  直接挂载（TODO-3 方案①），接口语义对齐现有 /api/*；
- `proxy.ts`（Next middleware 调 `st.proxy.resolve`）→ 库侧补 Next middleware 适配器
  （`createNextProxyMiddleware`，纯薄壳），路由/安全决策仍是一份实现（库内）；
- `ServicesDialog.tsx`（React 弹窗，~2300 行）→ 库的 Web Component / 可挂载面板（TODO-3
  形态 A），宿主页面 `<script>` 引入即用，样式/交互/i18n 跟随库。

**现状基础**：`createHandler`（RequestListener）已是可挂载函数；JSON API 面已与渲染解耦；
库侧 `st.*` + daemon RPC（IPC secret）都是现成调用面。

**候选暴露方案（调研重点）**：

| 方案 | 机制 | 适用 | 代价 |
|---|---|---|---|
| ① 可挂载 API handler | 从 ui.ts 抽出 `createServiceApiHandler(st, opts)` → 返回 RequestListener / Express 中间件 / Next route 适配；调用者 `app.use('/service-tunnels', h)` 或 `http.createServer(h)` | Node 嵌入方（pi-web） | 抽离 + 认证/挂载前缀配置；免自写适配层 |
| ② 独立纯 API 服务 | `sts api --port <p> --bind <addr> --auth token|secret` 起无 SPA 的 API 服务；调用者 HTTP 调用 | 远程 / 跨语言（Go/Rust） | 部署多一个服务 |
| ③ 库方法直调 | `createServiceTunnels` 进程内 `st.*`（pi-web 现状） | Node 内嵌、无 HTTP 偏好 | 调用者自映射（现状） |
| ④ daemon RPC | 复用 IPC（socket/TCP + secret） | CLI 场景、跨语言 | 需 daemon 在跑 |

**调研要点**：
1. **认证/安全门禁可配置化**（重点）：现 CSRF+Origin+Host 白名单绑定 127.0.0.1，只服务本地面板。
   对外暴露需可选认证：`shared-secret`（自定义 header，env/配置注入）/ `token`（复用
   Bearer token provider）/ `custom`（调用者回调）/ `none`（仅本地面板）；Host/Origin 门禁
   改允许列表开关。
2. **API handler 挂载形态**：RequestListener → Express 中间件（`(req,res,next)`）→ Next.js
   route handler 适配；挂载路径前缀；纯 API 模式（不渲染 SPA）。
3. **UI 专属端点收敛**：`/api/logs?path=`（读文件）、`/api/config`（配置档明文）在对外模式下
   需权限收紧或改走 daemon RPC（`logs.tail` / `config.read` 由调用者自行暴露）。
4. **pi-web 对照**：评估三件适配层（route.ts / proxy.ts / ServicesDialog.tsx）被库组件
   自然替换的路径与缺口（上面「目标」节）；迁移成本 ≈ 删除适配层 + 挂载/引入，而非重写。
5. **契约**：API 响应类型（TS 类型导出）+ 语义文档（对齐现有 /api/* 响应），跨语言可用
   OpenAPI 生成（可选）。

**产出**：调研结论文档（`docs/ui-embed-research.md`）：暴露方案选型 + 认证/门禁配置面 +
API handler 接口签名 + Next/Express 挂载实测 + **pi-web 三件适配层的替换路径对照**
（删 route.ts → 挂 handler；删 proxy.ts 适配 → 用库 Next 适配器；删 ServicesDialog →
挂 Web Component）。

**状态**：🔍 调研中（未实施）

### TODO-4（调研）：框架无关性 —— 其他 Node 方案 / 其他语言是否适用

**问题**：pi-web 集成用的是 Next.js（前端 React + Next middleware/API route）。别人的疑问：
「我不和你用同样的框架，会不会有问题？」——其他 Node 框架（Express/Fastify/Hono/Koa）或
其他语言（Go/Rust/Python）的使用者，前端、后端分别能用多少？

**现状耦合度审计（初步结论：核心是框架无关的，Next 特定部分是 pi-web 的宿主适配层）**：
| 层 | 实现 | 框架依赖 |
|---|---|---|
| 库（`st.*` / `createServiceTunnels`） | 纯 Node 内置（node:http/net/crypto/fs），package.json 仅 justget | **零依赖，任何 Node 进程可用** |
| `src/ui.ts`（SPA + /api/*） | `http.createServer` + `RequestListener` | **无 Express/Next**，node:http 内置；前端 vanilla JS 无框架 |
| daemon IPC | JSON over unix socket/TCP + secret | **语言无关**（已有 `examples/ipc-client-go` 实测） |
| proxy 能力 | `st.proxy.create`（纯 Node http server）/ `resolve`（决策函数） | **框架无关**；pi-web 的 `proxy.ts`（Next middleware）只是其中一种接法 |
| pi-web 适配层（`proxy.ts`/`route.ts`/`ServicesDialog.tsx`） | Next middleware + API route + React 组件 | **Next/React 特定——但这是 pi-web 的资产，不是库的** |
| 非 Next 示例 | `examples/vite-plugin`、`examples/host-integration.ts` | 已有 Vite（前端）+ 通用宿主（后端）示例 |

**调研问题**：
1. **后端**：Express / Fastify / Hono / Koa 分别怎么接入？——进程内 `st.*`（任意框架挂路由）；
   或挂载 ui.ts 的 API handler（RequestListener 可直接 `app.use` / 各框架适配）；或独立 ui 服务
   + 反代（方案②，框架彻底无关）。每个框架写最小挂载示例验证。
2. **proxy/暴露决策**：非 Next 框架如何复用 `st.proxy.resolve`（决策 API 是纯函数，任何
   中间件/反代可调）——给出 Express/Hono 的 resolve 接线示例。
3. **跨语言**：Go/Rust/Python 走 HTTP API（token 认证）或 daemon RPC（IPC secret）——
   验证 `ipc-client-go` 之外加一个 HTTP 客户端示例（Python/Go）。
4. **前端**：库的 SPA 是 vanilla（可 iframe / Web Component 嵌入任何宿主页面）；React/Vue
   组件是否必要（TODO-3 已列为独立子包选项）；Vite 插件示例已覆盖非 Next 打包场景。
5. **结论边界**：明确「库本身框架无关」的保证范围（Node 版本要求、无原生依赖），哪些能力
   天然跨框架、哪些（如 pi-web 的 middleware 级 proxy）需要宿主自己接线。

**产出**：调研结论文档（`docs/framework-agnostic.md`）：框架×能力矩阵 + 各框架最小接入
示例（Express/Fastify/Hono 后端挂载 + Go/Python HTTP 调用 + Vite/原生前端嵌入）。

**状态**：🔍 调研中（未实施）

### TODO-5：迁移 pi-web self-expose 能力进库（SERVICE_TUNNELS_EXPOSE + allowlocal/allowHost）

**背景**：pi-web 的 `PI_WEB_EXPOSE` 机制（作者本人，逻辑可放心搬运）——把自己 expose、
`allowlocal`/`allowHost` 直连门控、`auth` 保护、用户可定制。库当前**没有**这些能力
（设计文档原列为非目标，现撤销）。

**迁移内容（pi-web → 库）**：
| 项 | pi-web 现状 | 库侧落地 |
|---|---|---|
| env 解析 | `parseExposeEnv`（k=v,k2=v2，dotted 嵌套：`tunnel.*`/`provider.*`/`user.*`/`allowHost` 可重复；未知键警告；非法 mode fail-closed） | `SERVICE_TUNNELS_EXPOSE` 同款解析（src/expose-self.ts） |
| 自我暴露 | `exposeSelf`：site=独立认证域（pi-web 用 "pi-web"，库默认 "self"）+ label + `startTransport:false` + serviceBasePath | `st.exposeSelf(opts)`：`mode/auth/tunnel/policy/protocol/user/ngrokAuthtoken/allowlocal` 与 expose 同构 |
| allowlocal 门控 | middleware 拦截：allowlocal=false 时非 allowHost 的直连（**含回环**）403；两阶段关闭（临时 TTL + 30s 二次确认永久，防锁死）；部署域不自动例外 | 库的 **proxy resolve 决策层**加门控分支（resolve 已处理 deny/401/redirect/pipe）；`setAllowLocalTemporary/confirmAllowLocal/getAllowLocalHosts` 等价状态 API |
| self-forward 放行 | 30s 随机 token：网关认证后的转发（vhost→自身）带 token 重入 middleware 放行 | resolve 里校验 forward token（库内生成/校验，替代 header 重写限制） |
| 状态/URL 展示 | `getSelfExposeState`/`getSelfAccessUrls`（回环/LAN/vhost/隧道/allowHost 地址列表 + gated 标记） | UI 加 self 状态（地址列表、allowlocal 开关+两阶段确认、env 片段生成） |

**库侧适配点**（pi-web middleware 模型 → 库的 proxy resolve 模型）：
- 门控从「每请求 middleware」移到 `st.proxy.resolve()`（决策函数唯一实现，自管 transport 与嵌入方共用）；
- 库的 proxy transport 已自带 resolve 流程，门控天然生效；嵌入方（如 pi-web 中间件）调 resolve 同样生效；
- 默认 site：`self`（配置可覆盖，对齐设计 §4.9 site 隔离默认值）；
- 安全：allowlocal=false 时回环也拒绝（对齐 pi-web 修过的 bug），仅 allowHost 白名单 + forward token 放行。

**启动钩子**：库提供 `maybeExposeSelf()`（解析 env → 应用 allowlocal/allowHost 配置；mode 非 none 时
调用 exposeSelf）；CLI/宿主自行调用（库不自动暴露自己）。UI 侧 service-tunnels.json 可持久化
运行时 allowlocal 覆盖（重启回 env）。

**验收**：`SERVICE_TUNNELS_EXPOSE="mode=proxy,auth=portal,allowlocal=false,allowHost=backup.example.com"`
启动 → self 暴露 + 直连被门控（回环/LAN 403，allowHost 放行，vhost/隧道经认证放行）；UI 显示
地址列表 + allowlocal 两阶段开关 + env 片段；`npm test` 全绿（新增 test/expose-self.test.mjs）。

**状态**：✅ 库侧已完成（2026-08；`src/expose-self.ts`：`parseExposeEnv`（k=v/dotted/allowHost 重复/非法 mode fail-closed）+ allowlocal 门控（TTL 临时/永久确认/allowHost 白名单/`isDirectAccessAllowed`）+ `st.self.exposeSelf`（site `self`/label `self`/serviceBasePath）+ `maybeExposeSelf` 启动钩子；`test/expose-self.test.mjs` 3 用例）。⏳ 待办：UI self 状态展示（地址列表/allowlocal 开关/env 片段生成）

### TODO-7：暴露表单选项 × protocol 联动（tcp 时只 tunnel mode）

**问题**：表单的 mode / tunnel / auth 选项不随 protocol 变化——tcp 时仍可选 proxy/both
（虚拟主机是 HTTP 语义，tcp 走虚拟主机代理无意义/冲突）、tunnel 类型列出全部（tcp 只
支持 tcpSupport 的子集）、auth 列出 HTTP provider（tcp 下被库忽略）。

**联动规则**：
| 字段 | http/https/auto | tcp |
|---|---|---|
| mode | tunnel / proxy / both 全可选 | **只 tunnel**（proxy/both 禁用或隐藏） |
| tunnel | 全部（dangerous 除外） | 只列 `tunnelTcpSupport`（ngrok/ssh/frpc/bore…） |
| auth | 全部（含 ssh——任意协议） | 只 none / ssh（HTTP provider 隐藏） |

**实现**（`src/ui/client/ports.js`）：
- protocol select change → 联动刷新 mode/tunnel/auth 下拉（保留已选值若仍合法，否则切默认）；
- tcp：mode 选项禁用 proxy/both（或隐藏 + 若当前是 proxy/both 切回 tunnel）；
  tunnel 下拉重建为 tcpSupport 子集；auth 重建为 none/ssh；
- 与现有 detect（auto → 实际协议）+ ssh 隐藏 protocol 的联动共存（检测后按实际协议应用规则）；
- doExpose 校验保持（tcp 时 tunnel 必须 tcp 支持，现状已有）。

**验收**：选 tcp → mode 只剩 tunnel、tunnel 只列 tcp 类型、auth 只剩 none/ssh；
切回 http → 全部恢复；`npm test` + 浏览器实测。

**状态**：⏳ 待办（未实施）

## TODO-6：UI 模块化拆分（src/ui.ts 单文件 → 多模块）✅ 已完成

**问题**：`src/ui.ts` 曾 ~1900 行——前端 JS 全内联在 SHELL 模板字符串里（无法 import、`\\'` 转义地狱）、后端路由耦合。

**拆分结果**：
```
src/ui.ts            # startUi + createHandler（CSRF 门禁 + 静态 client + API 分发 + SPA shell）
src/ui-helpers.ts    # 后端公共函数（daemonOrLocal/findExpose/maskParams/sshDomainFor/CSRF 工具）
src/ui-api.ts        # createApiHandler —— 全部 /api/* 端点（428 行，从 createHandler 提取）
src/ui/client/       # 前端 9 个独立 JS 文件（浏览器原生 <script>，零 bundler）
  core.js            # state/api/tr/modal/轮询/header/tabs
  ports.js           # Ports 页签 + 暴露表单 + detect + presets 栏（353 行）
  exposes.js users.js tokens.js sites.js tools.js config.js main.js
```

**要点**：
- SHELL 只留 HTML+CSS + 小内联 `window.UI_MSG/UI_CSRF` 注入 + `<script src="/ui/*.js">` 引用；
  服务端 `GET /ui/*.js` 从 `src/ui/client` serve（src/dist 部署同一份，`Cache-Control: no-store`）。
- **转义问题根除**：模板字符串里的 `\\'` 在纯 JS 文件降级为 `\'`（批量处理 9 文件）。
- 拆分中修的两个坑：`main.js` 截断丢 `refreshAll()`；`core.js` 残留模板注入 `lang:'${lang}'`。

**验证**：`npm test` 188/187/1 全绿（validation/ssh-ui 测试适配 SHELL 变化）；浏览器实测
tabs/status/端口列表/暴露表单（detect/mode 默认/auth 默认/preset 栏）全部正常。

## 风险与延期

- **ssh provider 公网隧道语义**（TODO-1 原子化落地前保持现状）：provider=ssh 暴露时若公网 tcp
  隧道失败（如 ngrok 免费版需付费），`running=false` 但本地 ssh 网关仍可用——待 TODO-1
  实施后改为「失败即回滚清理」，不再存在该半状态。
- **命名后缀改动**可能影响既有 CLI 用法/测试——T4 只在 site/provider 显式时追加，
  默认 `expose-<port>` 不变。
- **expose 注册表持久化**与 daemon 既有 hydrate 并存：tunnel 进程恢复走既有
  tunnels hydrate；注册表只恢复展示元数据。
- **M2/M3 完成状态**：全部里程碑 M0a–M3 实施完毕（SPA 七页签：Ports/Exposes/Users/
  Tokens/Sites/Tools/Config）；daemon 模式日志路径（findExposeLogs 扫描 nginx-* 目录）
  随 ssh-ui 测试覆盖；浏览器验证见上节。
