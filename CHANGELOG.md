## 0.2.42

### baseDomain 支持 host:port（不抹除 PI_WEB_HOSTNAME 的端口）
- baseDomain 接受 `pi.example.com:57442` 形式：虚拟主机解析用 **host**（剥端口匹配
  后缀），生成的 URL（baseUrl/baseVhost）**保留端口**（`http://<port>-basic.pi.example.com:57442`）
- `setBaseDomain` / 构造统一 host:port 解析（splitHostPort，端口 1-65535 校验）；
  附加 baseDomains 取 host

## 0.2.41
