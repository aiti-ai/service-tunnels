## 0.2.39

### 认证域/部署集成修正（pi-web 实战反馈）
- **default 站用户库统一**：`expose --auth <provider>`（无 `--site`）不再隐含新站点——
  认证域 = default 站（vhost label 带 provider 名，`8903-basic` 与 `auth user add
  --provider basic` 同一用户库），修复登录无效
- **exposes() 修正**：proxy/both 记录 running=true（binding 已注册即运行中）；
  `tunnel-stop` 可移除 proxy binding（含 state.json 同步）
- **baseDomain 三来源统一**：`createServiceTunnels({baseDomain, baseDomains})` API
  参数 > env `SERVICE_TUNNELS_BASE_DOMAIN` > config base-domain（多域支持，首个
  为主域）；CLI `--base-domain` 运行时覆盖主域且保留其余
- **deployBasePath 合并**：`createServiceTunnels({deployBasePath})`（pi-web
  `PI_WEB_BASE_PATH=/dev`）与 provider basePath 合并 → 登录路径 `/dev/portal/login`；
  根部署保持 `/portal/login`；转发时剥离部署前缀
- **`.localhost` 加入默认后缀**：`DEFAULT_SUFFIXES = [.st.localhost, .service-tunnel.localhost, .localhost]`
  （本机零 DNS 配置的虚拟主机后缀，D4 门控不变）

## 0.2.38
