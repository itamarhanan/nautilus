#!/usr/bin/env bash
# Set up a Nautilus runner on a free Lightning AI Studio, from nothing.
#
#   curl -fsSL https://raw.githubusercontent.com/itamarhanan/nautilus/main/scripts/install.sh | bash
#
# It checks out the latest release, asks for a Lightning teamspace, then runs
# scripts/deploy-lightning.sh to deploy and link a phone. Running it again
# updates the runner to the latest release.
#
# Settings, all optional:
#   NAUTILUS_VERSION   the release tag to deploy (default: the latest)
#   NAUTILUS_HOME      where the checkout lives (default: ~/.local/share/nautilus-runner)
#   NAUTILUS_TEAMSPACE and NAUTILUS_STUDIO_NAME, as for deploy-lightning.sh
set -euo pipefail

# Everything is inside main, called on the last line, so a download cut off
# halfway runs nothing.
main() {
  umask 077
  local repo_url="https://github.com/itamarhanan/nautilus.git"
  local home_dir="${NAUTILUS_HOME:-${XDG_DATA_HOME:-${HOME}/.local/share}/nautilus-runner}"
  local version="${NAUTILUS_VERSION:-}"

  if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-}" != dumb ]]; then
    bold=$'\e[1m' dim=$'\e[2m' red=$'\e[31m' green=$'\e[32m' blue=$'\e[34m'
    cyan=$'\e[36m' reset=$'\e[0m'
  else
    bold="" dim="" red="" green="" blue="" cyan="" reset=""
  fi

  # deploy-lightning.sh uses mapfile, which the bash 3.2 macOS ships lacks.
  ((BASH_VERSINFO[0] >= 4)) ||
    fail "this needs bash 4 or newer, and this is ${BASH_VERSION}. On macOS: brew install bash, then pipe this into \$(brew --prefix)/bin/bash"
  for tool in curl git ssh tar; do
    command -v "${tool}" >/dev/null 2>&1 || fail "${tool} is required"
  done

  step "Finding the release to deploy"
  if [[ -z "${version}" ]]; then
    version="$(git -c versionsort.suffix=- ls-remote --tags --refs --sort=-v:refname "${repo_url}" 'v*' |
      head -n 1 | sed 's|.*refs/tags/||')"
    [[ -n "${version}" ]] || fail "no release tags found at ${repo_url}"
  fi
  [[ "${version}" =~ ^v[0-9A-Za-z._-]+$ ]] || fail "NAUTILUS_VERSION must be a tag like v0.1.1"
  ok "Nautilus ${version}"

  step "Checking out ${version} in ${home_dir}"
  if [[ -d "${home_dir}/.git" ]]; then
    git -C "${home_dir}" fetch --quiet --depth 1 origin "refs/tags/${version}:refs/tags/${version}"
    # The checkout is this script's, so local edits are discarded. The settings
    # file is ignored by Git and survives.
    git -C "${home_dir}" -c advice.detachedHead=false checkout --quiet --force "${version}"
  else
    [[ ! -e "${home_dir}" ]] || fail "${home_dir} exists and is not a Nautilus checkout; move it away or set NAUTILUS_HOME"
    mkdir -p "$(dirname "${home_dir}")"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "${version}" "${repo_url}" "${home_dir}"
  fi
  ok "Checked out."

  local deploy="${home_dir}/scripts/deploy-lightning.sh"
  local settings="${home_dir}/scripts/deploy-lightning.local"
  [[ -f "${deploy}" ]] || fail "${version} has no scripts/deploy-lightning.sh; pick a newer NAUTILUS_VERSION"

  local teamspace="${NAUTILUS_TEAMSPACE:-}"
  if [[ -z "${teamspace}" && -f "${settings}" ]]; then
    teamspace="$(sed -n 's/^NAUTILUS_TEAMSPACE=//p' "${settings}" | tail -n 1)"
  fi
  if [[ -z "${teamspace}" ]]; then
    step "Choosing a Lightning teamspace"
    note "Sign up at ${cyan}https://lightning.ai${reset} if you have not; the free tier needs no card."
    note "The teamspace is in the address bar once you are signed in:"
    note "${dim}lightning.ai/${reset}${bold}<owner>/<teamspace>${reset}${dim}/home${reset}"
    [[ "${interactive}" == true ]] || fail 'set NAUTILUS_TEAMSPACE to run this without a terminal'
    while true; do
      read -r -p "    Teamspace (owner/teamspace): " teamspace </dev/tty
      [[ "${teamspace}" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] && break
      note "${red}That does not look like owner/teamspace.${reset}"
    done
  fi
  local studio="${NAUTILUS_STUDIO_NAME:-nautilus}"
  printf 'NAUTILUS_STUDIO_NAME=%s\nNAUTILUS_TEAMSPACE=%s\n' "${studio}" "${teamspace}" >"${settings}"
  export NAUTILUS_STUDIO_NAME="${studio}" NAUTILUS_TEAMSPACE="${teamspace}"

  # The deploy installs the Lightning CLI and signs in when it has to, and
  # creates the Studio on the first run.
  "${BASH}" "${deploy}" deploy --create

  "${BASH}" "${deploy}" link

  printf '\nThe free OpenCode Zen models work without signing in. To use another provider:\n'
  printf '  %s%s login%s\n' "${cyan}" "${deploy}" "${reset}"

  printf '\n%s%sDone.%s To update later, run the same command again.\n' "${green}" "${bold}" "${reset}"
  printf 'To manage the runner: %s%s --help%s\n' "${cyan}" "${deploy}" "${reset}"
  printf 'Desktop app: %shttps://github.com/itamarhanan/nautilus/releases/latest%s\n' "${cyan}" "${reset}"
}

fail() {
  printf '%serror:%s %s\n' "${red}${bold}" "${reset}" "$1" >&2
  exit 1
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

# Interactive steps read the terminal, not the pipe this script arrived on.
if (exec </dev/tty) 2>/dev/null; then
  interactive=true
  main "$@" </dev/tty
else
  interactive=false
  main "$@"
fi
