# Nautilus

[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](./LICENSE)

**Run a coding agent from your phone. Bring the work home to your PC.**

Nautilus pairs an installable phone PWA with a free cloud runner. You prompt an agent, watch it work and check a live preview of the result, from a phone, on a train, with your laptop closed. Back at your desk, a desktop app shows you a real diff and merges the agent's work into your project. It never touches your `.git` directory.

The whole thing runs on infrastructure that costs nothing. There is no credit card, no domain, no Docker and no paid VM, and one public HTTPS port carries the app, the API and the preview.

```
   phone (PWA)                        free cloud runner                     your PC
  ┌────────────┐                ┌───────────────────────────┐          ┌──────────────┐
  │  chat      │  HTTPS :8080   │  gateway ─┬─ PWA   :3000  │          │  Tauri app   │
  │  preview   │◄──────────────►│           ├─ API   :4000  │          │      ▲       │
  │  history   │   (one origin) │           ├─ ctrl  :4001 ◄┼──────────┤  local fwd   │
  └────────────┘                │           └─ prev  :8081  │  SSH     │      │       │
                                │             opencode 4096 │          │  ┌───────────┤
                                │             dev srv  31xx │          │  │ sync-agent│
                                │            shadow git repo│◄─────────┼──┤ 127.0.0.1 │
                                └───────────────────────────┘  rev SSH │  │ :4100     │
                                                                    └──┴──┴───────────┘
```

## The idea

A phone is a good place to _ask_ for work and a bad place to _review_ it. So Nautilus splits the job.

| On the phone                                   | On the PC                                           |
| ---------------------------------------------- | --------------------------------------------------- |
| Pick a project and send a prompt               | Keep the real project and its Git history           |
| Stream the agent's turn as it happens          | See a real content diff before anything changes     |
| Approve or deny the commands it asks to run    | Pull, push, or choose a side per conflicting file   |
| Watch a live preview with HMR                  | Compare both versions of a conflict, open an editor |
| See each turn's changed files, and undo a turn | Undo the last pull                                  |
| Lock the screen and get told when it's done    | Get a notification when the runner has new work     |

The PC does **not** need to be online while the agent works. It only has to be reachable when you ask it to sync.

On the phone you can also pick the model and, for models that have them, the reasoning effort. A meter shows how full the context is, and every reply shows its tokens and cost.

## How it holds up

Most of the engineering here is about what happens when things go wrong. The details are in [docs/architecture.md](./docs/architecture.md) and [docs/sync-protocol.md](./docs/sync-protocol.md). Here are the parts worth reading first.

### The provider recycles the machine every four hours

A free Lightning Studio restarts on a timer. Nautilus treats that as a full recycle, not a hiccup.

- `node_modules` does not come back, so `.lightning_studio/on_start.sh` reinstalls Node and every dependency on every boot. The script takes an `flock`, so a double boot cannot race. It will not kill a PID whose `/proc/<pid>/cwd` is not the repo, so a recycled PID is never mistaken for one of ours.
- A file written just before a restart can come back older, or truncated. So on boot the runner checks each project's shadow repository and compares the folder with its last checkpoint. A project that fails is marked `unhealthy` and is not started, served or synced. Serving a restored tree as if it were current would be worse than refusing.
- A turn that was running is never reported as finished. It becomes `interrupted`, and the phone offers a retry.

### Your Git is not the agent's memory

The agent's work needs history, checkpoints, three-way merges and undo. Your own branches, hooks and remotes must stay out of it. So each side keeps a **shadow repository**, a bare Git directory whose worktree is the real project folder. Your `.git` is never read or written.

- **Sync is incremental.** A `git bundle` carries only the commits after the last shared base. It is checked by SHA-256 and for ancestry before it is imported.
- **Merges are preflighted.** `git merge-tree` merges both sides before anything is written. A conflict applies nothing, not even partly. You pick a side per file and apply again.
- **Applies are transactional.** A transaction record and a recovery bundle are written before the first file changes. An interrupted apply is rolled back on the next start and never reported as synced.
- **What Git cannot round-trip is refused.** Symlinks, submodules, `.gitmodules`, Git LFS pointers and oversized files fail with a clear error. Dependencies, caches and `.env` files stay out. A nested checkout stays out too, and the desktop tells you once.
- **Every agent turn is a checkpoint.** The phone lists the files each turn changed and can undo one turn while keeping the ones after it, the way `git revert` does. An undo is a checkpoint too, so it can be undone.

### The PC holds no credential for the runner

There is nothing on a laptop to steal and nothing to rotate.

- **The PC dials out.** A local SSH forward reaches the runner's control API while the app runs. A reverse forward exposes the PC's sync agent only during a sync. There is no public SSH daemon and no inbound port on your machine.
- **The capability file is the desktop's security boundary.** The app can start exactly three programs, each with argument validators: `ssh` with a loopback-only local forward, `ssh` with one fixed reverse forward, and the sync agent binary that ships inside the app. The agent is a Node single executable, so the PC needs no Node install. The app reads only `~/.nautilus/**`, `~/.ssh/config` and `package.json` files, and makes HTTP requests only to `127.0.0.1`.
- **The PC mints the grants.** For each pull or push the agent signs a grant for one project and one direction, capped at 10 minutes whatever the UI asks for. The runner forwards it and cannot make one. A push grant cannot call `apply`, so a push never writes to the PC.
- **The launch key dies with the app.** The agent reads a 32-byte key from stdin and exits when the desktop closes that pipe. Restart the app and every earlier grant stops working.
- **Little Rust.** `main.rs` registers plugins and owns what a web page cannot: the tray icon, hiding to the tray on close and keeping one instance. All sync policy lives in the capability manifest and TypeScript.

### The edge proxy is hostile

The Lightning port proxy rewrites every cookie to `SameSite=None` and adds `access-control-allow-origin: *` to every response. The app's own cookie policy buys nothing, and any site can send requests that carry the session cookie. So:

- Every write to `/api/*` needs an `Origin` that matches the public origin and an `X-Nautilus-Request: 1` header, which a cross-site form cannot set.
- The gateway strips the proxy's permissive CORS headers.
- Admin routes return 404 on the public listener, so a scanner cannot confirm they exist. They live only on the loopback control listener, which also requires a loopback `Host`, to defeat DNS rebinding, and an `X-Nautilus-Control: 1` header.
- Preview links redeem only on `POST`. A link-preview crawler that fetches a shared URL with `GET` gets a page with a button and cannot use up the one-time token.
- Sign-in, pairing, prompts and project control are rate limited, and every secret comparison uses `timingSafeEqual`.

### The phone loses its connection, often

Prompts are `POST`, which rules out `EventSource`. The PWA uses a streaming `fetch` with its own SSE parser, and the server sends a heartbeat every 25 seconds. Every event has a sequence number. A reconnecting phone loads a snapshot and resumes from the last sequence it saw. In testing, about one in ten WebSocket handshakes through the proxy was reset, so the client reconnects on its own.

## Repository layout

```
apps/
  server/       @nautilus/server      the runner: gateway, API, registry, OpenCode bridge,
                                       sync coordinator, restart recovery
  web/          @nautilus/web         the phone PWA (Next.js App Router, Tailwind, Astryx)
  desktop/      @nautilus/desktop     the Tauri app: tunnels, phone linking, diff review, tray
  sync-agent/   @nautilus/sync-agent  the PC's loopback agent that answers sync requests
packages/
  shadow-git/   @nautilus/shadow-git  the shadow repository and durable-file helpers
  types/        @nautilus/types       the shared wire types
  copy/         @nautilus/copy        the words a person reads, keyed by the state they describe
  brand/        @nautilus/brand       logo, colors and icon generation
docs/
  architecture.md   processes, ports, trust boundaries, where state lives, restarts
  sync-protocol.md  shadow repositories, pull, push, checkpoints, undo, recovery
```

The gateway is the only thing that should ever be public.

|      Port | Process     | Purpose                                                                                                |
| --------: | ----------- | ------------------------------------------------------------------------------------------------------ |
|      8080 | gateway     | **The only public listener.** `/api/*` to the API, `/preview/*` to the dev server, the rest to the PWA |
|      8081 | gateway     | Preview origin, so a previewed app needs no base path                                                  |
|      4000 | server      | The API (loopback)                                                                                     |
|      4001 | server      | The control API (loopback only, never routed by the gateway)                                           |
|      3000 | web         | The PWA (loopback)                                                                                     |
|      4096 | OpenCode    | The agent, with its own data directory (loopback)                                                      |
| 3100-3199 | per project | The project's own dev server                                                                           |
|      4100 | sync agent  | The PC's loopback agent, started by the desktop app                                                    |
|      4200 | (forward)   | The port on the runner that the reverse forward connects to the PC's agent                             |

## Self-hosting

The runner is a Node process behind an HTTP proxy, so anywhere that gives you one public HTTPS port and an SSH endpoint works. A free Lightning AI CPU Studio is the tested path and what the scripts target.

### Prerequisites

- Node **24.15.0 or newer** and pnpm **10.28.1** (through corepack)
- `git`, `curl`, `flock`, `setsid`, `openssl`
- A model provider OpenCode can sign in to. A free tier with no card is fine.
- For building the desktop app: Rust, the [Tauri 2 prerequisites](https://tauri.app) for your OS, and `openssh-client`

```bash
corepack enable
pnpm install
./scripts/install-opencode.sh   # Node and the pinned OpenCode build, SHA-256 checked
```

### Option A: everything on one machine

The fastest way to see it work. This starts the server, the PWA and the Tauri app together, and the first run writes a `.env.local` for you.

```bash
pnpm dev:local
```

Local mode skips SSH and tunnels, turns off secure cookies and reaches the sync agent directly on `127.0.0.1:4100`. The phone link in the desktop app points at `http://127.0.0.1:3000`. To use a real phone on the same network, open it through the LAN preview listener.

To run the pieces yourself:

```bash
pnpm dev            # turbo: server, PWA and desktop frontend
pnpm dev:server     # the runner only, with reload
pnpm dev:web        # the PWA only
pnpm --filter @nautilus/desktop tauri:dev   # the real Tauri shell
```

### Option B: the runner on a Lightning AI Studio

This is the intended deployment. The full steps are in [`scripts/bootstrap-lightning.md`](./scripts/bootstrap-lightning.md). In short:

**1. Create a free CPU Studio and expose only the gateway.**

```bash
python3 -m pip install --user lightning-sdk
lightning login
export NAUTILUS_STUDIO_NAME="nautilus"
export NAUTILUS_TEAMSPACE="owner/teamspace"

lightning studio create --name "$NAUTILUS_STUDIO_NAME" \
  --teamspace "$NAUTILUS_TEAMSPACE" --machine CPU
lightning studio start  --name "$NAUTILUS_STUDIO_NAME" \
  --teamspace "$NAUTILUS_TEAMSPACE" --machine CPU
```

Expose **8080 and 8081 only**. Never expose 4000, 4001, 3000, 4096 or a project's dev port. A new port can return Lightning's 404 for about a minute.

**2. Put the repo in the Studio's persistent home** and configure it:

```bash
cd /path/to/nautilus
chmod +x scripts/*.sh .lightning_studio/on_start.sh
umask 077
mkdir -p "$HOME/nautilus"/{secrets,logs,run}

cat > "$HOME/nautilus/secrets/nautilus.env" <<'ENV'
NAUTILUS_PUBLIC_URL=https://<your-lightning-port-url>
NAUTILUS_DEV_SERVER_RESTART=auto
ENV
chmod 600 "$HOME/nautilus/secrets/nautilus.env"
```

There is no admin token to set. On first boot the runner writes its own secret to `$HOME/nautilus/secrets/auth-secret` (mode `0600`). It signs phone sessions and preview links and never leaves the Studio. Set `NAUTILUS_AUTH_SECRET` (32 characters or more) yourself only if linked phones should survive losing that file.

**3. Sign a model provider in to the runner's OpenCode.** The server starts `opencode serve` with its own `XDG_*` directories, so the credentials must go there:

```bash
XDG_DATA_HOME="$HOME/nautilus/opencode/state" \
XDG_CONFIG_HOME="$HOME/nautilus/opencode/state/config" \
XDG_CACHE_HOME="$HOME/nautilus/opencode/state/cache" \
  opencode auth login
```

The phone's model picker lists whatever the provider's catalog reports.

**4. Boot it.** Lightning runs `on_start.sh` at every start. Run it by hand the first time to see any failure. It builds the runner and the PWA, then starts both from their build output, and logs to `~/nautilus/logs/server.log` and `web.log`.

```bash
./scripts/install-opencode.sh
./.lightning_studio/on_start.sh
```

Then check `https://<your-lightning-port-url>/health/ready`.

**5. Connect the PC.** Set up the Lightning SSH key once. It is the PC's only credential.

```bash
lightning ssh configure --name "$NAUTILUS_STUDIO_NAME" --teamspace "$NAUTILUS_TEAMSPACE"
```

Then in the desktop app, open **Settings › Runner**, paste the public URL, press **Detect** to read the SSH user and host from `~/.ssh/config`, and press **Save and connect**. The app saves the settings only once the connection works.

### Checking a deployment

```bash
curl -fsS https://<url>/health/ready          # runner and PWA both up
./scripts/preview-url.sh demo                 # a one-time preview link
./scripts/verify-restart.sh                   # stop and start the Studio, check recovery
./scripts/collect-facts.sh                    # host facts for debugging
```

`verify-restart.sh` cycles the Studio and checks that no session was lost, that a session that was `running` is now `interrupted`, and that a project that was running comes back `running`, `unhealthy`, or `error` with `runner_restarted`. It is never quietly presented as active.

The four-hour recycle is a separate check. Run the same script after the first natural restart and note the times.

## Configuration

Everything has a working default. The settings worth knowing:

| Variable                         | Default                 | Meaning                                                                   |
| -------------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| `NAUTILUS_AUTH_SECRET`           | generated on first boot | Signs phone sessions and preview links. **Set it to keep phones linked.** |
| `NAUTILUS_PUBLIC_URL`            | derived per request     | The public origin, used in phone and preview links                        |
| `NAUTILUS_GATEWAY_PORT`          | `8080`                  | The public listener                                                       |
| `NAUTILUS_PREVIEW_PORT`          | _(unset)_               | Turns on the preview origin listener (the Studio uses `8081`)             |
| `NAUTILUS_SECURE_COOKIES`        | `true`                  | Set `false` only for plain-HTTP local development                         |
| `NAUTILUS_PROJECTS_ROOT`         | `~/nautilus/projects`   | Where the runner keeps each project                                       |
| `NAUTILUS_DEV_PORT_RANGE`        | `3100-3199`             | Ports for project dev servers                                             |
| `NAUTILUS_PROJECTS_FILE`         | _(unset)_               | A JSON file of projects that exist before any desktop connects            |
| `NAUTILUS_DEV_SERVER_RESTART`    | `auto`                  | Whether boot may restart a project it found healthy                       |
| `NAUTILUS_SYNC_MAX_FILE_BYTES`   | `10 MB`                 | Largest file a sync carries                                               |
| `NAUTILUS_SYNC_MAX_TOTAL_BYTES`  | `100 MB`                | Largest project a sync carries                                            |
| `NAUTILUS_SYNC_MAX_FILE_COUNT`   | `10 000`                | Most files a sync carries                                                 |
| `NAUTILUS_LOG_FORMAT` / `_LEVEL` | `json` / `debug`        | `pretty` gives a readable terminal log                                    |

`scripts/dev-local.sh` writes a working `.env.local` for local mode.

## Development

```bash
pnpm test        # 243 tests
pnpm lint        # eslint, one flat config for the whole workspace
pnpm typecheck
pnpm format      # oxfmt
pnpm build
pnpm --filter @nautilus/desktop tauri:build   # the packaged app, with the sync agent inside
```

The tests lean on the parts where correctness is not obvious: shadow repository policy and merge semantics, transaction rollback, undoing a pull on both sides, grants and their refusals, CSRF and origin checks, gateway routing and WebSocket upgrades, restart recovery, the desktop's review flow, SSH argument building, and stream reconnection. Sync tests run against real Git repositories, not mocks, which is why the suite allows each test 20 seconds.

```bash
pnpm vitest run apps/server/test          # one package
pnpm test:watch                           # watch mode
```

`lint` and `test` run once from the repository root rather than per package; `typecheck` and `build` stay per package, because each has its own tsconfig and dependency order.

See [CONTRIBUTING.md](./CONTRIBUTING.md) before sending a change.

## License

[GPL-3.0](./LICENSE).
