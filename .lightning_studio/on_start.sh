#!/usr/bin/env bash
set -euo pipefail

umask 077
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${NAUTILUS_STATE_DIR:-${HOME}/nautilus/state}"
LOG_DIR="${NAUTILUS_LOG_DIR:-${HOME}/nautilus/logs}"
RUN_DIR="${NAUTILUS_RUN_DIR:-${HOME}/nautilus/run}"
SECRET_DIR="${NAUTILUS_SECRET_DIR:-${HOME}/nautilus/secrets}"
SERVER_HOST="127.0.0.1"
SERVER_PORT="${NAUTILUS_SERVER_PORT:-4000}"
GATEWAY_PORT="${NAUTILUS_GATEWAY_PORT:-8080}"
# The preview listener serves the running project at the root of its own public
# origin, so previewed apps need no base path.
PREVIEW_PORT="${NAUTILUS_PREVIEW_PORT:-8081}"
WEB_PORT="${NAUTILUS_WEB_PORT:-3000}"
# Loopback-only admin API. The desktop reaches it through an SSH local forward;
# the gateway never routes to it.
CONTROL_PORT="${NAUTILUS_CONTROL_PORT:-4001}"
DEV_SERVER_RESTART="${NAUTILUS_DEV_SERVER_RESTART:-auto}"

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

wait_for_url() {
  local name="$1"
  local url="$2"
  local pid="$3"
  local attempts="$4"
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl --fail --silent --max-time 3 "${url}" >/dev/null 2>&1; then
      return 0
    fi
    kill -0 "${pid}" 2>/dev/null || fail "${name} exited before becoming ready; inspect ${LOG_DIR}"
    sleep 1
  done
  fail "${name} readiness timed out; inspect ${LOG_DIR}"
}

stop_service() {
  local name="$1"
  local pid_file="${RUN_DIR}/${name}.pid"
  local pid=""
  local cwd=""
  if [[ -f "${pid_file}" ]]; then
    pid="$(<"${pid_file}")"
  fi
  if [[ "${pid}" =~ ^[1-9][0-9]*$ ]] && kill -0 "${pid}" 2>/dev/null; then
    cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
    if [[ "${cwd}" != "${ROOT_DIR}" ]]; then
      printf 'Refusing to stop reused or unrelated pid %s from %s\n' "${pid}" "${pid_file}" >&2
      rm -f "${pid_file}"
      return 0
    fi
    kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
    for _ in {1..10}; do
      kill -0 "${pid}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${pid}" 2>/dev/null; then
      kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
    fi
  fi
  rm -f "${pid_file}"
}

[[ "${HOME:-}" == /* ]] || fail 'HOME must be an absolute path'
[[ -x "${ROOT_DIR}/scripts/install-opencode.sh" ]] || fail 'scripts/install-opencode.sh must be executable'
# A Studio image can lack a program the boot needs. Install it rather than
# failing the boot. It never prompts, and fails only if it cannot install.
"${ROOT_DIR}/scripts/ensure-system-tools.sh" --install || fail 'a required system program is missing and could not be installed'
validate_port NAUTILUS_SERVER_PORT "${SERVER_PORT}"
validate_port NAUTILUS_GATEWAY_PORT "${GATEWAY_PORT}"
validate_port NAUTILUS_PREVIEW_PORT "${PREVIEW_PORT}"
validate_port NAUTILUS_WEB_PORT "${WEB_PORT}"
[[ "${DEV_SERVER_RESTART}" == auto || "${DEV_SERVER_RESTART}" == never ]] || fail 'NAUTILUS_DEV_SERVER_RESTART must be auto or never'
mkdir -p "${STATE_DIR}" "${LOG_DIR}" "${RUN_DIR}" "${SECRET_DIR}"
chmod 700 "${STATE_DIR}" "${LOG_DIR}" "${RUN_DIR}" "${SECRET_DIR}"
exec 9>"${RUN_DIR}/start.lock"
flock -n 9 || exit 0
env_file="${NAUTILUS_ENV_FILE:-${SECRET_DIR}/nautilus.env}"
if [[ ! -f "${env_file}" && -f "${SECRET_DIR}/runner.env" ]]; then
  env_file="${SECRET_DIR}/runner.env"
fi
# The env file is optional: it holds model-provider keys and overrides. The
# server creates its own auth secret in ${SECRET_DIR}/auth-secret on first boot.
for secret_file in "${SECRET_DIR}"/*; do
  if [[ -f "${secret_file}" && -O "${secret_file}" ]]; then
    chmod 600 "${secret_file}"
  fi
done
if [[ -f "${env_file}" ]]; then
  [[ -r "${env_file}" ]] || fail "${env_file} is not readable"
  # A Studio's home filesystem does not keep file modes across a restart:
  # files come back 0744 however they were left. Every boot tightens them
  # again, and the check below still refuses a file owned by someone else or
  # a filesystem that ignores the change.
  [[ -O "${env_file}" ]] || fail "${env_file} is not owned by $(id -un)"
  chmod 600 "${env_file}"
  env_file_mode="$(stat -c '%a' "${env_file}")"
  (( (8#${env_file_mode} & 077) == 0 )) || fail "${env_file} must not be accessible by group or other users"
  set -a
  . "${env_file}"
  set +a
fi
if [[ -n "${NAUTILUS_AUTH_SECRET:-}" ]]; then
  # An existing secret keeps already-linked phones signed in.
  [[ ${#NAUTILUS_AUTH_SECRET} -ge 32 ]] || fail "NAUTILUS_AUTH_SECRET must contain at least 32 characters"
  export NAUTILUS_AUTH_SECRET
fi
export NAUTILUS_SECRETS_PATH="${SECRET_DIR}"
export NAUTILUS_CONTROL_PORT="${CONTROL_PORT}"
validate_port NAUTILUS_CONTROL_PORT "${CONTROL_PORT}"
export NAUTILUS_REMOTE_FORWARD_PORT="${NAUTILUS_REMOTE_FORWARD_PORT:-4200}"
validate_port NAUTILUS_REMOTE_FORWARD_PORT "${NAUTILUS_REMOTE_FORWARD_PORT}"
export NAUTILUS_SYNC_AGENT_URL="${NAUTILUS_SYNC_AGENT_URL:-http://127.0.0.1:${NAUTILUS_REMOTE_FORWARD_PORT}/v1/sync}"

stop_service server
stop_service web

"${ROOT_DIR}/scripts/install-opencode.sh"
export PATH="${NAUTILUS_NODE_ROOT:-${HOME}/nautilus/node}/node/bin:${PATH}"
for project_dir in "${HOME}"/nautilus/projects/*; do
  [[ -d "${project_dir}" ]] || continue
  if [[ -f "${project_dir}/pnpm-lock.yaml" ]]; then
    pnpm install --frozen-lockfile --prefer-offline --dir "${project_dir}"
  fi
done

cd "${ROOT_DIR}"

# A production boot builds before it starts. The PWA's rewrites name the API
# origin, and Next bakes them in at build time, so the build has to see the same
# port the server will listen on. Turbo caches both builds, so an unchanged tree
# costs a cache hit rather than a full compile.
printf '\n[%s] building\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"${LOG_DIR}/server.log"
NAUTILUS_SERVER_PORT="${SERVER_PORT}" \
  pnpm --dir "${ROOT_DIR}" exec turbo run build \
  --filter=@nautilus/server --filter=@nautilus/web >>"${LOG_DIR}/server.log" 2>&1 ||
  fail "the runner or PWA build failed; inspect ${LOG_DIR}/server.log"

printf '\n[%s] starting services\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"${LOG_DIR}/server.log"
printf '\n[%s] starting services\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"${LOG_DIR}/web.log"
HOST="${SERVER_HOST}" \
PORT="${SERVER_PORT}" \
NAUTILUS_GATEWAY_HOST="${SERVER_HOST}" \
NAUTILUS_GATEWAY_PORT="${GATEWAY_PORT}" \
NAUTILUS_PREVIEW_PORT="${PREVIEW_PORT}" \
NAUTILUS_WEB_PORT="${WEB_PORT}" \
  setsid node "${ROOT_DIR}/apps/server/dist/main.js" >>"${LOG_DIR}/server.log" 2>&1 9>&- &
server_pid=$!
printf '%s\n' "${server_pid}" >"${RUN_DIR}/server.pid"
chmod 600 "${RUN_DIR}/server.pid"
setsid pnpm --dir "${ROOT_DIR}" --filter @nautilus/web exec next start --hostname "${SERVER_HOST}" --port "${WEB_PORT}" >>"${LOG_DIR}/web.log" 2>&1 9>&- &
web_pid=$!
printf '%s\n' "${web_pid}" >"${RUN_DIR}/web.pid"
chmod 600 "${RUN_DIR}/web.pid"

server_health_url="http://127.0.0.1:${SERVER_PORT}/health/ready"
gateway_health_url="http://127.0.0.1:${GATEWAY_PORT}/health/ready"
web_url="http://127.0.0.1:${WEB_PORT}/"
wait_for_url server "${server_health_url}" "${server_pid}" 180

if [[ "${DEV_SERVER_RESTART}" == auto ]]; then
  recovery_projects="$(curl --fail --silent --show-error --max-time 10 \
    -H 'X-Nautilus-Control: 1' \
    "http://127.0.0.1:${CONTROL_PORT}/api/projects" | node -e '
      let input = "";
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const body = JSON.parse(input);
        const projects = Array.isArray(body.projects) ? body.projects : [];
        const recoverable = projects.filter((project) => project.state === "error" && project.lastError === "runner_restarted");
        if (recoverable.length > 1) throw new Error("multiple projects require restart recovery; refusing to choose one");
        if (recoverable.length === 1) process.stdout.write(recoverable[0].id);
      });
    ')"
  if [[ -n "${recovery_projects}" ]]; then
    curl --fail --silent --show-error --max-time 120 \
      -X POST \
      -H 'X-Nautilus-Control: 1' \
      -H 'Content-Type: application/json' \
      --data '{}' \
      "http://127.0.0.1:${CONTROL_PORT}/api/projects/${recovery_projects}/start" >/dev/null
    printf 'Restarted recovered project %s after clean shadow validation\n' "${recovery_projects}" >>"${LOG_DIR}/server.log"
  fi
fi

wait_for_url web "${web_url}" "${web_pid}" 180
wait_for_url gateway "${gateway_health_url}" "${server_pid}" 180
printf '[%s] services ready\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"${LOG_DIR}/server.log"
