#!/usr/bin/env bash
# 预览隧道 —— CI/GitHub Actions 参考实现（L1/L3）
#
# 场景：PR / 演示环境 —— 起 dev server → 公网预览 URL + 机器访问 Bearer token
#   （token 无登录页、无 Cookie，适合 curl / 测试框架直接调用）。
#
# 依赖：jq；`service-tunnels` CLI（sts）全局安装。
# 隧道默认 cloudflared（零账号，CI 友好）；认证默认 auto（Linux→authelia）。
set -euo pipefail

PORT="${PORT:-5173}"
AUTH="${AUTH:-auto}"
TUNNEL="${TUNNEL:-cloudflared}"
TOKEN_TTL="${TOKEN_TTL:-+1h}"

# 1) 起 dev server（后台）
npm run dev -- --port "$PORT" &
DEV_PID=$!
trap 'kill "$DEV_PID" 2>/dev/null || true; sts stop-all 2>/dev/null || true' EXIT

# 2) 等端口就绪后暴露（CLI 自动拉起 daemon；--json 机器可读）
sleep 3
URL_JSON="$(mktemp)"
sts expose "$PORT" --tunnel "$TUNNEL" --auth "$AUTH" --json > "$URL_JSON"
URL="$(jq -r .url "$URL_JSON")"
LOGIN_URL="$(jq -r .loginUrl? "$URL_JSON")"
echo "preview URL:  $URL"
[ "$LOGIN_URL" != "null" ] && echo "login page:  $LOGIN_URL"

# 3) 机器访问 token（Bearer header；只在创建时显示一次）
TOKEN="$(sts auth token create --description "ci-preview" --expires "$TOKEN_TTL" --json | jq -r '.tokens[0].token')"

# 4) 验证：带 token 请求（应通过认证直通到应用）
echo "GET $URL/ (Bearer)"
curl -fsS -m 15 -H "Authorization: Bearer $TOKEN" "$URL/" | head -c 200
echo

# 5) （示例）把 URL + token 传给下一步：echo "PREVIEW_URL=$URL" >> "$GITHUB_OUTPUT"
echo "done — tunnel will be torn down on exit"
