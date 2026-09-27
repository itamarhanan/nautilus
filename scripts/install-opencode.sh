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
require_command xz
[[ "${HOME:-}" == /* ]] || fail 'HOME must be an absolute path'
[[ "${NODE_ROOT}" == /* && "${NODE_ROOT}" != "/" ]] || fail 'NAUTILUS_NODE_ROOT must be an absolute non-root path'
[[ "${NODE_VERSION}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'NAUTILUS_NODE_VERSION must be a full semantic version with a v prefix'
[[ -f "${ROOT_DIR}/package.json" && -f "${ROOT_DIR}/pnpm-lock.yaml" ]] || fail 'the Nautilus workspace must contain package.json and pnpm-lock.yaml'

# A Lightning Studio does not keep any directory named node_modules across a
# restart, and that includes Node's own lib/node_modules, where npm and corepack
# live. So a Node that still runs can be missing both, and is reinstalled.
node_is_whole() {
  [[ "$("${NODE_BIN}/node" --version 2>/dev/null || true)" == "${NODE_VERSION}" &&
    -e "${NODE_BIN}/npm" && -e "${NODE_BIN}/corepack" ]]
}

# The download is kept outside node_modules, so the reinstall after each
# restart is an unpack rather than a download.
download_node() {
  local archive="$1" checksums="$2" download_dir
  download_dir="$(dirname "${archive}")"
  mkdir -p "${download_dir}"
  if [[ -s "${archive}" && -s "${checksums}" ]] &&
    (cd "${download_dir}" && grep " ${NODE_DIST}\.tar\.xz\$" "$(basename "${checksums}")" | sha256sum --check --strict --status); then
    return 0
  fi
  curl --fail --silent --show-error --location --retry 3 --retry-delay 2 \
    --output "${archive}.partial" \
    "https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.xz"
  curl --fail --silent --show-error --location --retry 3 --retry-delay 2 \
    --output "${checksums}" \
    "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
  mv "${archive}.partial" "${archive}"
  (cd "${download_dir}" && grep " ${NODE_DIST}\.tar\.xz\$" "$(basename "${checksums}")" | sha256sum --check --strict) ||
    { rm -f "${archive}"; fail "the Node download failed its checksum; run this again"; }
}

# A Studio's home filesystem can refuse to delete a directory tree ("Directory
# not empty") while renaming it works. So nothing is deleted where it stands: a
# tree is renamed into .trash first, and emptying .trash is best effort, retried
# on the next run.
discard() {
  local target="$1"
  [[ -e "${target}" || -L "${target}" ]] || return 0
  mkdir -p "${NODE_ROOT}/.trash"
  mv "${target}" "${NODE_ROOT}/.trash/$(basename "${target}").$(date +%s).$$"
}

empty_trash() {
  [[ -d "${NODE_ROOT}/.trash" ]] || return 0
  rm -rf "${NODE_ROOT}/.trash" 2>/dev/null ||
    printf 'Could not empty %s yet; it is retried on the next run\n' "${NODE_ROOT}/.trash"
}

if ! node_is_whole; then
  installed_node="$("${NODE_BIN}/node" --version 2>/dev/null || true)"
  if [[ "${installed_node}" == "${NODE_VERSION}" ]]; then
    printf 'Node %s lost its bundled npm or corepack; reinstalling it\n' "${NODE_VERSION}"
  elif [[ -n "${installed_node}" ]]; then
    printf 'Replacing Node %s with %s\n' "${installed_node}" "${NODE_VERSION}"
  else
    printf 'Installing Node %s\n' "${NODE_VERSION}"
  fi
  archive="${NODE_ROOT}/downloads/${NODE_DIST}.tar.xz"
  download_node "${archive}" "${NODE_ROOT}/downloads/SHASUMS256-${NODE_VERSION}.txt"
  destination="${NODE_ROOT}/${NODE_DIST}"
  # Unpack beside the old tree, so a failed unpack never leaves Node half
  # replaced.
  staging="${NODE_ROOT}/.unpack"
  discard "${staging}"
  mkdir -p "${staging}"
  tar -xJf "${archive}" -C "${staging}"
  [[ -x "${staging}/${NODE_DIST}/bin/node" && -e "${staging}/${NODE_DIST}/bin/npm" ]] || fail 'downloaded Node runtime is incomplete'
  discard "${destination}"
  mv "${staging}/${NODE_DIST}" "${destination}"
  discard "${staging}"
  if [[ -e "${NODE_ROOT}/node" && ! -L "${NODE_ROOT}/node" ]]; then
    fail "${NODE_ROOT}/node exists and is not a symlink"
  fi
  ln -sfn "${NODE_DIST}" "${NODE_ROOT}/node"
  node_is_whole || fail "Node ${NODE_VERSION} is still incomplete after reinstalling it"
fi
empty_trash

export PATH="${NODE_BIN}:${PATH}"
command -v corepack >/dev/null 2>&1 || fail 'corepack is required in the installed Node runtime'
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 15)) process.exit(1)' || fail 'Node 24.15.0 or newer is required'
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_ENABLE_NETWORK=1
package_manager="$(node -p 'require(process.argv[1]).packageManager' "${ROOT_DIR}/package.json")"
[[ "${package_manager}" =~ ^pnpm@[^[:space:]]+$ ]] || fail 'packageManager must pin pnpm'
corepack prepare "${package_manager}" --activate
# The Node tarball has no pnpm command; corepack adds it. A fresh unpack needs
# it again, and doing it every time costs nothing.
corepack enable --install-directory "${NODE_BIN}" pnpm
command -v pnpm >/dev/null 2>&1 || fail 'corepack did not provide pnpm'
# A dropped connection fails an install; the second try reuses what the first
# one downloaded.
pnpm install --frozen-lockfile --prefer-offline --dir "${ROOT_DIR}" ||
  pnpm install --frozen-lockfile --dir "${ROOT_DIR}" ||
  fail 'pnpm install failed twice'
OPENCODE_VERSION="$(node -p 'require(process.argv[1]).dependencies["opencode-ai"]' "${ROOT_DIR}/apps/server/package.json")"
[[ "${OPENCODE_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'opencode-ai must be pinned to an exact version'

opencode_ready() {
  local version
  version="$(pnpm --dir "${ROOT_DIR}" --filter @nautilus/server exec opencode --version 2>/dev/null || true)"
  version="${version##*$'\n'}"
  [[ "${version}" == "${OPENCODE_VERSION}" || "${version}" == "opencode ${OPENCODE_VERSION}" ]]
}

# opencode-ai's postinstall copies the platform binary into place. It can be
# skipped or cut off, which leaves a package with no working binary, so rerun
# it, and reinstall the package if that is not enough.
if ! opencode_ready; then
  printf 'OpenCode %s is missing or broken; rebuilding it\n' "${OPENCODE_VERSION}"
  pnpm --dir "${ROOT_DIR}" --filter @nautilus/server rebuild opencode-ai || true
fi
if ! opencode_ready; then
  printf 'Reinstalling OpenCode %s\n' "${OPENCODE_VERSION}"
  pnpm install --frozen-lockfile --force --dir "${ROOT_DIR}" || true
fi
opencode_ready || fail "OpenCode ${OPENCODE_VERSION} could not be installed; see the output above"
printf 'Node %s and OpenCode %s are ready\n' "$(node --version)" "${OPENCODE_VERSION}"
