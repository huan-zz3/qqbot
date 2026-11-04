#!/usr/bin/env bash
# 构建 Windows x64 客户端压缩包。可在 Linux 上交叉编译（不依赖 Windows）。
#
# 用法：
#   scripts/build-client.sh
#
# 配置默认从仓库根目录的 .env 读取（只读下面四个键，不 source 整个文件）：
#   AGENT_CLIENT_ENDPOINT        服务端地址，tcp://主机:端口
#   AGENT_CLIENT_PSK             32 字节 hex（64 个十六进制字符）
#   AGENT_CLIENT_PSH_TIMEOUT_MS  注入 exe 的本地命令超时（可选，默认 60000）
#   AGENT_CLIENT_MAX_OUTPUT_CHARS 注入 exe 的本地输出上限（可选，默认 20000）
#
# 也可用同名环境变量临时覆盖（环境变量优先于 .env），例如：
#   AGENT_CLIENT_PSK=<64 位 hex> scripts/build-client.sh
#
# 产物：data/agent-client/qqbot-agent-<version>-win64.zip
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 从 .env 读取单个键（不 source：.env 里有带空格/引号/可能含 $ 的值）。
# 语义接近 dotenv：精确键名匹配、去行尾 \r、去值两端空白、去掉一层成对引号；
# 文件缺失或没有该键时静默返回空，由下面的校验报错。
dotenv_get() {
  local key="$1" line value
  [[ -f "$ROOT/.env" ]] || return 0
  line="$(grep -E "^${key}=" "$ROOT/.env" | tail -n1 || true)"
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ ${#value} -ge 2 ]]; then
    case "$value" in
      \"*\") value="${value:1:${#value}-2}" ;;
      \'*\') value="${value:1:${#value}-2}" ;;
    esac
  fi
  printf '%s' "$value"
}

# 环境变量优先，其次 .env。
env_or_dotenv() {
  local value="${!1:-}"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
  else
    dotenv_get "$1"
  fi
}

ENDPOINT="$(env_or_dotenv AGENT_CLIENT_ENDPOINT)"
PSK="$(env_or_dotenv AGENT_CLIENT_PSK)"
# 注入到 exe 的本地兜底上限；与服务端 AGENT_CLIENT_PSH_TIMEOUT_MS / AGENT_CLIENT_MAX_OUTPUT_CHARS 对应。
PSH_TIMEOUT_MS="$(env_or_dotenv AGENT_CLIENT_PSH_TIMEOUT_MS)"
PSH_TIMEOUT_MS="${PSH_TIMEOUT_MS:-60000}"
MAX_OUTPUT_CHARS="$(env_or_dotenv AGENT_CLIENT_MAX_OUTPUT_CHARS)"
MAX_OUTPUT_CHARS="${MAX_OUTPUT_CHARS:-20000}"

if [[ -z "$ENDPOINT" ]]; then
  echo "错误：AGENT_CLIENT_ENDPOINT 未设置（.env 或环境变量里都需要，形如 tcp://主机:端口，例如 tcp://1.2.3.4:7801）" >&2
  exit 1
fi
if [[ -z "$PSK" ]]; then
  echo "错误：AGENT_CLIENT_PSK 未设置（.env 或环境变量里都需要，32 字节 hex，与服务端 AGENT_CLIENT_PSK 一致）" >&2
  exit 1
fi

if [[ "$ENDPOINT" != tcp://* ]]; then
  echo "错误：AGENT_CLIENT_ENDPOINT 必须以 tcp:// 开头，当前是：$ENDPOINT" >&2
  exit 1
fi
if [[ ! "$PSK" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "错误：AGENT_CLIENT_PSK 必须是 64 个十六进制字符（32 字节）" >&2
  exit 1
fi
if [[ ! "$PSH_TIMEOUT_MS" =~ ^[1-9][0-9]*$ ]]; then
  echo "错误：AGENT_CLIENT_PSH_TIMEOUT_MS 必须是正整数毫秒，当前是：$PSH_TIMEOUT_MS" >&2
  exit 1
fi
if [[ ! "$MAX_OUTPUT_CHARS" =~ ^[1-9][0-9]*$ ]]; then
  echo "错误：AGENT_CLIENT_MAX_OUTPUT_CHARS 必须是正整数，当前是：$MAX_OUTPUT_CHARS" >&2
  exit 1
fi

if [[ -n "${GO_BIN:-}" ]]; then
  :
elif command -v go >/dev/null 2>&1; then
  GO_BIN="$(command -v go)"
elif [[ -x "${HOME}/.local/go/bin/go" ]]; then
  GO_BIN="${HOME}/.local/go/bin/go"
else
  echo "错误：找不到 go 工具链（可用 GO_BIN 指定绝对路径）" >&2
  exit 1
fi

# 客户端版本与 bot 版本没有对应关系（兼容判定由协议 v 承担），故不读 package.json。
AGENT_CLIENT_VERSION="${AGENT_CLIENT_VERSION:-0.2.0}"

OUT_DIR="$ROOT/data/agent-client"
mkdir -p "$OUT_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "构建客户端（$("$GO_BIN" version)）…"
(
  cd "$ROOT/client-go"
  CGO_ENABLED=0 GOOS=windows GOARCH=amd64 "$GO_BIN" build \
    -trimpath \
    -ldflags "-s -w -X main.endpoint=$ENDPOINT -X main.psk=$PSK -X main.pshTimeoutMs=$PSH_TIMEOUT_MS -X main.maxOutputChars=$MAX_OUTPUT_CHARS" \
    -o "$TMP_DIR/qqbot-agent.exe" \
    .
)

ZIP_PATH="$OUT_DIR/qqbot-agent-$AGENT_CLIENT_VERSION-win64.zip"
rm -f "$ZIP_PATH"

if command -v zip >/dev/null 2>&1; then
  (cd "$TMP_DIR" && zip -9 -q "$ZIP_PATH" qqbot-agent.exe)
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$ZIP_PATH" "$TMP_DIR/qqbot-agent.exe" <<'PY'
import sys
import zipfile

zip_path, exe_path = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    zf.write(exe_path, "qqbot-agent.exe")
PY
else
  echo "错误：既没有 zip 也没有 python3，无法打包" >&2
  exit 1
fi

EXE_SIZE="$(wc -c < "$TMP_DIR/qqbot-agent.exe")"
ZIP_SIZE="$(wc -c < "$ZIP_PATH")"
human() { awk -v n="$1" 'BEGIN { printf "%.1f MB", n / 1048576 }'; }

echo "已生成：${ZIP_PATH#"$ROOT"/}"
echo "  客户端 exe：$(human "$EXE_SIZE")（$EXE_SIZE 字节）"
echo "  压缩包：$(human "$ZIP_SIZE")（$ZIP_SIZE 字节）"
