#!/usr/bin/env bash
# Check for the system programs the runner needs, and install the missing ones.
#
#   scripts/ensure-system-tools.sh [--install]
#
# Without --install it only reports. With it, missing programs are installed
# through apt-get when sudo works without a password, as it does on a Lightning
# Studio. It never prompts, so a boot cannot hang waiting for one.
set -euo pipefail

install=false
[[ "${1:-}" == --install ]] && install=true

# program:apt package. git runs every shadow repository, xz unpacks the Node
# download, and the rest are what the boot and install scripts call.
required=(
  curl:curl
  flock:util-linux
  git:git
  readlink:coreutils
  setsid:util-linux
  sha256sum:coreutils
  stat:coreutils
  tar:tar
  xz:xz-utils
)

missing_programs=()
missing_packages=()
for entry in "${required[@]}"; do
  program="${entry%%:*}"
  package="${entry#*:}"
  if ! command -v "${program}" >/dev/null 2>&1; then
    missing_programs+=("${program}")
    [[ " ${missing_packages[*]} " == *" ${package} "* ]] || missing_packages+=("${package}")
  fi
done

if [[ ${#missing_programs[@]} -eq 0 ]]; then
  exit 0
fi

printf 'Missing system programs: %s\n' "${missing_programs[*]}" >&2
hint="sudo apt-get update && sudo apt-get install -y ${missing_packages[*]}"
if [[ "${install}" != true ]]; then
  printf 'Install them with: %s\n' "${hint}" >&2
  exit 1
fi
if ! command -v apt-get >/dev/null 2>&1; then
  printf 'This host has no apt-get. Install the packages for: %s\n' "${missing_programs[*]}" >&2
  exit 1
fi

as_root=()
if [[ "$(id -u)" -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true 2>/dev/null; then
    printf 'sudo needs a password here, so nothing was installed. Run: %s\n' "${hint}" >&2
    exit 1
  fi
  as_root=(sudo -n)
fi

printf 'Installing %s\n' "${missing_packages[*]}" >&2
export DEBIAN_FRONTEND=noninteractive
"${as_root[@]}" apt-get update -qq >&2
"${as_root[@]}" apt-get install -y -qq --no-install-recommends "${missing_packages[@]}" >&2

for program in "${missing_programs[@]}"; do
  command -v "${program}" >/dev/null 2>&1 || {
    printf '%s is still missing after installing its package\n' "${program}" >&2
    exit 1
  }
done
printf 'Installed %s\n' "${missing_packages[*]}" >&2
