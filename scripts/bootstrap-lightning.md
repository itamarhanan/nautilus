# Bootstrap Nautilus on Lightning AI

This procedure uses a free CPU Studio and keeps the PC as the source of truth. It does not use GitHub, a payment method, a domain, or a public PC SSH service.

## 1. Prerequisites

Install and authenticate the Lightning CLI on the PC:

```bash
python3 -m pip install --user lightning-sdk
export PATH="$HOME/.local/bin:$PATH"
lightning login
```

Choose an existing teamspace and set its exact owner and name:

```bash
export NAUTILUS_STUDIO_NAME="nautilus"
export NAUTILUS_TEAMSPACE="owner/teamspace"
```

Create or start a free CPU Studio without prompts:

```bash
lightning studio create \
  --name "${NAUTILUS_STUDIO_NAME}" \
  --teamspace "${NAUTILUS_TEAMSPACE}" \
  --machine CPU
lightning studio start \
  --name "${NAUTILUS_STUDIO_NAME}" \
  --teamspace "${NAUTILUS_TEAMSPACE}" \
  --machine CPU
```

Open the Studio and place the repository at its persistent home path. Do not place it under `node_modules` or another regenerated directory.

## 2. Expose only the gateway

The runner, PWA, and OpenCode bridge share gateway port `8080`. Previews use the gateway's second listener on port `8081`, which serves the running project at the root of its own origin, so a previewed app needs no base path. Do not expose the raw server, web, OpenCode, or project dev-server ports.

From the PC, install or update the Lightning SDK and configure the proven port mapping:

```bash
python3 -m pip install --user --upgrade lightning-sdk
python3 - <<'PY'
import os
from lightning_sdk import Studio

studio = Studio(
    os.environ["NAUTILUS_STUDIO_NAME"],
    teamspace=os.environ["NAUTILUS_TEAMSPACE"],
)
print(studio.add_ports({"nautilus": 8080, "nautilus-preview": 8081}))
PY
```

Copy the public HTTPS URL printed by the Studio port UI or SDK for port 8080 into `NAUTILUS_PUBLIC_URL` below. Both ports must be exposed, but the preview URL does not need to be configured: the runner derives it from the host the phone used, swapping `8080-` for `8081-`. Set `NAUTILUS_PREVIEW_URL` only if the preview port is published somewhere else. A newly created port can return a provider-generated 404 for about a minute.

## 3. Configure the Studio

Run these commands in the Studio terminal:

```bash
cd /path/to/nautilus
chmod +x scripts/*.sh .lightning_studio/on_start.sh
umask 077
mkdir -p "$HOME/nautilus/secrets" "$HOME/nautilus/logs" "$HOME/nautilus/run"
```

There is no admin token. On first boot the server creates its own auth secret in `$HOME/nautilus/secrets/auth-secret` (mode `0600`). That secret signs phone sessions and preview tokens and never leaves the Studio.

`$HOME/nautilus/secrets/nautilus.env` is optional. Use it for the public URL, model-provider keys, and overrides:

```bash
printf 'NAUTILUS_PUBLIC_URL=%q\n' 'https://replace-with-the-lightning-port-url' >> "$HOME/nautilus/secrets/nautilus.env"
printf 'NAUTILUS_DEV_SERVER_RESTART=%q\n' 'auto' >> "$HOME/nautilus/secrets/nautilus.env"
chmod 600 "$HOME/nautilus/secrets/nautilus.env"
```

The desktop app registers projects, so no project file is needed. The runner places each project in `$HOME/nautilus/projects/<id>` and gives it a free dev-server port from `NAUTILUS_DEV_PORT_RANGE` (default `3100-3199`). `NAUTILUS_PROJECTS_FILE` still works if you want projects that exist before any desktop connects.

A Studio configured before this change may still have `NAUTILUS_ADMIN_TOKEN`, `NAUTILUS_SYNC_IDENTITY_ID`, and `NAUTILUS_SYNC_SIGNING_KEY_PATH` in `nautilus.env`. They are ignored and can be deleted. Keep `NAUTILUS_AUTH_SECRET` if it is set, so that phones that are already linked stay signed in.

Install Node, the pinned OpenCode package, and locked workspace dependencies:

```bash
./scripts/install-opencode.sh
```

Run startup once and inspect both logs if it fails:

```bash
./.lightning_studio/on_start.sh
```

`on_start.sh` appends to `~/nautilus/logs/server.log` and `~/nautilus/logs/web.log`; it does not truncate them. It builds the runner and the PWA first, then starts both from that output — a boot runs the same code a release does, not a dev server. The PWA's build is where its `/api` and `/health` rewrites are fixed to the API origin, so a change to `NAUTILUS_SERVER_PORT` needs a rebuild to take effect. It then starts these listeners:

- The API on `127.0.0.1:4000`, behind the public gateway on port 8080.
- The control API on `127.0.0.1:4001`. The gateway never routes to it.

After server recovery finishes shadow validation, the script starts a dev server only when exactly one project is eligible for automatic restart. Projects marked `unhealthy` are never started or served.

## 4. Connect the desktop app

On the PC, configure Lightning SSH once:

```bash
lightning ssh configure \
  --name "${NAUTILUS_STUDIO_NAME}" \
  --teamspace "${NAUTILUS_TEAMSPACE}"
```

This creates `~/.ssh/lightning_rsa` and a `Host` entry for `s_<studio-id>@ssh.lightning.ai`. That key is the PC's only credential. The desktop app uses it for two connections:

- A local forward to the Studio's control API on `127.0.0.1:4001`, held open while the app runs.
- A reverse forward that exposes the PC sync agent on the Studio's `127.0.0.1:4200`, open only during a sync.

The app runs SSH with `-F /dev/null`, so the host alias is not used and local SSH config cannot clear the forwards.

Open the desktop app and go to Settings › Runner:

1. Enter the Studio's public URL. It is used for the phone link.
2. Press **Detect** to read the SSH user and host from `~/.ssh/config`.
3. Press **Save and connect**. Settings are saved only if the connection works.

The app writes these settings to `~/.nautilus/config.json`, and nothing else. It keeps projects and recent folders in `~/.nautilus/state.json`.

The desktop app starts the PC sync agent itself (`node`, version 24 or newer, must be on the `PATH`). The agent binds to `127.0.0.1:4100` and exits when the app closes. On each launch it receives a new key on stdin. For every pull or push, the app has the agent mint a grant for that project and direction, valid for at most 10 minutes. The Studio has to present that grant to the agent through the reverse tunnel, and the app revokes it when the sync ends. The agent has no configuration file.

## 5. Test the reverse tunnel by hand

For debugging without the desktop app, start an agent with a known development key, then the tunnel:

```bash
pnpm --filter @nautilus/sync-agent build
export NAUTILUS_AGENT_LAUNCH_KEY="$(openssl rand -hex 32)"
node apps/sync-agent/dist/cli.js &

export NAUTILUS_SSH_TARGET='ssh.lightning.ai'
export NAUTILUS_SSH_USER='s_replace_with_studio_id'
export NAUTILUS_SSH_KEY="$HOME/.ssh/lightning_rsa"
./scripts/start-tunnel.sh
```

The script keeps the tunnel in the foreground and writes to `~/.local/state/nautilus/logs/tunnel.log`. It checks the remote forward with a second SSH connection that runs a fixed `curl /health` on the runner.

## 6. Exercise the grant protocol

On the PC, mint a pull grant from that agent:

```bash
./scripts/mint-grant.sh demo pull
```

Then, in the Studio terminal, while the tunnel is up:

```bash
export NAUTILUS_SYNC_GRANT='paste-the-grant'
export NAUTILUS_SYNC_PROJECT_ID='demo'
export NAUTILUS_SYNC_REMOTE_HEAD='replace-with-full-runner-checkpoint-git-object-id'
./scripts/test-sync.sh
```

The test sends fresh, non-replayed envelopes and runs `health`, `state`, and `preflight`. A preflight result of `ok` or `conflict` counts as a successful exercise. `stale`, `failed`, and `invalid` results fail the test. It never applies a merge. A grant for another project or direction, an expired or revoked grant, and a grant minted with a different key are all refused by the PC.

## 7. Verify restart recovery

Run this from the PC, not from the Studio that it stops. The script reads admin routes on the Studio over the same SSH key the desktop uses:

```bash
export NAUTILUS_LIGHTNING_BIN="$(command -v lightning)"
export NAUTILUS_STUDIO_NAME='nautilus'
export NAUTILUS_TEAMSPACE='owner/teamspace'
export NAUTILUS_PUBLIC_URL='https://replace-with-the-lightning-port-url'
export NAUTILUS_SSH_TARGET='s_replace_with_studio_id@ssh.lightning.ai'
export NAUTILUS_VERIFY_PROJECT_ID='demo'
./scripts/verify-restart.sh
```

The script stops and starts the Studio non-interactively, waits for gateway readiness, checks the PWA, and verifies that interrupted projects and running sessions are no longer presented as active. It preserves CLI output in `~/.local/state/nautilus/logs/verify-restart.log`.

The four-hour provider recycle remains a separate observation. Run the same verification after the first natural restart and retain the timestamp, readiness duration, project state, session state, and logs.
