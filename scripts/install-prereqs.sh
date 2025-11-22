#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
NODE_VERSION_DEFAULT="${NODE_VERSION:-20.18.0}"
NODE_CACHE_DIR="${REPO_ROOT}/.cache/node-bootstrap"

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

node_version_ok() {
  local bin="$1"
  local version
  version="$("${bin}" -v 2>/dev/null || true)"
  if [[ "$version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    local major="${BASH_REMATCH[1]}"
    if (( major >= 18 )); then
      return 0
    fi
  fi
  return 1
}

download_node() {
  local os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  local arch="$(uname -m)"
  local platform=""
  local cpu=""
  case "$os" in
    linux) platform="linux" ;;
    darwin) platform="darwin" ;;
    *) echo "[install-prereqs] 当前平台($os)暂不支持自动下载 Node.js，请手动安装 Node 18+ 并重试。" >&2; exit 1 ;;
  esac

  case "$arch" in
    x86_64|amd64) cpu="x64" ;;
    arm64|aarch64) cpu="arm64" ;;
    *) echo "[install-prereqs] 当前架构($arch)暂不支持自动下载 Node.js，请手动安装 Node 18+ 并重试。" >&2; exit 1 ;;
  esac

  local dist="node-v${NODE_VERSION_DEFAULT}-${platform}-${cpu}"
  local archive_ext="tar.xz"
  [[ "$platform" == "darwin" ]] && archive_ext="tar.gz"
  local archive_name="${dist}.${archive_ext}"
  local url="https://nodejs.org/dist/v${NODE_VERSION_DEFAULT}/${archive_name}"
  local target_dir="${NODE_CACHE_DIR}/${dist}"
  local target_bin="${target_dir}/bin/node"

  if [[ ! -x "${target_bin}" ]]; then
    mkdir -p "${NODE_CACHE_DIR}"
    local tmp_file="${NODE_CACHE_DIR}/${archive_name}"
    echo "[install-prereqs] 正在下载临时 Node.js (v${NODE_VERSION_DEFAULT})..."
    if command_exists curl; then
      curl -fsSL -o "${tmp_file}" "${url}"
    elif command_exists wget; then
      wget -q -O "${tmp_file}" "${url}"
    else
      echo "[install-prereqs] 需要 curl 或 wget 以下载 Node.js，请安装其中之一后重试。" >&2
      exit 1
    fi
    echo "[install-prereqs] 正在解压 Node.js..."
    rm -rf "${target_dir}"
    if [[ "${archive_ext}" == "tar.gz" ]]; then
      tar -xzf "${tmp_file}" -C "${NODE_CACHE_DIR}"
    else
      tar -xJf "${tmp_file}" -C "${NODE_CACHE_DIR}"
    fi
  fi

  printf '%s' "${target_bin}"
}

resolve_node() {
  if [[ -n "${NODE_BIN:-}" && -x "${NODE_BIN}" ]]; then
    if node_version_ok "${NODE_BIN}"; then
      printf '%s' "${NODE_BIN}"
      return
    else
      echo "[install-prereqs] NODE_BIN 已设置但版本过低，尝试其它方案..."
    fi
  fi

  if command_exists node && node_version_ok "$(command -v node)"; then
    printf '%s' "$(command -v node)"
    return
  fi

  download_node
}

NODE_BIN_RESOLVED="$(resolve_node)"
echo "[install-prereqs] 使用 Node 可执行文件：${NODE_BIN_RESOLVED}"
if [[ ! -x "${NODE_BIN_RESOLVED}" ]]; then
  echo "[install-prereqs] 无法找到可执行的 Node.js，请手动安装 Node 18+。" >&2
  exit 1
fi

exec "${NODE_BIN_RESOLVED}" "${REPO_ROOT}/scripts/install-prereqs.mjs" "$@"
