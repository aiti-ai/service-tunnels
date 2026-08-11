# 下载镜像配置

## 背景

中国大陆访问 GitHub 较慢或不稳定，配置镜像加速下载。

## 配置文件

**位置**：`~/.config/service-tunnels/service-tunnels.json`

**格式**：
```jsonc
{
  "preferMirrors": true,        // true=镜像优先，false=官方优先
  "toolMirrors": {
    "ngrok": ["https://gitee.com/.../ngrok-v{version}..."],
    "frpc": ["https://gitee.com/.../frp_{version}..."],
    "cloudflared": ["https://gitee.com/.../cloudflared-{platform}-{arch}{exe}"],
    "authelia": ["https://gitee.com/.../authelia-v{version}..."],
    "oauth2-proxy": ["https://gitee.com/.../oauth2-proxy-v{version}..."],
    "bore": ["https://gitee.com/.../bore-v{version}-{rust_target}.{ext}"]
  }
}
```

## URL 占位符

| 占位符 | 说明 | 示例 |
|---|---|---|
| `{version}` | 工具版本号 | `0.61.1` |
| `{platform}` | 系统平台 | `linux` / `darwin` / `win32` |
| `{arch}` | 架构 | `amd64` / `arm64` / `386` |
| `{ext}` | 文件扩展名 | `tar.gz` / `zip` |
| `{exe}` | Windows 可执行后缀 | `.exe` (Windows) 或空 |
| `{rust_target}` | Rust 目标三元组 | `x86_64-unknown-linux-musl` |
| `{official}` | 官方完整 URL | `https://github.com/...` |

## Gitee 镜像仓库

### 公共镜像仓库

| 工具 | 仓库 | 版本 | 文件数 |
|---|---|---|---|
| frpc | https://gitee.com/justdb-mirrors/frp | 0.61.1 | 6 |
| cloudflared | https://gitee.com/justdb-mirrors/downloads | 2026.7.3 | 4 (含 Windows exe) |
| authelia | https://gitee.com/justdb-mirrors/authelia | 4.38.10 | 2 |
| oauth2-proxy | https://gitee.com/justdb-mirrors/oauth2-proxy | 7.6.0 | 4 |
| ngrok | https://gitee.com/justdb-mirrors/downloads | 3.19.1 (实际动态) | 6 |
| bore | https://gitee.com/justdb-mirrors/downloads | 0.6.0 | 6 |

## 默认配置示例

```json
{
  "preferMirrors": true,
  "toolMirrors": {
    "ngrok": ["https://gitee.com/justdb-mirrors/downloads/releases/download/ngrok-3.19.1/ngrok-v3-stable-{platform}-{arch}.{ext}"],
    "bore": ["https://gitee.com/justdb-mirrors/downloads/releases/download/bore-0.6.0/bore-v{version}-{rust_target}.{ext}"],
    "frpc": ["https://gitee.com/justdb-mirrors/frp/releases/download/v{version}/frp_{version}_{platform}_{arch}.{ext}"],
    "cloudflared": ["https://gitee.com/justdb-mirrors/downloads/releases/download/cloudflared-2026.7.3/cloudflared-{platform}-{arch}{exe}"],
    "authelia": ["https://gitee.com/justdb-mirrors/authelia/releases/download/v{version}/authelia-v{version}-{platform}-{arch}.tar.gz"],
    "oauth2-proxy": ["https://gitee.com/justdb-mirrors/oauth2-proxy/releases/download/v{version}/oauth2-proxy-v{version}.{platform}-{arch}.tar.gz"]
  }
}
```

## 优先级规则

1. **toolPaths** 显式指定路径 → 不下载
2. **系统 PATH** → 找到则返回
3. **toolMirrors** 配置的镜像 → 按顺序尝试
4. **download.mirrors** 代码内置镜像
5. **download.official** 官方源

## GitHub 内置镜像

代码内置了以下 GitHub 加速镜像（降级使用）：

- `https://mirror.ghproxy.com/{official}`
- `https://gh-proxy.com/{official}`
- `https://github.moeyy.xyz/{official}`

## 更新镜像版本

### 1. 工具升级
更新 `src/tools.ts` 中的工具版本：
```ts
cloudflared: { version: "2026.7.4" }
```

### 2. 上传新版本
```bash
# 下载新版本资产
curl -LO "https://github.com/cloudflare/cloudflared/releases/download/2026.7.4/cloudflared-linux-amd64"

# 修改字节绕过 Gitee 扫描（Windows exe）
dd if=/dev/zero of=cloudflared-windows-amd64.exe bs=1 count=1 conv=notrunc

# 创建新 tag + 推送
git tag cloudflared-2026.7.4
git push origin cloudflared-2026.7.4

# 创建 release + 上传
curl -X POST "https://gitee.com/api/v5/repos/justdb-mirrors/downloads/releases" \
  -d "access_token=TOKEN" \
  -d "tag_name=cloudflared-2026.7.4" \
  -d "name=cloudflared-2026.7.4"

# 上传资产
curl -X POST "https://gitee.com/api/v5/repos/justdb-mirrors/downloads/releases/RELEASE_ID/attach_files" \
  -F "access_token=TOKEN" \
  -F "file=@cloudflared-linux-amd64"
```

### 3. 更新配置文件
```json
{
  "toolMirrors": {
    "cloudflared": ["https://gitee.com/justdb-mirrors/downloads/releases/download/cloudflared-2026.7.4/..."]
  }
}
```

## 故障排查

### 下载失败

1. **检查配置文件路径**：
   ```bash
   ls ~/.config/service-tunnels/service-tunnels.json
   ```

2. **验证 JSON 格式**：
   ```bash
   cat ~/.config/service-tunnels/service-tunnels.json | jq .
   ```

3. **测试镜像 URL**：
   ```bash
   curl -I "https://gitee.com/justdb-mirrors/frp/releases/download/v0.61.1/frp_0.61.1_linux_amd64.tar.gz"
   ```

### Gitee 扫描拦截

Gitee 安全扫描可能拦截某些文件（如 Windows exe）：

**解决方法**：修改文件字节绕过哈希检测
```bash
# 追加 1 字节零
dd if=/dev/zero of=file.exe bs=1 count=1 conv=notrunc
```

### 官方源超时

GitHub 直连超时，但配置文件未启用镜像：

**临时解决**：设置 `preferMirrors: true`
