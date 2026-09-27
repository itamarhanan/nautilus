#!/usr/bin/env bash
set -euo pipefail

umask 077
: "${NAUTILUS_LIGHTNING_BIN:?NAUTILUS_LIGHTNING_BIN must name the Lightning CLI}"
: "${NAUTILUS_STUDIO_NAME:?NAUTILUS_STUDIO_NAME must be set}"
: "${NAUTILUS_TEAMSPACE:?NAUTILUS_TEAMSPACE must be set}"
: "${NAUTILUS_PUBLIC_URL:?NAUTILUS_PUBLIC_URL must be set}"
: "${NAUTILUS_SSH_TARGET:?NAUTILUS_SSH_TARGET must be the Studio SSH target, like s_01abc@ssh.lightning.ai}"
NAUTILUS_SSH_KEY="${NAUTILUS_SSH_KEY:-${HOME}/.ssh/lightning_rsa}"
NAUTILUS_CONTROL_PORT="${NAUTILUS_CONTROL_PORT:-4001}"
NAUTILUS_READY_ATTEMPTS="${NAUTILUS_READY_ATTEMPTS:-300}"
NAUTILUS_READY_INTERVAL="${NAUTILUS_READY_INTERVAL:-2}"
NAUTILUS_RESTART_DELAY_SECONDS="${NAUTILUS_RESTART_DELAY_SECONDS:-5}"
NAUTILUS_MACHINE="${NAUTILUS_MACHINE:-CPU}"
NAUTILUS_VERIFY_PROJECT_ID="${NAUTILUS_VERIFY_PROJECT_ID:-}"
LOG_FILE="${NAUTILUS_VERIFY_LOG:-${HOME}/.local/state/nautilus/logs/verify-restart.log}"
work_dir=""

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

validate_count() {
  local name="$1"
  local value="$2"
  [[ "${value}" =~ ^[1-9][0-9]*$ ]] || fail "${name} must be a positive integer"
}

cleanup() {
  if [[ -n "${work_dir}" ]]; then
    rm -rf "${work_dir}"
  fi
}
trap cleanup EXIT INT TERM

command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v node >/dev/null 2>&1 || fail 'Node.js is required to validate restart state'
command -v tee >/dev/null 2>&1 || fail 'tee is required'
[[ "${NAUTILUS_LIGHTNING_BIN}" == /* && -x "${NAUTILUS_LIGHTNING_BIN}" ]] || fail 'NAUTILUS_LIGHTNING_BIN must be an executable absolute path'
[[ "${NAUTILUS_STUDIO_NAME}" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] || fail 'NAUTILUS_STUDIO_NAME is invalid'
[[ "${NAUTILUS_TEAMSPACE}" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || fail 'NAUTILUS_TEAMSPACE must be owner/teamspace'
[[ "${NAUTILUS_SSH_TARGET}" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$ ]] || fail 'NAUTILUS_SSH_TARGET must look like user@host'
[[ "${NAUTILUS_SSH_KEY}" == /* && -r "${NAUTILUS_SSH_KEY}" ]] || fail 'NAUTILUS_SSH_KEY must be a readable absolute path'
[[ "${NAUTILUS_CONTROL_PORT}" =~ ^[1-9][0-9]{0,4}$ ]] || fail 'NAUTILUS_CONTROL_PORT is invalid'
[[ -z "${NAUTILUS_VERIFY_PROJECT_ID}" || "${NAUTILUS_VERIFY_PROJECT_ID}" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || fail 'NAUTILUS_VERIFY_PROJECT_ID is invalid'
validate_count NAUTILUS_READY_ATTEMPTS "${NAUTILUS_READY_ATTEMPTS}"
validate_count NAUTILUS_READY_INTERVAL "${NAUTILUS_READY_INTERVAL}"
validate_count NAUTILUS_RESTART_DELAY_SECONDS "${NAUTILUS_RESTART_DELAY_SECONDS}"
[[ "${NAUTILUS_MACHINE}" =~ ^[a-zA-Z0-9._-]+$ ]] || fail 'NAUTILUS_MACHINE is invalid'
node -e 'const value = new URL(process.argv[1]); const secure = value.protocol === "https:"; const local = value.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(value.hostname); if (!secure && !local) process.exit(1)' "${NAUTILUS_PUBLIC_URL%/}" || fail 'NAUTILUS_PUBLIC_URL must be HTTPS or a local HTTP test URL'
public_url="${NAUTILUS_PUBLIC_URL%/}"
mkdir -p "$(dirname "${LOG_FILE}")"
chmod 700 "$(dirname "${LOG_FILE}")"
touch "${LOG_FILE}"
chmod 600 "${LOG_FILE}"
work_dir="$(mktemp -d)"

# Admin routes exist only on the Studio's loopback control listener; reach it
# with the same SSH key the desktop uses.
control_get() {
  local path="$1"
  ssh -F /dev/null -i "${NAUTILUS_SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=15 -o UpdateHostKeys=no "${NAUTILUS_SSH_TARGET}" \
    "curl --fail --silent --show-error --max-time 10 -H 'X-Nautilus-Control: 1' 'http://127.0.0.1:${NAUTILUS_CONTROL_PORT}${path}'"
}

curl --fail --silent --show-error --max-time 10 "${public_url}/health/ready" >/dev/null || fail 'the runner is not ready before restart'
control_get "/api/projects" >"${work_dir}/projects-before.json"
if [[ -n "${NAUTILUS_VERIFY_PROJECT_ID}" ]]; then
  control_get "/api/sessions?projectId=${NAUTILUS_VERIFY_PROJECT_ID}" >"${work_dir}/sessions-before.json"
else
  printf '{"sessions":[]}\n' >"${work_dir}/sessions-before.json"
fi

lightning_stop_args=(
  --name "${NAUTILUS_STUDIO_NAME}"
  --teamspace "${NAUTILUS_TEAMSPACE}"
)
lightning_start_args=(
  "${lightning_stop_args[@]}"
  --machine "${NAUTILUS_MACHINE}"
)

printf 'stopping Studio %s\n' "${NAUTILUS_STUDIO_NAME}" | tee -a "${LOG_FILE}"
"${NAUTILUS_LIGHTNING_BIN}" studio stop "${lightning_stop_args[@]}" >>"${LOG_FILE}" 2>&1
sleep "${NAUTILUS_RESTART_DELAY_SECONDS}"
printf 'starting Studio %s\n' "${NAUTILUS_STUDIO_NAME}" | tee -a "${LOG_FILE}"
"${NAUTILUS_LIGHTNING_BIN}" studio start "${lightning_start_args[@]}" >>"${LOG_FILE}" 2>&1

ready=false
for ((attempt = 1; attempt <= NAUTILUS_READY_ATTEMPTS; attempt += 1)); do
  if curl --fail --silent --max-time 5 "${public_url}/health/ready" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep "${NAUTILUS_READY_INTERVAL}"
done
[[ "${ready}" == true ]] || fail "runner readiness timed out; inspect ${LOG_FILE}"
curl --fail --silent --show-error --max-time 10 "${public_url}/" >/dev/null
control_get "/api/projects" >"${work_dir}/projects-after.json"
if [[ -n "${NAUTILUS_VERIFY_PROJECT_ID}" ]]; then
  control_get "/api/sessions?projectId=${NAUTILUS_VERIFY_PROJECT_ID}" >"${work_dir}/sessions-after.json"
else
  printf '{"sessions":[]}\n' >"${work_dir}/sessions-after.json"
fi

node - "${work_dir}/projects-before.json" "${work_dir}/projects-after.json" "${work_dir}/sessions-before.json" "${work_dir}/sessions-after.json" "${NAUTILUS_VERIFY_PROJECT_ID}" <<'NODE'
const { readFileSync } = require("node:fs");
const [projectsBeforePath, projectsAfterPath, sessionsBeforePath, sessionsAfterPath, projectId] = process.argv.slice(2);
const projectsBefore = JSON.parse(readFileSync(projectsBeforePath, "utf8")).projects ?? [];
const projectsAfter = JSON.parse(readFileSync(projectsAfterPath, "utf8")).projects ?? [];
const sessionsBefore = JSON.parse(readFileSync(sessionsBeforePath, "utf8")).sessions ?? [];
const sessionsAfter = JSON.parse(readFileSync(sessionsAfterPath, "utf8")).sessions ?? [];
const interruptedStates = new Set(["starting", "running", "editing", "checkpointing"]);

if (projectId) {
  const before = projectsBefore.find((project) => project.id === projectId);
  const after = projectsAfter.find((project) => project.id === projectId);
  if (!before || !after) throw new Error("verified project was not registered after restart");
  if (interruptedStates.has(before.state)) {
    const recovered = after.state === "running" || after.state === "unhealthy";
    const restartPending = after.state === "error" && after.lastError === "runner_restarted";
    if (!recovered && !restartPending) {
      throw new Error(`interrupted project state was not recovered: ${after.state}`);
    }
  }
}
for (const before of sessionsBefore) {
  const after = sessionsAfter.find((session) => session.id === before.id);
  if (!after) throw new Error(`session ${before.id} was lost during restart`);
  if (before.status === "running" && after.status !== "interrupted") {
    throw new Error(`running session ${before.id} was not marked interrupted`);
  }
  if (before.status !== "running" && after.status !== before.status) {
    throw new Error(`completed session ${before.id} changed status during restart`);
  }
}
process.stdout.write("restart recovery state verified\n");
NODE
printf 'runner restarted and became ready; log: %s\n' "${LOG_FILE}"
