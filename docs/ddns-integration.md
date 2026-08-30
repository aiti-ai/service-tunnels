# ddns 集成（service-tunnels ↔ ddns 包）

service-tunnels 内置的薄 DDNS 适配器已替换为 **`ddns` 包**（`file:../ddns`，
多供应商 DDNS + DNS 记录管理引擎，**120 家 provider**）。配置位置与格式不变：
`<configDir>/ddns.json`（0600）。

## 维度 1：设备直连 DDNS（IP 跟随）

有公网 IP 的设备（家庭路由/服务器）把记录值跟随本机公网 IP：

```bash
sts ddns add home --provider cloudflare --record home.example.com \
  --zone example.com --token <token>
sts ddns update            # 一次全量（探测 IP → 比对 → 变化才推）
sts ddns update --loop     # 常驻循环
sts ddns list
sts ddns ip                # 看当前公网 IP
```

配置示例：

```json
[
  { "name": "home", "provider": "cloudflare", "record": "home.example.com",
    "zone": "example.com", "token": "…", "intervalSec": 300 }
]
```

## 维度 2：tunnel 信标（无人值守注册当前 tunnel 域名）

远端服务器没有访问方式时，`nslookup <信标名>` 即可定位最新 tunnel 域名——
即使隧道域名不能直接访问（TLS/SNI），定位目的已达成。

### 注册表配置（ddns-registry）

ddns.json 支持对象形态（provider 凭据 + 记录目标 + 事件条目）：

```json
{
  "providerProfiles": {
    "cf": { "provider": "cloudflare", "token": "…" }
  },
  "profiles": {
    "home": { "providerProfile": "cf", "zone": "example.com", "record": "tunnel.example.com", "type": "CNAME" }
  },
  "entries": [
    { "name": "t1", "profile": "home", "kind": "tunnel", "followTunnel": "web",
      "cname": true, "txt": true }
  ]
}
```

- `kind: "tunnel"` + `followTunnel: "<tunnel名>"`：tunnel 上报新 URL 时，
  **CNAME** 更新为 URL 的 host（`tunnel.example.com → abc123.trycloudflare.com`），
  **TXT** 存完整 URL（`nslookup -type=TXT tunnel.example.com` 一把拿全）。
- `kind: "portmap"` + `ip: true` / `txt: true`：portmap 拿到外部 IP 时，
  **A** 记录 = 外部 IP，**TXT** = `ip:port`。

### 库 API

```ts
st.updateBeacon({ provider, zone, name, type?: "CNAME"|"TXT", token?, baseUrl? }, url)
  // → { ok, name, value, created?, error? } — never throws

st.beaconValue(input, type)  // CNAME 剥 scheme/path 只留 host；TXT 原样
```

### 事件联动

tunnel url 事件（`onEvent("url")`）与 portmap 结果自动触发注册，无需手动调用。

## 测试

- `test/ddns.test.mjs`：适配层（命令转发、信标、配置 0600）
- `test/ddns-registry.test.mjs`：注册表（profile 合并、tunnel CNAME/TXT、portmap A/TXT）
