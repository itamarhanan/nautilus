#!/usr/bin/env bash
# Deploy the runner to a Lightning AI Studio from the PC, and manage it after.
#
#   scripts/deploy-lightning.sh [command] [options]
#
# Run it with --help for the commands. Settings come from flags, from the
# environment, or from scripts/deploy-lightning.local (ignored by Git), in that
# order of precedence.
set -euo pipefail

umask 077
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_CONFIG="${ROOT_DIR}/scripts/deploy-lightning.local"

usage() {
  cat <<'USAGE'
Deploy the Nautilus runner to a Lightning AI Studio.

Usage: pnpm deploy:studio [command] [options]
       scripts/deploy-lightning.sh [command] [options]

Commands:
  deploy    (default) Start the Studio, expose ports 8080 and 8081, upload this
            working tree, install the boot hook, build and start the runner,
            then wait until the public URL answers.
  restart   Build and start the runner again from the code already on the
            Studio, without uploading anything.
  status    Show the Studio, its URLs, the runner's health, the deployed
            revision and whether a model provider is signed in.
  link      Show a QR code that opens the app on a phone and links it, with
            a one-time code that expires after 10 minutes.
  logs      Follow a runner log: server (default), web or boot.
  login     Sign a model provider in to the runner's OpenCode (interactive).

Options:
  --studio NAME           Studio name (NAUTILUS_STUDIO_NAME, default: nautilus)
  --teamspace OWNER/NAME  Teamspace (NAUTILUS_TEAMSPACE, required)
  --machine TYPE          Machine to start on (NAUTILUS_MACHINE, default: CPU)
  --create                Create the Studio if it does not exist yet
  --replace-hook          Back up and replace a Studio boot hook that this
                          script did not write
  -h, --help              Show this help

Settings can live in scripts/deploy-lightning.local, which Git ignores:

  NAUTILUS_STUDIO_NAME=nautilus
  NAUTILUS_TEAMSPACE=owner/teamspace
USAGE
}

# Colour only a terminal, and honour NO_COLOR (https://no-color.org).
if [[ -t 1 && -t 2 && -z "${NO_COLOR:-}" && "${TERM:-}" != dumb ]]; then
  bold=$'\e[1m' dim=$'\e[2m' red=$'\e[31m' green=$'\e[32m' yellow=$'\e[33m'
  blue=$'\e[34m' cyan=$'\e[36m' reset=$'\e[0m'
else
  bold="" dim="" red="" green="" yellow="" blue="" cyan="" reset=""
fi

# The command to suggest back: the pnpm alias when that is how this was run.
self="${npm_lifecycle_event:+pnpm ${npm_lifecycle_event}}"
self="${self:-scripts/deploy-lightning.sh}"

fail() {
  printf '%serror:%s %s\n' "${red}${bold}" "${reset}" "$1" >&2
  exit 1
}

warn() {
  printf '    %swarning:%s %s\n' "${yellow}${bold}" "${reset}" "$1" >&2
}

step() {
  printf '\n%s==>%s %s%s%s\n' "${blue}${bold}" "${reset}" "${bold}" "$1" "${reset}"
}

note() {
  printf '    %s\n' "$1"
}

ok() {
  printf '    %s✓%s %s\n' "${green}" "${reset}" "$1"
}

# Output from the Studio, indented under the current step, with its warnings
# and errors coloured like the script's own.
relay() {
  local line
  while IFS= read -r line; do
    case "${line}" in
      error:*) printf '    %s%s%s\n' "${red}" "${line}" "${reset}" ;;
      warning:*) printf '    %s%s%s\n' "${yellow}" "${line}" "${reset}" ;;
      *) printf '    %s%s%s\n' "${dim}" "${line}" "${reset}" ;;
    esac
  done
}

# Flags win over the environment, and the environment wins over the local
# config file, so the file is read before either is applied.
if [[ -f "${LOCAL_CONFIG}" ]]; then
  env_studio="${NAUTILUS_STUDIO_NAME:-}"
  env_teamspace="${NAUTILUS_TEAMSPACE:-}"
  env_machine="${NAUTILUS_MACHINE:-}"
  # shellcheck source=/dev/null
  . "${LOCAL_CONFIG}"
  NAUTILUS_STUDIO_NAME="${env_studio:-${NAUTILUS_STUDIO_NAME:-}}"
  NAUTILUS_TEAMSPACE="${env_teamspace:-${NAUTILUS_TEAMSPACE:-}}"
  NAUTILUS_MACHINE="${env_machine:-${NAUTILUS_MACHINE:-}}"
fi

command_name="deploy"
log_name="server"
create_studio=false
replace_hook=false
studio_name="${NAUTILUS_STUDIO_NAME:-nautilus}"
teamspace="${NAUTILUS_TEAMSPACE:-}"
machine="${NAUTILUS_MACHINE:-CPU}"
ssh_key="${NAUTILUS_SSH_KEY:-${HOME}/.ssh/lightning_rsa}"
ssh_host="ssh.lightning.ai"
# Relative to the Studio's home. The runner keeps its own state in ~/nautilus,
# so the code cannot live there.
remote_dir="nautilus-src"
gateway_port=8080
preview_port=8081
control_port=4001
ready_timeout="${NAUTILUS_READY_TIMEOUT:-600}"

if [[ $# -gt 0 && "$1" != -* ]]; then
  command_name="$1"
  shift
fi
if [[ "${command_name}" == logs && $# -gt 0 && "$1" != -* ]]; then
  log_name="$1"
  shift
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --studio) studio_name="${2:?--studio needs a value}"; shift 2 ;;
    --teamspace) teamspace="${2:?--teamspace needs a value}"; shift 2 ;;
    --machine) machine="${2:?--machine needs a value}"; shift 2 ;;
    --create) create_studio=true; shift ;;
    --replace-hook) replace_hook=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) fail "unknown option $1 (see --help)" ;;
  esac
done

case "${command_name}" in
  deploy | restart | status | link | logs | login) ;;
  help) usage; exit 0 ;;
  *) fail "unknown command ${command_name} (see --help)" ;;
esac
case "${log_name}" in
  server | web | boot) ;;
  *) fail 'logs takes server, web or boot' ;;
esac

[[ -n "${teamspace}" ]] || fail 'set the teamspace with --teamspace owner/name, NAUTILUS_TEAMSPACE or scripts/deploy-lightning.local'
[[ "${teamspace}" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || fail 'the teamspace must look like owner/name'
[[ "${studio_name}" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] || fail 'the Studio name is invalid'
[[ "${machine}" =~ ^[a-zA-Z0-9._-]+$ ]] || fail 'the machine type is invalid'
[[ "${ready_timeout}" =~ ^[1-9][0-9]*$ ]] || fail 'NAUTILUS_READY_TIMEOUT must be a number of seconds'

for tool in curl git ssh tar; do
  command -v "${tool}" >/dev/null 2>&1 || fail "${tool} is required"
done
# The Lightning CLI and SDK ship as one package. pipx keeps it out of the
# system Python, which newer distributions refuse to install into.
install_lightning_cli() {
  step "Installing the Lightning CLI"
  if command -v pipx >/dev/null 2>&1; then
    pipx install lightning-sdk
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m pip install --user lightning-sdk ||
      fail 'pip could not install lightning-sdk; install pipx (sudo apt-get install pipx) and run this again'
  else
    fail 'the Lightning CLI needs Python 3; install pipx (sudo apt-get install pipx) and run this again'
  fi
  export PATH="${HOME}/.local/bin:${PATH}"
  hash -r
  command -v lightning >/dev/null 2>&1 || fail 'lightning-sdk installed, but the lightning command is not on the PATH; add ~/.local/bin to it'
  ok "Lightning CLI installed."
  step "Signing in to Lightning"
  lightning login
}

lightning_bin="${NAUTILUS_LIGHTNING_BIN:-$(command -v lightning || true)}"
if [[ -z "${lightning_bin}" && -x "${HOME}/.local/bin/lightning" ]]; then
  lightning_bin="${HOME}/.local/bin/lightning"
fi
if [[ -z "${lightning_bin}" ]]; then
  install_lightning_cli
  lightning_bin="$(command -v lightning)"
fi
[[ -x "${lightning_bin}" ]] || fail "${lightning_bin} is not an executable Lightning CLI"

# The SDK is usually installed with pipx, so its Python is not the system one.
# The CLI's own interpreter always has it.
find_sdk_python() {
  local candidate shebang
  local candidates=()
  [[ -n "${NAUTILUS_LIGHTNING_PYTHON:-}" ]] && candidates+=("${NAUTILUS_LIGHTNING_PYTHON}")
  read -r shebang <"${lightning_bin}" || true
  shebang="${shebang#\#!}"
  [[ "${shebang}" == /* && "${shebang}" != */env* ]] && candidates+=("${shebang%% *}")
  candidates+=(python3)
  for candidate in "${candidates[@]}"; do
    if "${candidate}" -c 'import lightning_sdk' >/dev/null 2>&1; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}
sdk_python="$(find_sdk_python)" ||
  fail 'the Lightning CLI is installed, but no Python can import lightning_sdk; reinstall it with pipx install --force lightning-sdk, or set NAUTILUS_LIGHTNING_PYTHON'

work_dir="$(mktemp -d)"
ssh_target=""
cleanup() {
  if [[ -n "${ssh_target}" && -S "${work_dir}/control" ]]; then
    ssh -o ControlPath="${work_dir}/control" -O exit "${ssh_target}" >/dev/null 2>&1 || true
  fi
  rm -rf "${work_dir}"
}
trap cleanup EXIT

# Every call passes create_ok=False: the SDK's Studio() creates a missing Studio
# by default, and a typo in a name should fail rather than make a new one.
sdk() {
  "${sdk_python}" - "$@" "${studio_name}" "${teamspace}" <<'PY'
import sys
from lightning_sdk import Studio

action, name, teamspace = sys.argv[1], sys.argv[-2], sys.argv[-1]
try:
    studio = Studio(name, teamspace=teamspace, create_ok=False)
except Exception as error:  # the SDK raises several types for "not found"
    print(f"missing\t{error}")
    sys.exit(0)

if action == "describe":
    print(f"{studio.status.value}\t{studio.id}")
elif action == "ports":
    from lightning_sdk.lightning_cloud.openapi.models import EndpointServiceUpdateEndpointBody

    wanted = {"nautilus": int(sys.argv[2]), "nautilus-preview": int(sys.argv[3])}
    # A free Studio sleeps after ten idle minutes, and a sleeping one answers its
    # port URLs with a 404. auto_start makes the first request wake it instead.
    # The public add_ports() cannot set it, so this uses the call it wraps.
    api, teamspace_id = studio._studio_api, studio._teamspace.id
    endpoints = {}
    for endpoint in studio.list_ports():
        for port in endpoint.ports or []:
            endpoints[int(port)] = endpoint
    for label, port in wanted.items():
        endpoint = endpoints.get(port)
        if endpoint is None:
            endpoints[port] = api.add_port(teamspace_id, studio.id, name=label, port=port, auto_start=True)
            print(f"added\t{port}", file=sys.stderr)
        elif endpoint.cloudspace is not None and not endpoint.cloudspace.auto_start:
            # The update replaces the whole endpoint, so every field it had is
            # sent back with only auto_start changed.
            endpoint.cloudspace.auto_start = True
            body = EndpointServiceUpdateEndpointBody(
                auth=endpoint.auth,
                cloudspace=endpoint.cloudspace,
                custom_domain=endpoint.custom_domain,
                lightning_subdomain=endpoint.lightning_subdomain,
                name=endpoint.name,
                ports=endpoint.ports,
                prewarm=endpoint.prewarm,
                proxy=endpoint.proxy,
                urls=endpoint.urls,
            )
            endpoints[port] = api._client.endpoint_service_update_endpoint(
                body=body, project_id=teamspace_id, id=endpoint.id
            )
            print(f"autostart\t{port}", file=sys.stderr)
    for port in wanted.values():
        urls = [url for url in (endpoints[port].urls or []) if url.startswith("https://")]
        print(f"{port}\t{urls[0] if urls else ''}")
PY
}

describe_studio() {
  local line
  line="$(sdk describe)"
  studio_status="${line%%$'\t'*}"
  studio_id="${line#*$'\t'}"
  # An expired or missing sign-in also surfaces as "not found". Sign in once
  # and ask again, so it is never mistaken for a missing Studio.
  if [[ "${studio_status}" == missing && "${studio_id}" =~ [Ll]og[[:space:]]?in|[Aa]uth|[Cc]redential|[Uu]nauthori|401|403 && -z "${signed_in_again:-}" ]]; then
    signed_in_again=true
    warn "Lightning refused the request (${studio_id}). Signing in again."
    "${lightning_bin}" login
    describe_studio
  fi
}

# One multiplexed connection carries every SSH call, so a deploy signs in once.
# -F /dev/null keeps local SSH config out of it, the same way the desktop does.
ssh_options() {
  printf '%s\n' -F /dev/null -i "${ssh_key}" -o IdentitiesOnly=yes -o BatchMode=yes \
    -o StrictHostKeyChecking=accept-new -o UpdateHostKeys=no -o ConnectTimeout=15 \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
    -o ControlMaster=auto -o ControlPath="${work_dir}/control" -o ControlPersist=600
}

remote() {
  local options=()
  mapfile -t options < <(ssh_options)
  ssh "${options[@]}" "${ssh_target}" "$@"
}

remote_tty() {
  local options=()
  mapfile -t options < <(ssh_options)
  ssh -t "${options[@]}" "${ssh_target}" "$@"
}

ensure_ssh_key() {
  if [[ ! -r "${ssh_key}" ]]; then
    step "Setting up the Lightning SSH key"
    note "This writes ${HOME}/.ssh/lightning_rsa and a Host entry in ~/.ssh/config."
    "${lightning_bin}" ssh configure --name "${studio_name}" --teamspace "${teamspace}"
    [[ -r "${ssh_key}" ]] || fail "the SSH key ${ssh_key} is still missing; set NAUTILUS_SSH_KEY"
    ok "SSH key ready."
  fi
}

# A Studio that has just started can refuse SSH for a little while.
wait_for_ssh() {
  local attempt
  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if remote true >/dev/null 2>&1; then
      return 0
    fi
    sleep 4
  done
  fail "SSH to ${ssh_target} did not come up; try: ssh -i ${ssh_key} ${ssh_target}"
}

connect_running_studio() {
  describe_studio
  [[ "${studio_status}" != missing ]] || fail "Studio ${studio_name} not found in ${teamspace}: ${studio_id}"
  [[ "${studio_status}" == Running ]] ||
    fail "Studio ${studio_name} is ${studio_status}; ${self} deploy starts it"
  ssh_target="s_${studio_id}@${ssh_host}"
  ensure_ssh_key
  wait_for_ssh
}

read_ports() {
  gateway_url=""
  preview_url=""
  while IFS=$'\t' read -r port url; do
    case "${port}" in
      "${gateway_port}") gateway_url="${url%/}" ;;
      "${preview_port}") preview_url="${url%/}" ;;
      missing) fail "Studio ${studio_name} disappeared: ${url}" ;;
    esac
  done < <(sdk ports "${gateway_port}" "${preview_port}")
  [[ "${gateway_url}" =~ ^https://[A-Za-z0-9.-]+$ ]] ||
    fail "Lightning returned no HTTPS URL for port ${gateway_port}; open the Studio's port panel and check it"
}

# Lightning answers a new port with its own 404 for about a minute, and a boot
# can take several more, so readiness is polled rather than checked once.
wait_for_public_ready() {
  local deadline=$((SECONDS + ready_timeout))
  while ((SECONDS < deadline)); do
    if curl --fail --silent --max-time 5 "${gateway_url}/health/ready" >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  return 1
}

server_log_lines() {
  remote 'wc -l <"$HOME/nautilus/logs/server.log" 2>/dev/null || echo 0' 2>/dev/null || echo 0
}

# The log is appended to across boots, so only what this run wrote is shown.
# Older lines describe an earlier failure and would send the reader after it.
show_log_tail() {
  local since="${1:-0}" new
  new="$(remote "tail -n +$((since + 1)) \"\$HOME/nautilus/logs/server.log\" 2>/dev/null | tail -n 40" 2>/dev/null || true)"
  if [[ -z "${new}" ]]; then
    printf '\n%sThis run wrote nothing to server.log;%s the failure is in the output above.\n' "${bold}" "${reset}" >&2
    return 0
  fi
  printf '\n%sWhat this run wrote to ~/nautilus/logs/server.log on the Studio:%s\n' "${bold}" "${reset}" >&2
  relay <<<"${new}" >&2
  printf '\n%sFull logs:%s %s logs server\n' "${bold}" "${reset}" "${self}" >&2
}

# The Studio half of a deploy. It runs through `bash -s` over SSH, after the new
# tree has been unpacked next to the old one.
read -r -d '' REMOTE_PREPARE <<'REMOTE' || true
set -euo pipefail
umask 077
remote_dir="$1"
public_url="$2"
revision="$3"
replace_hook="$4"
gateway_port="$5"
server_port=4000

src="${HOME}/${remote_dir}"
incoming="${src}.incoming"
previous="${src}.previous"
run_dir="${HOME}/nautilus/run"
log_dir="${HOME}/nautilus/logs"
secret_dir="${HOME}/nautilus/secrets"
env_file="${secret_dir}/nautilus.env"
# Lightning runs this one file on every Studio start, from the Studio's home.
hook_dir="${HOME}/.lightning_studio"
hook="${hook_dir}/on_start.sh"
hook_marker="# written by scripts/deploy-lightning.sh"

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# The Studio's home filesystem can refuse to delete a directory tree ("Directory
# not empty") while renaming it works, so a tree is renamed into the trash and
# emptying the trash is best effort, retried on the next deploy.
trash="${HOME}/nautilus/trash"
discard() {
  [[ -e "$1" ]] || return 0
  mkdir -p "${trash}"
  mv "$1" "${trash}/$(basename "$1").$(date +%s).$$"
}

# The same rules as stop_service in on_start.sh. It has to run here, before the
# tree moves: on_start.sh refuses to stop a process whose working directory is
# not the repo, so a runner left running in the moved tree would keep its ports.
stop_service() {
  local pid_file="${run_dir}/$1.pid"
  local pid="" cwd=""
  [[ -f "${pid_file}" ]] && pid="$(<"${pid_file}")"
  if [[ "${pid}" =~ ^[1-9][0-9]*$ ]] && kill -0 "${pid}" 2>/dev/null; then
    cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
    if [[ "${cwd}" != "${src}" ]]; then
      printf 'Leaving pid %s alone: it runs from %s, not %s\n' "${pid}" "${cwd:-an unknown folder}" "${src}" >&2
      return 0
    fi
    kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
    for _ in {1..15}; do
      kill -0 "${pid}" 2>/dev/null || break
      sleep 1
    done
    kill -0 "${pid}" 2>/dev/null && { kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true; }
  fi
  rm -f "${pid_file}"
}

[[ -d "${incoming}" ]] || fail "the upload is missing from ${incoming}"
[[ -x "${incoming}/.lightning_studio/on_start.sh" ]] || fail 'the upload has no executable .lightning_studio/on_start.sh'
mkdir -p "${run_dir}" "${log_dir}" "${secret_dir}"
chmod 700 "${HOME}/nautilus" "${run_dir}" "${log_dir}" "${secret_dir}"

# Every check runs before anything moves, so a refusal leaves the Studio as it
# was.
# A new Studio comes with a starter hook that holds only comments. It runs
# nothing, so it is backed up and replaced like one this script wrote.
foreign_hook=false
if [[ -e "${hook}" ]] && ! grep -qF "${hook_marker}" "${hook}"; then
  if grep -qvE '^[[:space:]]*(#|$)' "${hook}"; then
    [[ "${replace_hook}" == true ]] ||
      fail "${hook} exists and was not written by this script. Move it away, or rerun with --replace-hook to back it up and replace it."
  fi
  foreign_hook=true
fi

# Take the boot lock on_start.sh uses, so a boot Lightning started on its own
# is never building in a tree that is being swapped out.
exec 9>"${run_dir}/start.lock"
flock -w 900 9 || fail 'another boot held the start lock for 15 minutes'

stop_service server
stop_service web
for _ in {1..15}; do
  port_in_use "${gateway_port}" || port_in_use "${server_port}" || break
  sleep 1
done
if port_in_use "${gateway_port}" || port_in_use "${server_port}"; then
  fail "something outside ${src} still listens on port ${gateway_port} or ${server_port}. Find it with: ss -ltnp"
fi

if [[ -d "${src}" ]]; then
  # Turbo's cache is keyed by content, so an unchanged package restores its
  # build instead of compiling again.
  [[ -d "${src}/.turbo" && ! -e "${incoming}/.turbo" ]] && mv "${src}/.turbo" "${incoming}/.turbo"
  discard "${previous}"
  mv "${src}" "${previous}"
  # The previous tree is kept to read or roll back to. Its dependencies are the
  # bulk of it, come back with one install, and are not kept by the Studio
  # across a restart anyway.
  find "${previous}" -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true
fi
mv "${incoming}" "${src}"
exec 9>&-
rm -rf "${trash}" 2>/dev/null || printf 'Could not empty %s yet; it is retried on the next deploy\n' "${trash}"

mkdir -p "${hook_dir}"
if [[ "${foreign_hook}" == true ]]; then
  backup="${hook}.before-deploy-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "${hook}" "${backup}"
  printf 'Moved the old boot hook to %s\n' "${backup}"
fi
cat >"${hook}" <<HOOK
#!/usr/bin/env bash
${hook_marker}
# The code lives in ~/${remote_dir}, so this hands the boot to its own hook.
mkdir -p "\${HOME}/nautilus/logs"
exec "\${HOME}/${remote_dir}/.lightning_studio/on_start.sh" >>"\${HOME}/nautilus/logs/boot.log" 2>&1
HOOK
chmod 700 "${hook}"

# The env file is the operator's, so an existing one is only ever added to.
if [[ ! -f "${env_file}" ]]; then
  printf 'NAUTILUS_PUBLIC_URL=%s\nNAUTILUS_DEV_SERVER_RESTART=auto\n' "${public_url}" >"${env_file}"
  printf 'Wrote %s\n' "${env_file}"
elif ! grep -q '^NAUTILUS_PUBLIC_URL=' "${env_file}"; then
  printf 'NAUTILUS_PUBLIC_URL=%s\n' "${public_url}" >>"${env_file}"
  printf 'Added NAUTILUS_PUBLIC_URL to %s\n' "${env_file}"
elif ! grep -qxF "NAUTILUS_PUBLIC_URL=${public_url}" "${env_file}"; then
  printf 'warning: %s sets a different NAUTILUS_PUBLIC_URL than %s; left as it is\n' "${env_file}" "${public_url}" >&2
fi
chmod 600 "${env_file}"

printf '%s\n' "${revision}" >"${run_dir}/deployed-revision"
REMOTE

# Lists what Git would commit from the working tree: tracked files plus new
# ones that are not ignored. Ignored files, which include .env files, build
# output and node_modules, never leave the PC.
pack_tree() {
  local archive="$1"
  (
    cd "${ROOT_DIR}"
    git ls-files -z --cached --others --exclude-standard |
      while IFS= read -r -d '' file; do
        [[ -e "${file}" || -L "${file}" ]] && printf '%s\0' "${file}"
      done |
      tar --null --files-from=- --create --gzip --file="${archive}"
  )
}

revision_label() {
  local sha dirty=""
  sha="$(git -C "${ROOT_DIR}" rev-parse --short=12 HEAD)"
  [[ -n "$(git -C "${ROOT_DIR}" status --porcelain)" ]] && dirty="+uncommitted"
  printf '%s%s deployed %s\n' "${sha}" "${dirty}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

provider_signed_in() {
  remote 'test -s "$HOME/nautilus/opencode/state/opencode/auth.json"'
}

boot_runner() {
  local log_start
  log_start="$(server_log_lines)"
  [[ "${log_start}" =~ ^[0-9]+$ ]] || log_start=0
  step "Building and starting the runner"
  note "This installs dependencies and builds the server and the PWA, which can take several minutes."
  note "To watch it, run in another terminal: ${cyan}${self} logs server${reset}"
  if ! remote "bash \"\$HOME/${remote_dir}/.lightning_studio/on_start.sh\" </dev/null" 2>&1 | relay; then
    show_log_tail "${log_start}"
    fail 'the boot script failed on the Studio'
  fi
  step "Waiting for ${gateway_url}/health/ready"
  if ! wait_for_public_ready; then
    show_log_tail "${log_start}"
    fail "the runner did not answer on its public URL within ${ready_timeout} seconds"
  fi
  # The runner can report ready a little before the PWA answers through the
  # proxy, so the PWA gets a minute of its own.
  local attempt
  for ((attempt = 1; attempt <= 12; attempt += 1)); do
    curl --fail --silent --max-time 10 "${gateway_url}/" >/dev/null && break
    ((attempt < 12)) || fail 'the runner is up, but the PWA did not answer'
    sleep 5
  done
  ok "The runner and the PWA are ready."
}

print_summary() {
  printf '\n%s%sNautilus is running%s on Studio %s (%s)\n\n' "${green}" "${bold}" "${reset}" "${studio_name}" "${teamspace}"
  printf '  %sPublic URL%s   %s%s%s\n' "${bold}" "${reset}" "${cyan}" "${gateway_url}" "${reset}"
  printf '  %sPreview URL%s  %s\n' "${bold}" "${reset}" "${preview_url:-(not exposed)}"
  printf '  %sSSH%s          %s  %s(key %s)%s\n' "${bold}" "${reset}" "${ssh_target}" "${dim}" "${ssh_key}" "${reset}"
  printf '\n%sNext steps%s\n' "${bold}" "${reset}"
  if provider_signed_in; then
    printf '  %s✓%s A model provider is signed in.\n' "${green}" "${reset}"
  else
    printf '  %s•%s The free OpenCode Zen models need no sign-in. For another provider:  %s%s login%s\n' "${yellow}" "${reset}" "${cyan}" "${self}" "${reset}"
  fi
  printf '  • Link a phone: %s%s link%s shows a QR code to scan with the phone camera.\n' "${cyan}" "${self}" "${reset}"
  printf '  • In the desktop app, open Settings › Runner, paste the public URL,\n'
  printf '    press Detect, then Save and connect.\n'
  printf '\n%sA free Studio sleeps after 10 idle minutes. Opening the URL wakes it, and\n' "${dim}"
  printf 'the runner is back about three minutes later; the boot output goes to\n'
  printf '~/nautilus/logs/boot.log on the Studio.%s\n' "${reset}"
}

cmd_deploy() {
  local archive="${work_dir}/tree.tar.gz"
  local revision

  step "Checking Studio ${studio_name} in ${teamspace}"
  describe_studio
  if [[ "${studio_status}" == missing ]]; then
    [[ "${create_studio}" == true ]] ||
      fail "Studio ${studio_name} was not found (${studio_id}). Check the name and teamspace, or pass --create to make it."
  fi
  if [[ "${studio_status}" != Running ]]; then
    note "Studio is ${studio_status}; starting it on ${machine}."
    local start_args=(--name "${studio_name}" --teamspace "${teamspace}" --machine "${machine}")
    [[ "${studio_status}" == missing ]] && start_args+=(--create)
    "${lightning_bin}" studio start "${start_args[@]}"
    describe_studio
    [[ "${studio_status}" == Running ]] || fail "Studio ${studio_name} is ${studio_status} after starting it"
  fi
  ok "Studio is running (id ${studio_id})."

  step "Exposing ports ${gateway_port} and ${preview_port}, set to wake the Studio"
  read_ports
  note "Public URL:  ${gateway_url}"
  note "Preview URL: ${preview_url:-(Lightning returned none yet)}"

  step "Connecting over SSH"
  ssh_target="s_${studio_id}@${ssh_host}"
  ensure_ssh_key
  wait_for_ssh
  ok "Connected as ${ssh_target}."

  step "Uploading the working tree"
  revision="$(revision_label)"
  [[ "${revision}" == *+uncommitted* ]] && warn "The tree has uncommitted changes. They are deployed too."
  pack_tree "${archive}"
  note "$(du -h "${archive}" | cut -f1) compressed, revision ${revision%% *}."
  # A leftover upload is renamed away rather than deleted, for the same
  # filesystem reason as in the Studio half below.
  remote "set -e
    incoming=\"\$HOME/${remote_dir}.incoming\"
    if [ -e \"\$incoming\" ]; then
      mkdir -p \"\$HOME/nautilus/trash\"
      mv \"\$incoming\" \"\$HOME/nautilus/trash/${remote_dir}.incoming.\$(date +%s).\$\$\"
    fi
    mkdir -p \"\$incoming\"
    tar --extract --gzip --file=- --directory=\"\$incoming\"" <"${archive}"

  step "Swapping in the new code and installing the boot hook"
  note "The runner stops here and stays down until the build finishes."
  # SSH joins its arguments into one remote command line, so each is quoted
  # for the remote shell.
  if ! remote "bash -s -- $(printf '%q ' "${remote_dir}" "${gateway_url}" "${revision}" "${replace_hook}" "${gateway_port}")" \
    <<<"${REMOTE_PREPARE}" 2>&1 | relay; then
    fail 'preparing the Studio failed; the runner was not booted'
  fi

  boot_runner
  print_summary
}

cmd_restart() {
  connect_running_studio
  read_ports
  boot_runner
  print_summary
}

field() {
  printf '%s%-10s%s %s\n' "${bold}" "$1" "${reset}" "$2"
}

cmd_status() {
  describe_studio
  field Studio "${studio_name} in ${teamspace}"
  if [[ "${studio_status}" == missing ]]; then
    field State "${red}not found${reset} (${studio_id})"
    return 0
  fi
  if [[ "${studio_status}" == Running ]]; then
    field State "${green}${studio_status}${reset}"
  else
    field State "${yellow}${studio_status}${reset}"
  fi
  field SSH "s_${studio_id}@${ssh_host}"
  if [[ "${studio_status}" != Running ]]; then
    printf '\nThe Studio is not running. %s%s%s starts it.\n' "${cyan}" "${self}" "${reset}"
    return 0
  fi
  read_ports
  field Public "${cyan}${gateway_url}${reset}"
  field Preview "${preview_url:-(not exposed)}"
  if curl --fail --silent --max-time 5 "${gateway_url}/health/ready" >/dev/null 2>&1; then
    field Health "${green}ready${reset}"
  else
    field Health "${yellow}not ready${reset} (still booting, or down: ${self} logs server)"
  fi
  ssh_target="s_${studio_id}@${ssh_host}"
  ensure_ssh_key
  if remote true >/dev/null 2>&1; then
    field Deployed "$(remote 'cat "$HOME/nautilus/run/deployed-revision" 2>/dev/null || echo "(not deployed by this script)"')"
    if provider_signed_in; then
      field Provider "${green}signed in${reset}"
    else
      field Provider "${yellow}none${reset} (${self} login)"
    fi
  else
    field SSH "${yellow}not reachable yet${reset}"
  fi
}

# The desktop app already ships uqr for its own pairing code. Each character
# holds two rows of the code in half blocks, which keeps it about 40 columns
# wide, and it is painted black on white explicitly, so it scans on a dark
# terminal too.
print_qr() {
  [[ -t 1 ]] || return 1
  if command -v node >/dev/null 2>&1 &&
    (cd "${ROOT_DIR}/apps/desktop" && node --input-type=module -e '
      import { encode } from "uqr";
      const { data } = encode(process.argv[1], { border: 2 });
      const dark = (y, x) => data[y]?.[x] === true;
      const lines = [];
      for (let y = 0; y < data.length; y += 2) {
        let line = "";
        for (let x = 0; x < data.length; x += 1) {
          const top = dark(y, x);
          const bottom = dark(y + 1, x);
          line += top && bottom ? "\u2588" : top ? "\u2580" : bottom ? "\u2584" : " ";
        }
        lines.push(`    \x1b[30;47m${line}\x1b[0m`);
      }
      process.stdout.write(`${lines.join("\n")}\n`);
    ' "$1") 2>/dev/null; then
    return 0
  fi
  command -v qrencode >/dev/null 2>&1 && qrencode -t ANSIUTF8 -m 2 "$1"
}

# The same pairing code the desktop's Link a phone creates, asked for over the
# SSH connection instead: the control API only answers on the Studio's
# loopback. The link carries the code, so one scan opens the app and links it.
cmd_link() {
  local response code expires_at expires_local link
  connect_running_studio
  read_ports
  response="$(remote "curl --fail --silent --show-error --max-time 10 -X POST \
    -H 'X-Nautilus-Control: 1' -H 'Content-Type: application/json' \
    --data '{\"deviceName\":\"Phone\",\"ttlSeconds\":600}' \
    http://127.0.0.1:${control_port}/api/pairing-codes")" ||
    fail "the runner did not create a pairing code; check it with: ${self} status"
  read -r code expires_at < <("${sdk_python}" -c 'import json, sys; body = json.load(sys.stdin); print(body["code"], body["expiresAt"])' <<<"${response}") ||
    fail 'the runner answered with something other than a pairing code'
  [[ -n "${code}" ]] || fail 'the runner answered with an empty pairing code'
  link="${gateway_url}/?pair=$(printf '%s' "${code}" | "${sdk_python}" -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe=""))')"
  expires_local="$(date -d "${expires_at}" +%H:%M 2>/dev/null || printf '%s' "${expires_at}")"

  step "Link a phone"
  printf '\n'
  print_qr "${link}" || note "(No QR renderer found. Run pnpm install, or install qrencode.)"
  printf '\n'
  note "Scan it with the phone camera. The phone opens the app and links itself."
  note "Or open ${cyan}${gateway_url}${reset} and enter ${bold}${code}${reset}"
  note "${dim}The code works once and expires at ${expires_local}.${reset}"
  printf '\n'
  note "Then choose Add to Home Screen in the phone browser. On an iPhone the home"
  note "screen app can keep its own sign-in; if it asks for a code, run this again."
}

cmd_logs() {
  connect_running_studio
  remote_tty "tail -n 200 -F \"\$HOME/nautilus/logs/${log_name}.log\""
}

# The runner starts OpenCode with its own XDG directories, so credentials only
# count when they are written there.
cmd_login() {
  connect_running_studio
  remote_tty "set -e
    cd \"\$HOME/${remote_dir}\" || { echo 'Deploy first: the code is not on the Studio yet.' >&2; exit 1; }
    export PATH=\"\$HOME/nautilus/node/node/bin:\$PATH\"
    export XDG_DATA_HOME=\"\$HOME/nautilus/opencode/state\"
    export XDG_CONFIG_HOME=\"\$HOME/nautilus/opencode/state/config\"
    export XDG_CACHE_HOME=\"\$HOME/nautilus/opencode/state/cache\"
    pnpm --filter @nautilus/server exec opencode auth login"
  printf '\nIf the phone model picker does not list the provider, run: %s%s restart%s\n' "${cyan}" "${self}" "${reset}"
}

"cmd_${command_name}"
