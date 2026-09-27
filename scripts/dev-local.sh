#!/usr/bin/env bash
set -Eeuo pipefail

# Runs the runner server, the PWA, and the desktop app on this machine through
# the turbo TUI, one pane per service. The desktop starts in local mode: it
# talks to the control API on 127.0.0.1:4001 directly instead of through SSH,
# and it spawns the sync agent itself.
#
# Pass --stream to interleave all output in one terminal instead (useful for
# piping to a file or when no TTY is available). Extra flags go to turbo.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

ENV_FILE="${NAUTILUS_ENV_FILE:-${ROOT_DIR}/.env.local}"
if [[ ! -f "${ENV_FILE}" ]]; then
  mkdir -p "$(dirname "${ENV_FILE}")"
  umask 077
  printf 'NAUTILUS_AUTH_SECRET=%q\n' "$(openssl rand -hex 32)" >"${ENV_FILE}"
  printf 'NAUTILUS_SECURE_COOKIES=false\n' >>"${ENV_FILE}"
  printf 'NAUTILUS_OPENCODE_STARTUP_TIMEOUT_MS=120000\n' >>"${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
fi

set -a
source "${ENV_FILE}"
set +a

export NAUTILUS_SECURE_COOKIES="${NAUTILUS_SECURE_COOKIES:-false}"
# Without a tunnel, the runner reaches the desktop-spawned agent directly.
export NAUTILUS_SYNC_AGENT_URL="${NAUTILUS_SYNC_AGENT_URL:-http://127.0.0.1:4100/v1/sync}"
# `tauri dev` serves the webview from Vite, so its requests carry this origin.
export NAUTILUS_CONTROL_ORIGINS="${NAUTILUS_CONTROL_ORIGINS:-http://localhost:1420}"
export NAUTILUS_PROJECTS_ROOT="${NAUTILUS_PROJECTS_ROOT:-${HOME}/nautilus/dev-projects}"
export NAUTILUS_SECRETS_PATH="${NAUTILUS_SECRETS_PATH:-${HOME}/nautilus/dev-secrets}"
export VITE_NAUTILUS_LOCAL_MODE=1
# The QR code links the phone straight at the PWA in local mode.
export VITE_NAUTILUS_WEB_PORT="${NAUTILUS_WEB_PORT:-3000}"
# The phone reaches the PWA over the LAN, so the preview listener has to be
# there too. The runner links the phone to it on the host it used for the PWA,
# and a preview token still gates every request.
export NAUTILUS_PREVIEW_PORT="${NAUTILUS_PREVIEW_PORT:-8081}"
export NAUTILUS_PREVIEW_HOST="${NAUTILUS_PREVIEW_HOST:-0.0.0.0}"

# Human-readable, colored server logs; set NAUTILUS_LOG_FORMAT=json for raw lines.
export NAUTILUS_LOG_FORMAT="${NAUTILUS_LOG_FORMAT:-pretty}"
export NAUTILUS_LOG_LEVEL="${NAUTILUS_LOG_LEVEL:-info}"
export FORCE_COLOR="${FORCE_COLOR:-1}"

ui="tui"
args=()
for arg in "$@"; do
  case "${arg}" in
    --stream) ui="stream" ;;
    *) args+=("${arg}") ;;
  esac
done
if [[ ! -t 1 ]]; then
  ui="stream"
fi

printf 'Nautilus local services use environment file %s.\n' "${ENV_FILE}"

# Loose env mode forwards the NAUTILUS_*, VITE_*, and toolchain variables above
# to every task instead of turbo's strict allowlist.
exec pnpm exec turbo run dev:local \
  --filter=@nautilus/web \
  --filter=@nautilus/server \
  --filter=@nautilus/desktop \
  --ui="${ui}" \
  --env-mode=loose \
  "${args[@]}"
