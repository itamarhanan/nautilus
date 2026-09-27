#!/usr/bin/env bash
set -euo pipefail

# Run on the Studio while scripts/start-tunnel.sh runs on the PC. Exercises the
# PC agent through the reverse tunnel with a pull grant minted on the PC by
# scripts/mint-grant.sh. Nothing is applied: it stops at the preflight.
: "${NAUTILUS_SYNC_GRANT:?NAUTILUS_SYNC_GRANT must be a pull grant from scripts/mint-grant.sh on the PC}"
: "${NAUTILUS_SYNC_PROJECT_ID:?NAUTILUS_SYNC_PROJECT_ID must be set}"
: "${NAUTILUS_SYNC_REMOTE_HEAD:?NAUTILUS_SYNC_REMOTE_HEAD must name the runner checkpoint head}"
NAUTILUS_REMOTE_FORWARD_PORT="${NAUTILUS_REMOTE_FORWARD_PORT:-4200}"
NAUTILUS_TUNNEL_READY_ATTEMPTS="${NAUTILUS_TUNNEL_READY_ATTEMPTS:-30}"
NAUTILUS_TUNNEL_READY_INTERVAL="${NAUTILUS_TUNNEL_READY_INTERVAL:-1}"
NAUTILUS_SYNC_AGENT_URL="${NAUTILUS_SYNC_AGENT_URL:-http://127.0.0.1:${NAUTILUS_REMOTE_FORWARD_PORT}/v1/sync}"

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
command -v node >/dev/null 2>&1 || fail 'Node.js is required to build sync requests'
[[ "${NAUTILUS_SYNC_GRANT}" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || fail 'NAUTILUS_SYNC_GRANT is malformed'
[[ "${NAUTILUS_SYNC_PROJECT_ID}" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || fail 'NAUTILUS_SYNC_PROJECT_ID is invalid'
[[ "${NAUTILUS_SYNC_REMOTE_HEAD}" =~ ^[0-9a-f]{40,64}$ ]] || fail 'NAUTILUS_SYNC_REMOTE_HEAD must be a full Git object ID'
validate_port NAUTILUS_REMOTE_FORWARD_PORT "${NAUTILUS_REMOTE_FORWARD_PORT}"
validate_count NAUTILUS_TUNNEL_READY_ATTEMPTS "${NAUTILUS_TUNNEL_READY_ATTEMPTS}"
validate_count NAUTILUS_TUNNEL_READY_INTERVAL "${NAUTILUS_TUNNEL_READY_INTERVAL}"

remote_health_url="${NAUTILUS_SYNC_AGENT_URL%/*}/health"
for ((attempt = 1; attempt <= NAUTILUS_TUNNEL_READY_ATTEMPTS; attempt += 1)); do
  if curl --fail --silent --max-time 3 "${remote_health_url}" >/dev/null 2>&1; then
    break
  fi
  if ((attempt == NAUTILUS_TUNNEL_READY_ATTEMPTS)); then
    fail "tunnel health timed out at ${remote_health_url}; start scripts/start-tunnel.sh on the PC"
  fi
  sleep "${NAUTILUS_TUNNEL_READY_INTERVAL}"
done

node - <<'NODE'
const { randomUUID } = require("node:crypto");

const endpoint = new URL(process.env.NAUTILUS_SYNC_AGENT_URL);
if (
  endpoint.protocol !== "http:" ||
  !new Set(["127.0.0.1", "localhost", "[::1]"]).has(endpoint.hostname) ||
  endpoint.pathname !== "/v1/sync" ||
  endpoint.search !== ""
) {
  throw new Error("NAUTILUS_SYNC_AGENT_URL must be the HTTP loopback /v1/sync endpoint");
}
const grant = process.env.NAUTILUS_SYNC_GRANT;
const projectId = process.env.NAUTILUS_SYNC_PROJECT_ID;
const remoteHead = process.env.NAUTILUS_SYNC_REMOTE_HEAD;

async function request(operation, values = {}) {
  const now = Date.now();
  const envelope = {
    version: 1,
    requestId: randomUUID(),
    operation,
    projectId,
    grant,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
    nonce: randomUUID(),
    baseHead: null,
    expectedLocalHead: null,
    expectedRemoteHead: null,
    payload: {},
    ...values,
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  const body = await response.json();
  if (body?.version !== 1 || body?.requestId !== envelope.requestId) {
    throw new Error(`${operation} returned an invalid protocol response`);
  }
  return { httpStatus: response.status, body };
}

(async () => {
  const health = await request("health");
  if (health.httpStatus !== 200 || health.body.status !== "ok") {
    throw new Error(`health failed: ${health.body.error?.message ?? health.body.status}`);
  }
  const state = await request("state");
  const local = state.body.state;
  if (state.httpStatus !== 200 || state.body.status !== "ok" || !local) {
    throw new Error(`state failed: ${state.body.error?.message ?? state.body.status}`);
  }
  if (!/^[0-9a-f]{40,64}$/.test(local.head ?? "") || !/^[0-9a-f]{40,64}$/.test(local.baseHead ?? "")) {
    throw new Error("state must contain a complete local head and synchronized base head before preflight");
  }
  const preflight = await request("preflight", {
    baseHead: local.baseHead,
    expectedLocalHead: local.head,
    expectedRemoteHead: remoteHead,
    payload: { localHead: local.head, remoteHead },
  });
  if (![200, 409].includes(preflight.httpStatus) || !["ok", "conflict"].includes(preflight.body.status)) {
    throw new Error(`preflight failed: ${preflight.body.error?.message ?? preflight.body.status}`);
  }
  process.stdout.write(`granted sync health=ok state=ok preflight=${preflight.body.status}\n`);
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
NODE
