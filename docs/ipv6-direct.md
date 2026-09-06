# IPv6 直连暴露（mode "ipv6"）使用指南

> 无需隧道、无需路由器端口映射：机器有**公网（全球单播）IPv6** 时，用
> `st expose --mode ipv6` 直接把本机服务暴露到 `http://[<公网v6>]:<端口>`。
> 设计文档见 [ipv6-direct-expose-design.md](ipv6-direct-expose-design.md)。

## 为什么可以直接暴露

IPv6 **没有 NAT**：主机网卡上的全球单播地址本身就是公网可达地址。service-tunnels
的 proxy transport 监听 `::`（双栈），`[v6]:port` 的直连请求经
`allowIpDirect` 映射到已登记 (enrolled) 的应用端口——认证照常生效，且本机
防火墙自动放行。

对比：

| 方式 | 需要路由器映射 | 需要隧道进程 | 需要第三方账号 |
|---|---|---|---|
| `--mode tunnel`（ngrok/frpc/…） | 否 | 是 | 常需要 |
| `--mode portmap`（UPnP/NAT-PMP/ssh-router） | 是 | 否 | — |
| **`--mode ipv6`（本次新增）** | **否** | **否** | **无** |

## 前置条件

1. 本机有**公网 IPv6**（不是只有链路本地 `fe80::` / ULA `fd00::`）。
2. 链路可达（大部分运营商原生 v6；若无原生 v6，可用 HE 隧道或带 IPv6 的 VPS
   —— 那是网络层手段，仍未使用 app 级隧道服务）。
3. 访问方（浏览器/客户端）也需支持 IPv6（公网 v6 只能被有 v6 的端访问）。

## 诊断：我有没有公网 IPv6？

```bash
st ipv6
# {
#   "addresses": [ { "address": "fe80::1%eth0", "scope": "link-local", ... } ],
#   "global": ["2001:db8:1::2"],      ← 这组可用于直连暴露
#   "hasIpv6Stack": true,
#   "hasGlobal": true
# }
```

- `global` 非空 → 可以直接暴露，用其中的地址作入口。
- `global` 为空但 `hasIpv6Stack` 为 true → 只有链路本地/ULA，公网不可直达；
  需要向 ISP 申请原生 v6，或走 HE 隧道 / VPS。
- `hasIpv6Stack` 为 false → 系统 IPv6 未启用。

`st status` 与 `st ddns ip` 也会附带 IPv6 诊断信息（`ipv6` /
`localIpv6` 字段）。

## 暴露

```bash
# 自动挑选第一个公网 v6 地址（认证默认 portal）
st expose 3000 --mode ipv6 --auth auto

# 显式指定入口地址（例如机器有多个 global 地址时）
st expose 3000 --mode ipv6 --auth auto --ipv6-address 2001:db8:1::2

# 开启认证 + 登记 AAAA / TXT 到 DNS（见下一节）
st expose 3000 --mode ipv6 --auth auto --ddns-profile my-dns --aaaa --txt
```

成功后返回（`ExposeResult`）：

```
url:  http://[2001:db8:1::2]:4180      ← 公网地址:transport 端口，浏览器直达
ipv6: { address, transportPort, addresses }   ← 实际入口 + 全部候选
```

- 认证照常：portal 默认，`--auth basic` / `--auth authelia` 均可。
- 认证关闭（`--auth none`）只在该主机允许无认证暴露时可用（和 tunnel/portmap
  同一把 `allow-auth-none` 安全锁）——公网裸暴露默认被拦截，这是有意的。
- 若本机防火墙无法自动放行（无 ufw/ip6tables、无 passwordless sudo），会
  **fail-closed 报错**并给出手动命令，绝不静默声称成功。

## 绑定域名（DDNS AAAA/TXT）

IPv6 直连暴露没有隧道域名可指，所以 CNAME **不适用**（CNAME 必须指向域名，
不能指向 IP 字面量）；可写的是 **AAAA**（v6 地址）与 **TXT**（`[v6]:port`）：

```bash
# expose 时直接登记（profile 在 ddns.json 里配置）
st expose 3000 --mode ipv6 --auth auto \
  --ddns-profile home --aaaa --txt

# 或单独注册 registry 条目（ipv6 类型的公开入口地址）
st ddns entry-add d6 --profile home --kind ipv6 --aaaa --txt
```

这样 `nslookup my.example.com` 返回 AAAA=你的公网 v6，服务可达
`http://my.example.com:<port>`（仍需访问方有 v6）。

## 管理

```bash
st ipv6 list        # 当前存活的 ipv6 直连 transport（地址 + 端口）
st ipv6 stop <key>  # 停止一个（关 transport + 撤销防火墙规则）
st expose stop <name>   # 停止暴露（同 tunnel/proxy 的停法）
st expose stop-all      # 全部停止
```

daemon 重启后，持久化的 ipv6 暴露会按入口地址自动恢复（transport 端口会
重新分配——重启后请重新 `st ipv6 list` 看新端口）。

## 安全注意

1. IPv6 无 NAT = 暴露即公网直达，**务必开认证**（默认 portal）。裸公开服务
   只在明确可接受时用 `--auth none`。
2. 暴露的端口 = transport 端口，只放行你需要的端口；不要在防火墙里整段开放
   IPv6。
3. 本工具只保证本机防火墙放行 + 地址正确。ISP/上游网段的过滤无法本地验证，
   从公网另一端访问一次确认可达性。
4. 不要用 ULA/链路本地地址作入口（公网不可达）。

## 常见问题

- **`st ipv6` 显示 global 为空**：ISP 未给原生 v6。检查路由器是否开了
  IPv6（SLAAC/DHCPv6），或改用隧道/VPS。
- **报「host firewall blocks IPv6 inbound」**：按提示手动放行，例如
  `sudo ufw allow in to 2001:db8:1::2 port 4180 proto tcp`。
- **公网访问不到但本机可以**：上游过滤（运营商/机房 ACL）、访问方无 v6、或
  IPv6 路由未实时生效——从另一网络（手机热点切到 v6）验证。
- **`--ipv6-address ::1` 只用于本机回环测试**，公网不可达。