#!/usr/bin/env bash
set -euo pipefail

printf 'timestamp_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
uname -a
cat /etc/os-release
lscpu
free -h
df -h
df -h "${HOME}"
node --version
npm --version
git --version
ssh -V
python3 --version
command -v flock
command -v setsid
command -v ss
ss -ltnp
