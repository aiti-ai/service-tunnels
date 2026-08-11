# 预览隧道 —— GitHub Actions 参考实现（L1/L3）

PR/演示环境的公网预览：起 dev server → 暴露 → 机器访问 Bearer token。

## 工作流（.github/workflows/preview-tunnel.yml）

```yaml
name: preview-tunnel
on:
  pull_request:
  workflow_dispatch:
jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm i -g service-tunnels     # 安装 sts CLI（公共 npm 发布后）
      - run: bash examples/ci-github-actions/preview-tunnel.sh
        env:
          PORT: 5173
          TUNNEL: cloudflared              # 零账号；natapp 适合 CN runner
          AUTH: auto                       # Linux→authelia；也可 basic/token
```

## 脚本行为（preview-tunnel.sh）

1. 后台起 `npm run dev`；
2. `sts expose <port> --json`（自动拉起 daemon）→ 打印公网 URL + 登录页；
3. `sts auth token create --expires +1h` → 机器访问 token（Bearer header，
   无登录页无 Cookie）；
4. `curl -H "Authorization: Bearer <token>" <url>/` 验证认证直通；
5. 脚本退出时 `sts stop-all` 回收全部子进程（trap）。

## 安全

- 认证默认开（`--auth auto`），公网 URL 不裸奔；机器访问用一次性 token；
- 预览 URL 是随机的（cloudflared trycloudflare），生命周期 = job 生命周期；
- 若应用有 `/health` 等公开端点：`sts expose … --bypass-path /health` 放行。
