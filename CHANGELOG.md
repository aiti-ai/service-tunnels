## 0.2.40

### portal 登录默认重定向跟随部署前缀
- **portal provider 支持 `deployBasePath`**：登录表单无 `next` 时默认重定向到
  部署前缀（pi-web `PI_WEB_BASE_PATH=/dev` → `/dev`；根部署保持 `/`）——
  `/dev/portal/login` 部署下登录后不再跳到根路径
- portal 生成的 server.mjs 通过 `DEPLOY_BASE_PATH` env 注入（模板无 `this`）；
  expose / daemon 恢复路径均传入

## 0.2.39
