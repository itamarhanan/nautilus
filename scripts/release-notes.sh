#!/usr/bin/env bash
# Draft the notes for a release from the commits since the previous one.
#
#   scripts/release-notes.sh [tag]
#
# The tag defaults to the one on HEAD. Only commits a user would notice are
# listed (new features, fixes and speedups), grouped by the part of Nautilus
# they touch. The summary at the top is left for a person to write.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

tag="${1:-$(git describe --tags --exact-match HEAD 2>/dev/null || true)}"
[[ "${tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "usage: scripts/release-notes.sh v1.2.3 (or run it on a tagged commit)" >&2
  exit 1
}
version="${tag#v}"
git rev-parse -q --verify "refs/tags/${tag}" >/dev/null || {
  echo "tag ${tag} does not exist" >&2
  exit 1
}
previous="$(git describe --tags --abbrev=0 --match 'v[0-9]*' "${tag}^" 2>/dev/null || true)"
range="${previous:+${previous}..}${tag}"

# Areas in the order the notes show them. A scope that is not listed here
# lands under "Everything else".
areas=("Phone app" "Runner" "Desktop app" "Sync" "Setup" "Everything else")
area_of() {
  case "$1" in
    web) echo "Phone app" ;;
    server) echo "Runner" ;;
    desktop | sync-agent) echo "Desktop app" ;;
    shadow-git) echo "Sync" ;;
    repo) echo "Setup" ;;
    *) echo "Everything else" ;;
  esac
}

declare -A lines=()
while IFS= read -r subject; do
  [[ "${subject}" =~ ^(feat|fix|perf)\(([a-z-]+)\):\ (.+)$ ]] || continue
  kind="${BASH_REMATCH[1]}" scope="${BASH_REMATCH[2]}" text="${BASH_REMATCH[3]}"
  area="$(area_of "${scope}")"
  line="- ${text^}."
  # New features come before fixes within an area.
  if [[ "${kind}" == feat ]]; then
    lines["${area}"]="${line}"$'\n'"${lines["${area}"]:-}"
  else
    lines["${area}"]="${lines["${area}"]:-}${line}"$'\n'
  fi
done < <(git log --reverse --format=%s "${range}")

printf '<!-- Replace this line with one or two sentences on what %s is about. -->\n' "${tag}"
listed=false
for area in "${areas[@]}"; do
  [[ -n "${lines["${area}"]:-}" ]] || continue
  printf '\n## %s\n\n%s' "${area}" "${lines["${area}"]}"
  listed=true
done
[[ "${listed}" == true ]] || printf '\nNo changes a user would notice since %s.\n' "${previous:-the start}"

cat <<NOTES

## Install

| System | File | How |
| --- | --- | --- |
| Ubuntu, Debian and others | \`nautilus-desktop_${version}_amd64.deb\` | \`sudo apt install ./nautilus-desktop_${version}_amd64.deb\` |
| Any Linux | \`nautilus-desktop_${version}_amd64.AppImage\` | \`chmod +x\` the file, then run it |
| macOS (Apple Silicon) | \`Nautilus_${version}_aarch64.dmg\` | Open it and drag Nautilus to Applications |
| Windows | \`Nautilus_${version}_x64-setup.exe\` | Run it |

To set up or update a runner:

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/itamarhanan/nautilus/main/scripts/install.sh | bash
\`\`\`

**Upgrading:** install the new file the same way. On Linux, \`sudo apt install nautilus-desktop\` by name will not find it, because there is no package repository; point apt at the downloaded \`.deb\` instead. Run the command above again to update the runner.

The builds are not signed, so macOS and Windows warn on first launch. The [README](https://github.com/itamarhanan/nautilus#install-the-desktop-app) explains how to open them.
${previous:+
**Every change:** https://github.com/itamarhanan/nautilus/compare/${previous}...${tag}}
NOTES
