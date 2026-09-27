#!/usr/bin/env bash
set -euo pipefail

# Run on the PC. Mints a sync grant from a sync agent that was started by hand
# for development (`NAUTILUS_AGENT_LAUNCH_KEY=… node apps/sync-agent/dist/cli.js`).
# The desktop app mints grants itself; this is for `scripts/test-sync.sh`.
# Usage: scripts/mint-grant.sh <project-id> <pull|push>
: "${NAUTILUS_AGENT_LAUNCH_KEY:?NAUTILUS_AGENT_LAUNCH_KEY must match the key the agent was started with}"
PROJECT_ID="${1:?usage: mint-grant.sh <project-id> <pull|push>}"
DIRECTION="${2:?usage: mint-grant.sh <project-id> <pull|push>}"
NAUTILUS_AGENT_PORT="${NAUTILUS_AGENT_PORT:-4100}"

[[ "${PROJECT_ID}" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || { echo 'project id is invalid' >&2; exit 1; }
[[ "${DIRECTION}" == pull || "${DIRECTION}" == push ]] || { echo 'direction must be pull or push' >&2; exit 1; }

curl --fail --silent --show-error --max-time 5 \
  -X POST "http://127.0.0.1:${NAUTILUS_AGENT_PORT}/v1/grants" \
  -H "Authorization: Bearer ${NAUTILUS_AGENT_LAUNCH_KEY}" \
  -H 'Content-Type: application/json' \
  --data "{\"projectId\":\"${PROJECT_ID}\",\"direction\":\"${DIRECTION}\"}" |
  node -e 'const body = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(body.grant); console.error(`expires ${body.claims.expiresAt}`);'
