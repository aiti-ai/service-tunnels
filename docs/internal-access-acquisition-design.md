# 内部 token 获取与变更通知机制 — 设计草案（待确认）

> 状态：**草案，待确认**。回应"AI 测多数要自己创建进程，需要获取和变更通知机制"。
> 关键洞察：开了 `autoWireProcessProbe`（Linux/macOS）后，AI 自创建的任意深度
> 子进程（继承 marker env）**自动放行，根本不需要 token**——本机制只在
> **不开探针 / Windows**（探针不支持）时才需要。

## 1. 问题

当前 token 方案（`st.internalTokens.envForChild()`）的限制：
1. **env 注入只对直接子进程生效**：宿主 spawn bash 时注入 `$ST_INTERNAL_TOKEN`，
   bash 能用；但 AI 在 bash 里再 spawn 的进程（curl、脚本子进程等孙进程），若 bash
   没显式传 env，孙进程拿不到 `$ST_INTERNAL_TOKEN`。
2. **env 是启动快照、不随 rotate 更新**：token 轮换后，已运行 bash 的 env 里仍是
   老 token（overlap 窗口内仍有效，但 TTL 到期后失效，bash 不会自动刷新）。

→ AI 自创建进程的场景（AI 用 bash 工具 spawn 各种进程），env 注入不够。

## 2. 两条路径

### 路径 A（推荐，已实现）：开 autoWireProcessProbe，免 token
`createServiceTunnels({ autoWireProcessProbe: true })`：
- Linux：AI 的 bash、bash 里的 curl、孙进程……只要继承了 `SERVICE_TUNNELS_MARKER`
  env（spawn 时传 `...process.env` 即继承），探针命中 → 自动放行，**完全不用 token**。
- macOS：同（lsof+ps 实验性，受 SIP 限制可能不稳）。
- Windows：探针不支持 → 退化，需路径 B。

**优点**：零配置（开关一开）、任意进程深度、免 token、无通知问题（探针实时反查）。
**限制**：仅 Linux/macOS；macOS 受 SIP 限制可能不稳。

### 路径 B（补充，待确认是否要做）：token 获取端点 + pull 刷新
为 **Windows / 不开探针** 的场景，提供一个本地端点让任意进程查当前 token：

- **端点形态**：
  - Linux/macOS：本地 **unix socket**（如 `~/.cache/service-tunnels/internal-token.sock`，文件权限 0600，只有 owner 进程能连）
  - Windows：**named pipe** 或 TCP 127.0.0.1 专用端口（只听回环）
- **协议**：`GET /token` → `{ token, expiresAt, rotatesAt }`（rotatesAt = 下次轮换时刻）
- **用法**（AI 的 bash）：
  ```bash
  T=$(curl -s --unix-socket ~/.cache/service-tunnels/internal-token.sock http://localhost/token | jq -r .token)
  curl -H "Authorization: Bearer $T" http://app/
  ```
- **刷新（pull 模式，无需 push 通知）**：客户端缓存 token，到 `rotatesAt` 前主动
  重新查。overlap 窗口保证即使略晚刷新，老 token 仍有效。简单、无状态、可靠。

**安全**：unix socket + 0600 文件权限 = 只 owner 进程能连（本机同用户进程）。
Windows named pipe 同理（ACL 限同用户）。不额外校验 marker（端点已靠文件权限隔离）。

**备选（push 通知）**：`st.internalTokens.onRotate((prev, next) => ...)` 回调，
宿主收到后 IPC 推送 AI。更复杂、有状态，**不推荐**——pull 够用。

## 3. 推荐与决策点

**推荐**：路径 A 为主（已实现，开关默认关、按需开）。路径 B 仅当你的部署含
Windows、或不想开探针时才做——是较大改动（新端点 + 跨平台 IPC）。

**待你确认**：
1. 你的部署环境是否含 Windows？（决定路径 B 的优先级）
2. AI agent 的进程模型：在 service-tunnels 宿主**同进程**内运行（pi 的 agent
   loop 在宿主进程，工具调用 spawn 子进程）？还是独立进程？
   - 若同进程：AI 可直接调 `st.internalTokens.currentToken()` 拿 token 拼命令，
     路径 B 的端点可简化甚至不需要。
3. 是否需要路径 B（token 获取端点）？还是 autoWire 探针已够用？
4. 若做路径 B：unix socket（Linux/macOS）+ named pipe（Windows）可接受？
   还是统一用 TCP 127.0.0.1 端口？

## 4. 与已实现部分的关系

- `autoWireProcessProbe` 开关已加（默认 false），路径 A 现在就能用。
- `st.internalTokens`（currentToken/envForChild/verify/rotate/status/stop）已实现，
  路径 B 会在此基础上加 `st.internalTokens.serveEndpoint(opts?)`（起端点）+ onRotate 回调。
- 落地路径 B 不影响已实现部分（增量）。
