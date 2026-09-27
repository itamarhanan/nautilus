#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_VERSION="${NAUTILUS_NODE_VERSION:-v24.15.0}"
NODE_ROOT="${NAUTILUS_NODE_ROOT:-${HOME}/nautilus/node}"
NODE_DIST="node-${NODE_VERSION}-linux-x64"
NODE_BIN="${NODE_ROOT}/node/bin"
OPENCODE_VERSION=""

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

require_command curl
require_command tar
require_command sha256sum
[[ "${HOME:-}" == /* ]] || fail 'HOME must be an absolute path'
[[ "${NODE_ROOT}" == /* && "${NODE_ROOT}" != "/" ]] || fail 'NAUTILUS_NODE_ROOT must be an absolute non-root path'
[[ "${NODE_VERSION}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'NAUTILUS_NODE_VERSION must be a full semantic version with a v prefix'
[[ -f "${ROOT_DIR}/package.json" && -f "${ROOT_DIR}/pnpm-lock.yaml" ]] || fail 'the Nautilus workspace must contain package.json and pnpm-lock.yaml'

if [[ ! -x "${NODE_BIN}/node" || ! -e "${NODE_BIN}/npm" ]]; then
  download_dir="$(mktemp -d)"
  cleanup() {
    rm -rf "${download_dir:-}"
  }
  trap cleanup EXIT
  archive="${download_dir}/${NODE_DIST}.tar.xz"
  checksums="${download_dir}/SHASUMS256.txt"
  curl --fail --silent --show-error --location \
    --output "${archive}" \
    "https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.xz"
  curl --fail --silent --show-error --location \
    --output "${checksums}" \
    "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
  grep " ${NODE_DIST}\.tar\.xz\$" "${checksums}" >"${download_dir}/selected.sum" || fail "checksum not found for ${NODE_DIST}"
  (cd "${download_dir}" && sha256sum --check --strict selected.sum)
  mkdir -p "${NODE_ROOT}"
  destination="${NODE_ROOT}/${NODE_DIST}"
  if [[ -e "${destination}" ]]; then
    rm -rf "${destination}"
  fi
  tar -xJf "${archive}" -C "${NODE_ROOT}"
  [[ -x "${destination}/bin/node" && -e "${destination}/bin/npm" ]] || fail 'downloaded Node runtime is incomplete'
  if [[ -e "${NODE_ROOT}/node" && ! -L "${NODE_ROOT}/node" ]]; then
    fail "${NODE_ROOT}/node exists and is not a symlink"
  fi
  ln -sfn "${NODE_DIST}" "${NODE_ROOT}/node"
fi

export PATH="${NODE_BIN}:${PATH}"
command -v corepack >/dev/null 2>&1 || fail 'corepack is required in the installed Node runtime'
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 15)) process.exit(1)' || fail 'Node 24.15.0 or newer is required'
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_ENABLE_NETWORK=1
package_manager="$(node -p 'require(process.argv[1]).packageManager' "${ROOT_DIR}/package.json")"
[[ "${package_manager}" =~ ^pnpm@[^[:space:]]+$ ]] || fail 'packageManager must pin pnpm'
corepack prepare "${package_manager}" --activate
pnpm install --frozen-lockfile --prefer-offline --dir "${ROOT_DIR}"
OPENCODE_VERSION="$(node -p 'require(process.argv[1]).dependencies["opencode-ai"]' "${ROOT_DIR}/apps/server/package.json")"
[[ "${OPENCODE_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'opencode-ai must be pinned to an exact version'
installed_version="$(pnpm --dir "${ROOT_DIR}" --filter @nautilus/server exec opencode --version)"
installed_version="${installed_version##*$'\n'}"
[[ "${installed_version}" == "${OPENCODE_VERSION}" || "${installed_version}" == "opencode ${OPENCODE_VERSION}" ]] || fail "OpenCode ${OPENCODE_VERSION} is required; found ${installed_version}"
printf 'Node %s and OpenCode %s are ready\n' "$(node --version)" "${OPENCODE_VERSION}"
