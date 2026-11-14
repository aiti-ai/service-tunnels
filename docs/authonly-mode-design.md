# 仅认证模式（auth-only / authonly）设计方案

## 1. 目标

给 service-tunnels CLI 增加一个**仅认证模式**，用来在**系统 nginx** 里替换
Authelia：外部 nginx 用 `auth_request` 探针接入，登录页/2FA/登出由本服务提供。

与现有隧道 forward-auth 的关键区别：

| | 隧道网关路径（现有） | 仅认证模式（新增） |
|---|---|---|
| nginx 归属 | service-tunnels 自建 GatewayController | **用户自己的系统 nginx** |
| 触发方式 | tunnel 边缘 → 自建 nginx | nginx `auth_request` 指令 |
| 管理界面 | 与认证一体 | **认证服务不暴露管理界面** |
| 生命周期 | 随 expose | 独立长期进程（可配 systemd） |

设计原则：**认证与配置分离**。调整用户/site 用独立的 Web 管理界面（前台命令），
认证服务本身只跑 forward-auth 端点 + 登录页，无任何管理入口（更安全）。

## 2. 工作流

```
① st authsetup                    # 一次性：定 admin 端口/auth 端口/basePath/site(存储位置)
   └─ 生成 auth-admin-<base>.sh    #   Web 管理界面启动脚本（调试 user/site）
   └─ 生成 auth-server-<base>.sh   #   认证服务启动脚本（可配 systemd）
   └─ 生成 nginx-auth-<base>.conf  #   nginx auth_request 接入示例碎片

② ./auth-admin-<base>.sh          # 启动 Web 管理界面 → 调整用户 / site

③ ./auth-server-<base>.sh         # 启动仅认证服务（无管理界面；生产运行）
   # 或：配成 systemd service

④ 需要再调整 → 停 ③，跑 ② 调整，再启 ③
```

## 3. 复用现有能力（零重写）

`portal` provider（`src/providers/portal.ts`）已经是自包含的 forward-auth 服务：

```
GET  {basePath}/api/authz/auth-request   nginx auth_request 探针（200/401/403）
GET  {basePath}/login                   登录页（RSA-OAEP 密码传输）
POST {basePath}/login                   凭证校验 → HMAC 签名会话 cookie
GET  {basePath}/login/2fa               2FA 步骤页（TOTP/人脸/语音）
GET  {basePath}/logout                  登出
```

仅认证模式 = 把这个 provider **单独拉起来**（固定端口 + 固定 basePath + 独立
site 存储），不建 nginx 网关、不开隧道、不起 UI。用户库与 UI 管理共享同一文件
（见 §6），所以「UI 建号 → 认证服务直接用」天然成立。

## 4. 命令设计

### 4.1 `st authsetup` — 设置 + 生成脚本

```
st authsetup [--admin-port <p>] [--auth-port <p>] [--base-path <p>] [--site <s>]
             [--listen <ip>] [--policy one_factor|two_factor|deny]
             [--out <dir>] [--bin-dir <dir>] [--config-dir <d>] [--cache-dir <d>]
```

行为：
- 未给 `--base-path` → 随机生成（如 `/nhgf`，小写字母/数字，斜杠前缀）。
- 未给 `--site` → 随机生成（如 `rfgu`，即「存储位置」）。
- 未给端口 → 探测空闲端口：admin 默认 4181 被占则随机；auth 端口随机。
- 把 site 写入 `sites.json`（provider=portal、basePath），这样管理界面能
  列出该 site 并在其下管理用户。
- 写配置 `configDir/auth/<base>.json`（记 adminPort/authPort/basePath/site/
  listen/policy/storageDir）。
- 生成产物分两处（脚本进 PATH、配置按 XDG 惯例）：
  - **可执行脚本** → `--bin-dir <dir>`（默认 `~/.local/bin`，Linux 用户级
    可执行文件标准位置，已在 PATH；Windows 默认用户 PATH 目录）——
    `auth-admin-<base>.sh/.bat`、`auth-server-<base>.sh/.bat` 直接可敲。
  - **非可执行产物** → `--out <dir>`（默认 `configDir/auth/`）：
    nginx 碎片、systemd unit、配置 JSON（XDG config 惯例）。

| 文件（路径） | 用途 |
|---|---|
| `~/.local/bin/auth-admin-<base>.sh` / `.bat` | 启动 Web 管理界面（`st ui --port <adminPort>`）——脚本进 PATH，直接敲名字 |
| `~/.local/bin/auth-server-<base>.sh` / `.bat` | 启动仅认证服务（`st authonly start ...`）前台——脚本进 PATH |
| `configDir/auth/nginx-auth-<base>.conf` | nginx `auth_request` 接入示例（端口/basePath 已填好） |
| `configDir/auth/auth-server-<base>.service` | systemd unit 模板（可选，`--with-systemd`） |

`<base>` = basePath 去斜杠（如 `nhgf`），脚本名带 basePath → **多配置天然隔离**。
脚本以 `st` 相对调用（解析 PATH 里的 `st`），并把 `--config-dir/--cache-dir`
绝对路径写死进去，确保从任意 cwd 运行都指向同一配置实例。

脚本内容（示例，`nhgf`）：

```bash
# auth-admin-nhgf.sh
#!/usr/bin/env bash
exec st ui --port 4181 --config-dir "$ST_CONFIG_DIR" --cache-dir "$ST_CACHE_DIR"
```
```bash
# auth-server-nhgf.sh
#!/usr/bin/env bash
exec st authonly start --port 45321 --base-path /nhgf --site rfgu \
     --listen 127.0.0.1 --policy one_factor \
     --config-dir "$ST_CONFIG_DIR" --cache-dir "$ST_CACHE_DIR"
```
Windows `.bat` 同义（`@echo off` + `st ui --port ...` / `st authonly start ...`）。

### 4.2 `st authonly` — 仅认证服务（生产进程）

```
st authonly start [--port <p>] [--base-path <p>] [--site <s>]
                  [--listen <ip>] [--policy ...] [--foreground]
                  [--config-dir <d>] [--cache-dir <d>]
st authonly stop | status [--site <s>] [--config-dir <d>] [--cache-dir <d>]
```

- `start`：读配置（`configDir/auth/<base>.json`，CLI 参数优先）→ 创建 portal
  provider（固定 port + basePath + site + storageDir）→ `start()` → **前台常驻**
  （写 `cacheDir/tmp/authonly-<site>.pid`）。注册 SIGINT/SIGTERM → `stop()` 退出。
  - 固定端口校验：启动前检查端口空闲，被占则明确报错（绝不静默换端口，否则
    nginx 配置失配）。
- `stop`：读 pid 文件 → SIGTERM 主进程（主进程信号处理器调 provider.stop()）。
- `status`：pid 存活 + 端口探针（`{basePath}/api/authz/auth-request` 401）→ 报告。

`start` 前台常驻 = systemd `ExecStart=<脚本>` 直接可用。

### 4.3 管理界面 = 现有 `st ui`

不新写。`auth-admin-*.sh` 就是 `st ui --port <adminPort>`。UI 本身绑定 127.0.0.1、
CSRF、Host 白名单（已有安全模型）。管理员在 UI 里选 site=rfgu 添加/修改用户。

## 5. 多配置隔离

- 每个 basePath 一个配置 `configDir/auth/<base>.json` + 一组脚本。
- site 不同 → 用户库不同目录（§6），互不可见。
- 端口各自分配，nginx 碎片各自引用。

## 6. 存储布局（用户库共享）

- portal 非 default site 的存储目录（`auth-registry.ts` `#siteOpts`）：
  `cacheDir/tmp/sites/<site>/portal/`（users.json / templates.json /
  hosts-policy.json / server.mjs）。
- **管理界面** `st.auth.addUser(user, pw, {site})` → `userManager("portal", site)`
  → 写 `cacheDir/tmp/sites/<site>/portal/users.json`。
- **认证服务** portal provider 用同一 `site` + 同一 `storageDir` → 读同一文件。
- 结论：`authsetup` 生成的 site（rfgu）同时被 UI 和 authonly 使用，用户管理
  与认证判定天然共享，无需任何同步。

## 7. nginx 接入示例（`nginx-auth-<base>.conf` 内容）

```nginx
# ── service-tunnels 仅认证模式：替换 authelia 的接入碎片 ──
# auth 服务: 127.0.0.1:45321   basePath: /nhgf
# 放入目标 server{} 块（受保护应用）。可选 rewrite 到你自己的 401 页。

# 1) auth_request 探针（internal 子请求）
location = /nhgf/api/authz/auth-request {
    internal;
    proxy_pass http://127.0.0.1:45321/nhgf/api/authz/auth-request;
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie;              # 会话判定必须带 Cookie
    proxy_set_header X-Original-URL https://$host$request_uri;
    proxy_set_header X-Original-Method $request_method;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
}

# 2) 登录页 / 2FA / 登出（直达，不走探针）
location /nhgf {
    proxy_pass http://127.0.0.1:45321/nhgf;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}

# 3) 受保护应用
location / {
    auth_request /nhgf/api/authz/auth-request;
    error_page 401 = @st_auth_login;
    proxy_pass http://127.0.0.1:8080;      # ← 你的应用
    ...
}

location @st_auth_login {
    internal;
    return 302 https://$host/nhgf/login?next=$request_uri;
}
```

## 8. systemd 示例（`auth-server-<base>.service`）

```ini
[Unit]
Description=service-tunnels auth-only (base=nhgf, site=rfgu)
After=network.target

[Service]
Type=simple
ExecStart=/path/to/auth-server-nhgf.sh
Restart=on-failure
# 若不想走脚本，可直写 ExecStart=/usr/bin/env node /path/dist/cli.js authonly start ...

[Install]
WantedBy=multi-user.target
```

## 9. 代码改动点

1. **`src/index.ts`**：`ServiceTunnels.auth` 新增
   `server: { start(opts), stop(site?), status(site?) }`——封装
   `authRegistry.create("portal", {port, basePath, site, storageDir, policy, ...}, site)`
   + `prepare/start/stop/status`；给 CLI 复用（也是库可编程入口）。
2. **`src/cli.ts`**：新增 `authsetup`、`authonly` 两个命令分支；parseArgs 增加
   `--admin-port/--auth-port/--listen/--out/--with-systemd`；usage 文案。
3. **`src/auth-setup.ts`（新）**：随机 basePath/site 生成、端口探测、脚本/bat/
   nginx/systemd 渲染、配置读写。
4. **`src/providers/portal.ts`**（小改，可选 P1）：支持 `secretFile` 选项——把
   HMAC 会话密钥持久化到 storageDir（否则 systemd 每次重启全体会话失效）。
   authonly 默认开启。
5. **`src/gateway.ts`**：无需改（碎片是渲染文本，非运行时 nginx）。

## 10. 测试计划（先自己开测试 nginx，不碰系统 nginx）

1. `npm run build`；`st authsetup --base-path /nhgf --site rfgu ...` → 生成脚本。
2. 启动管理界面，创建用户（或用 `st auth user add --site rfgu`）。
3. 启动 `authonly start`（固定端口）→ 探针 `curl .../nhgf/api/authz/auth-request`
   期望 401。
4. 起一个测试应用（随机端口）。
5. 起一个**独立测试 nginx**（复用 `/usr/sbin/nginx`，用生成碎片 + 测试应用，
   绑定随机端口，独立 pid/error_log，不动系统 nginx 配置）。
6. 验证链路：未登录访问测试域名 → 302 到登录页 → 登录 → 拿到 cookie → 再访问
   → 200；`auth_request` 探针放行。
7. `authonly stop` → 进程清理；重启后会话（P1 secret 持久化）保持。

## 11. 安全考虑

- 认证服务绑定 `--listen`（默认 127.0.0.1），外部 nginx 同机即可接入，不暴露
  公网；如需跨机访问，明确传 listen 并自行防火墙。
- 认证进程**无任何管理端点**（只 forward-auth + 登录页）；管理界面是独立前台
  进程，用完即关。
- basePath 随机（如 `/nhgf`）——路径不可枚举；site 随机（存储位置不可枚举）。
- 脚本 0700、配置 0600（沿用 hardenDir / writeConfigFile 约定）。

## 12. 发布清洗注意（内部开发约定）

- 脚本/文档中不写死内部端口/域名；auth 端口随机分配，示例用占位。
- 不引入内部应用名（pi-web → embedder）。
- 新增文件走常规 `npm run build`（tsc + dts 修复）+ 测试。
