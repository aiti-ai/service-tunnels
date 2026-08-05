## 0.2.41

### 会话 cookie 按认证域（site）隔离
- **portal cookie 名包含 site**：default → `st_portal_session`（兼容），非 default
  站点 → `st_portal_<site>_session` / `st_portal_<site>_2fa`——嵌套 proxy 或同一
  浏览器访问多个认证域时 cookie 不再同名冲突
- **authelia cookie 名包含 site**：`authelia_session`（default）/ `authelia_<site>_session`
- 各 site 的 provider 实例本就持有独立 session secret——名 + 值双层隔离

## 0.2.40
