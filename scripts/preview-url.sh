#!/usr/bin/env bash
set -euo pipefail

# Run on the Studio. Prints a single-use preview URL for a project.
PROJECT_ID="${1:-demo}"
TTL_SECONDS="${2:-300}"
SECRET_DIR="${NAUTILUS_SECRET_DIR:-${HOME}/nautilus/secrets}"
CONTROL_PORT="${NAUTILUS_CONTROL_PORT:-4001}"
env_file="${NAUTILUS_ENV_FILE:-${SECRET_DIR}/nautilus.env}"
if [[ ! -f "${env_file}" && -f "${SECRET_DIR}/runner.env" ]]; then
  env_file="${SECRET_DIR}/runner.env"
fi
if [[ -f "${env_file}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${env_file}"
  set +a
fi
: "${NAUTILUS_PUBLIC_URL:?NAUTILUS_PUBLIC_URL must be set (environment or ${env_file})}"
export PATH="${NAUTILUS_NODE_ROOT:-${HOME}/nautilus/node}/node/bin:${PATH}"

# The loopback control listener is only reachable on the Studio itself.
curl --fail --silent --show-error -X POST \
  "http://127.0.0.1:${CONTROL_PORT}/api/projects/${PROJECT_ID}/preview-token" \
  -H "X-Nautilus-Control: 1" \
  -H "Content-Type: application/json" \
  --data "{\"ttlSeconds\":${TTL_SECONDS}}" |
  node -e '
    const body = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (body.previewUrl) {
      console.log(body.previewUrl);
    } else {
      const url = new URL(body.previewPath, process.argv[1]);
      url.searchParams.set("token", body.token);
      console.log(url.href);
    }
    console.error(`expires ${body.expiresAt}; single use`);
  ' "${NAUTILUS_PUBLIC_URL}"
