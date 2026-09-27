#!/usr/bin/env bash
set -euo pipefail

: "${NAUTILUS_SSH_TARGET:?NAUTILUS_SSH_TARGET must be set}"
: "${NAUTILUS_SSH_KEY:?NAUTILUS_SSH_KEY must be set}"
NAUTILUS_SSH_PORT="${NAUTILUS_SSH_PORT:-22}"
NAUTILUS_SSH_USER="${NAUTILUS_SSH_USER:-}"
NAUTILUS_AGENT_PORT="${NAUTILUS_AGENT_PORT:-4100}"
NAUTILUS_REMOTE_FORWARD_PORT="${NAUTILUS_REMOTE_FORWARD_PORT:-4200}"
NAUTILUS_TUNNEL_PROBE_ATTEMPTS="${NAUTILUS_TUNNEL_PROBE_ATTEMPTS:-10}"
NAUTILUS_TUNNEL_PROBE_INTERVAL="${NAUTILUS_TUNNEL_PROBE_INTERVAL:-1}"
LOG_DIR="${NAUTILUS_LOG_DIR:-${HOME}/.local/state/nautilus/logs}"
LOG_FILE="${NAUTILUS_TUNNEL_LOG:-${LOG_DIR}/tunnel.log}"
tunnel_pid=""

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

validate_port() {
  local name="$1"
  local value="$2"
  [[ "${value}" =~ ^[1-9][0-9]{0,4}$ ]] || fail "${name} must be an integer between 1 and 65535"
  ((10#${value} <= 65535)) || fail "${name} must be an integer between 1 and 65535"
}

validate_count() {
  local name="$1"
  local value="$2"
  [[ "${value}" =~ ^[1-9][0-9]*$ ]] || fail "${name} must be a positive integer"
}

command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v ssh >/dev/null 2>&1 || fail 'ssh is required'
command -v stat >/dev/null 2>&1 || fail 'stat is required'
[[ "${HOME:-}" == /* ]] || fail 'HOME must be an absolute path'
[[ "${NAUTILUS_SSH_TARGET}" != -* && ! "${NAUTILUS_SSH_TARGET}" =~ [[:space:]] ]] || fail 'NAUTILUS_SSH_TARGET is invalid'
[[ -z "${NAUTILUS_SSH_USER}" || ! "${NAUTILUS_SSH_USER}" =~ ^[a-zA-Z0-9._-]+$ ]] || fail 'NAUTILUS_SSH_USER is invalid'
[[ "${NAUTILUS_SSH_KEY}" == /* && -f "${NAUTILUS_SSH_KEY}" && -r "${NAUTILUS_SSH_KEY}" ]] || fail 'NAUTILUS_SSH_KEY must be a readable absolute file path'
validate_port NAUTILUS_SSH_PORT "${NAUTILUS_SSH_PORT}"
validate_port NAUTILUS_AGENT_PORT "${NAUTILUS_AGENT_PORT}"
validate_port NAUTILUS_REMOTE_FORWARD_PORT "${NAUTILUS_REMOTE_FORWARD_PORT}"
validate_count NAUTILUS_TUNNEL_PROBE_ATTEMPTS "${NAUTILUS_TUNNEL_PROBE_ATTEMPTS}"
validate_count NAUTILUS_TUNNEL_PROBE_INTERVAL "${NAUTILUS_TUNNEL_PROBE_INTERVAL}"
key_mode="$(stat -c '%a' "${NAUTILUS_SSH_KEY}")"
(( (8#${key_mode} & 077) == 0 )) || fail 'NAUTILUS_SSH_KEY must not be accessible by group or other users'
mkdir -p "${LOG_DIR}"
chmod 700 "${LOG_DIR}"
touch "${LOG_FILE}"
chmod 600 "${LOG_FILE}"
curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:${NAUTILUS_AGENT_PORT}/health" >/dev/null || fail 'the local PC sync agent is not healthy'

target="${NAUTILUS_SSH_TARGET}"
if [[ -n "${NAUTILUS_SSH_USER}" ]]; then
  target="${NAUTILUS_SSH_USER}@${target}"
fi

common_args=(
  -F /dev/null
  -i "${NAUTILUS_SSH_KEY}"
  -p "${NAUTILUS_SSH_PORT}"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=3
  -o UpdateHostKeys=no
)
tunnel_args=(
  "${common_args[@]}"
  -N
  -T
  -o ExitOnForwardFailure=yes
  -R "127.0.0.1:${NAUTILUS_REMOTE_FORWARD_PORT}:127.0.0.1:${NAUTILUS_AGENT_PORT}"
)
probe_args=(
  "${common_args[@]}"
  -o BatchMode=yes
)

cleanup() {
  if [[ -n "${tunnel_pid}" ]] && kill -0 "${tunnel_pid}" 2>/dev/null; then
    kill -TERM "${tunnel_pid}" 2>/dev/null || true
    wait "${tunnel_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

ssh "${tunnel_args[@]}" "${target}" >>"${LOG_FILE}" 2>&1 &
tunnel_pid=$!
remote_health_url="http://127.0.0.1:${NAUTILUS_REMOTE_FORWARD_PORT}/health"
for ((attempt = 1; attempt <= NAUTILUS_TUNNEL_PROBE_ATTEMPTS; attempt += 1)); do
  if ! kill -0 "${tunnel_pid}" 2>/dev/null; then
    wait "${tunnel_pid}" || true
    fail "reverse tunnel exited before its remote health check; see ${LOG_FILE}"
  fi
  if ssh "${probe_args[@]}" "${target}" \
    "curl --fail --silent --show-error --max-time 3 '${remote_health_url}'" \
    >>"${LOG_FILE}" 2>&1; then
    printf 'Reverse tunnel healthy on runner port %s; log: %s\n' \
      "${NAUTILUS_REMOTE_FORWARD_PORT}" "${LOG_FILE}"
    wait "${tunnel_pid}"
    exit $?
  fi
  sleep "${NAUTILUS_TUNNEL_PROBE_INTERVAL}"
done

fail "remote forward health check failed; see ${LOG_FILE}"
