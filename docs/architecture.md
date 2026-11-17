# Architecture

Nautilus lets you steer a coding agent from your phone while your code stays on your PC. There are three places code runs, each with one job.

- **The gateway** is the Next.js app in `apps/web`, deployed on Vercel. It serves the PWA, owns identity (phones, pairing codes, the desktop's admin token) in Postgres, and forwards every other API call to the runner. It wakes the runner when it is asleep.
- **The runner** is `apps/runner`, running inside one persistent Vercel Sandbox. It runs OpenCode, keeps each project's files and shadow repository, records agent sessions and their events, and holds the runner's side of sync.
- **The PC** runs the desktop app. It links phones, registers project folders and moves changes between the PC and the runner, always with a review first.

The PC does not need to be online while the agent works. It only needs to be online to sync.

## Processes and ports

```text
phone (PWA) ──cookie──┐
                      v
desktop ──Bearer───> gateway: Vercel functions (apps/web)
                      |  Postgres (Neon): phone devices, pairing codes, rate limits
                      |
                      |  x-nautilus-runner-key + x-nautilus-principal
                      v
                 runner: Vercel Sandbox "nautilus-runner", port 4000 (apps/runner)
                      |  OpenCode 127.0.0.1:4096, started and supervised by the runner
                      |  registry, projects, shadow repositories under ~/nautilus
                      ^
                      |  long-poll relay, direct to the sandbox's HTTPS domain
PC sync agent ────────┘  (only while a sync is open, with a relay token)
```

## The sandbox lifecycle

The runner lives in one named, persistent sandbox. On the Hobby plan a sandbox session lasts at most 45 minutes. When it stops, Vercel snapshots the filesystem, and the next session resumes from that snapshot, so the registry, the projects, the shadow repositories and OpenCode's state (including `auth.json`) survive. Processes do not.

The gateway's `ensureRunner()` (`apps/web/lib/runner/`) does this on demand:

1. `Sandbox.getOrCreate({ name: "nautilus-runner", persistent: true, ports: [4000] })`.
2. Ask the runner's `GET /health` for its version. If it answers with the version the gateway was built with, it is ready.
3. Otherwise write the runner bundle (built into `apps/web/runner-dist/` at build time) to `/vercel/sandbox/nautilus-runner/`, run `npm install --omit=dev` there when its `package.json` changed, stop any old runner process, and start `node main.js` detached with the runner environment below.
4. Wait for `/health` to report the new version.

`/api/bootstrap` does not block on a cold start. It answers at once with `lifecycle.state: "starting"` and keeps waking the runner after the response, and the phone polls until the runner is `ready`. Other calls wait up to about a minute, then answer `503 runner_starting`.

A turn still running when a session hits its 45-minute cap is cut off. The runner treats the next boot as a recycle (see Restarts) and the turn shows as interrupted, never as finished.

## Gateway → runner contract

The runner listens on `0.0.0.0:${NAUTILUS_PORT:-4000}`. The sandbox domain is public, so the runner checks every request:

| Header                  | Meaning                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `x-nautilus-runner-key` | Must equal `NAUTILUS_RUNNER_KEY` (timing-safe compare). Otherwise `401 runner_unauthorized`.               |
| `x-nautilus-principal`  | `admin` for the desktop, or `device:<uuid>` for a phone the gateway has authenticated. Anything else: 401. |

`admin` maps to the runner's old control channel: every route, including the admin-only ones. `device:<id>` maps to the public channel, so admin-only routes answer 404. The runner keeps no phone credentials of its own. The gateway checks revocation on every request.

Only two things skip the runner key: `GET /health` (answers `{ status, service, version, lifecycle }` and nothing else), and the relay routes below, which take a relay token instead.

The runner's environment:

| Variable                      | Purpose                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `NAUTILUS_RUNNER_KEY`         | Shared secret with the gateway, derived as `HMAC-SHA256(NAUTILUS_AUTH_SECRET, "nautilus-runner-key")`, base64url. |
| `NAUTILUS_RUNNER_VERSION`     | The build's runner version, echoed by `/health`.                                                                  |
| `NAUTILUS_PORT`               | Listen port, default 4000.                                                                                        |
| `NAUTILUS_OPENCODE_AUTH_JSON` | Optional. When set, written to OpenCode's `auth.json` at boot, replacing `opencode auth login`.                   |

The API paths and bodies are the ones in `packages/types`, unchanged from the v0.2.0 runner, except that device, pairing and sign-out routes now live in the gateway.

## Gateway routes

Handled by the gateway itself, against Postgres:

| Route                            | Access          | Notes                                                                                                                      |
| -------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/pairing-codes`        | admin           | `{ deviceName?, ttlSeconds? }` → `PairingCodeResponse`                                                                     |
| `POST /api/pairing-codes/redeem` | public          | `{ code, deviceName }` → `{ device }`, sets the session cookie. Rate limited per IP in Postgres before anything else runs. |
| `POST /api/auth/sign-out`        | public          | Clears the cookie.                                                                                                         |
| `GET /api/devices`               | admin           | `{ devices: DeviceResponse[] }`                                                                                            |
| `POST /api/devices/:id/revoke`   | admin           | `{ revoked: true }`                                                                                                        |
| `POST /api/control/relay`        | admin           | Wakes the runner and returns `{ url, token, expiresAt }` for the sync relay.                                               |
| `GET /api/bootstrap`             | device or admin | Runner's bootstrap with `device` filled in by the gateway, or a `starting` placeholder while the runner wakes.             |

Everything else under `/api/*`, and `/health`, is forwarded to the runner with the headers above. Event streams (`text/event-stream`) are piped through and closed before the function's time limit; the phone reconnects with `?after=<last sequence>`.

Auth:

- **Desktop:** `Authorization: Bearer <NAUTILUS_ADMIN_TOKEN>`, compared timing-safe.
- **Phone:** the `nautilus_session` cookie, an HS256 JWT signed with `NAUTILUS_AUTH_SECRET`, renewed daily and valid until revoked or signed out. The gateway checks the signature first, so a request without a valid one never touches Postgres or the runner.
- **CSRF:** every non-GET cookie request needs a same-origin `Origin` and `X-Nautilus-Request: 1`.

## The sync relay

The runner drives sync, as it always has, but it cannot reach the PC. While a sync is open the PC's sync agent reaches out instead, straight to the sandbox's HTTPS domain. That avoids the gateway's request body and duration limits, so bundles of any allowed size pass.

1. The desktop calls `POST /api/control/relay` and hands `{ url, token }` to its local agent (`POST /v1/relay`, launch-key protected).
2. The agent long-polls `GET {url}/relay/next` with `Authorization: Bearer <token>`. The runner holds the poll for up to 25 seconds and answers `204` when there is nothing, or `200` with one request: the body as the request's raw bytes, and headers `x-relay-id`, `x-relay-method`, `x-relay-path` and `x-relay-headers` (base64url JSON).
3. The agent replays it against its own `http://127.0.0.1:<port><path>` and posts the answer to `POST {url}/relay/responses/<id>`: raw body bytes, with `x-relay-status` and `x-relay-headers`.
4. On the runner, `TunnelSyncClient` takes this transport in place of `fetch`, so the sync protocol (see [sync-protocol.md](sync-protocol.md)) is unchanged: grants, digests and bundle headers all pass through untouched.
5. `GET /api/tunnel-health` answers 200 while a poll arrived in the last 30 seconds. When the sync ends the desktop calls `POST /v1/relay/stop` on its agent and revokes the grant.

A relay token is `<expiresAtMs>.<base64url(HMAC-SHA256(NAUTILUS_RUNNER_KEY, "relay." + expiresAtMs))>`, valid 15 minutes. It only opens the relay routes, and the relay can only carry requests the runner makes, each of which the agent checks against a grant the runner cannot mint.

## Code layout

| Path                  | What it is                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web`            | The PWA and the gateway. `app/api/` holds the gateway's routes and the catch-all forward, `lib/server/` auth and Postgres, `lib/runner/` the sandbox.                    |
| `apps/runner`         | The runner. `app.ts` boots it, `routes/` is the API as a route table, `sync.ts` is the runner's side of sync, `relay.ts` the sync relay, `sessions.ts` bridges OpenCode. |
| `apps/desktop`        | The Tauri app. `src/store/` holds its slices, `src/lib/` the agent and API clients, `src-tauri/` the shell: tray, plugins and the capability file.                       |
| `apps/sync-agent`     | The PC's side of sync. `operations.ts` holds the transaction logic, `grants.ts` the per-sync grants, `relay.ts` the relay poller, `cli.ts` the program.                  |
| `packages/shadow-git` | The shadow repository wrapper and the durable-file helpers (atomic JSON, locks, pruning) that the runner and the agent share.                                            |
| `packages/types`      | Wire types shared by every side.                                                                                                                                         |
| `packages/brand`      | The logo, colors and icon generator.                                                                                                                                     |

## Trust boundaries

**Phone to gateway.** A phone links once with a single-use pairing code that the desktop creates, as text or as a QR code. Redeeming it sets an httpOnly session cookie. Postgres stores only a hash of each code, and the desktop can revoke a phone at once.

**Desktop to gateway.** The desktop holds the admin token in `~/.nautilus/config.json` (mode 0600). Admin routes, such as registering projects, creating pairing codes, revoking phones and syncing, need it. A phone asking for one gets a 404.

**Gateway to runner.** Only the gateway knows the runner key, and the runner trusts the principal header only alongside it.

**Runner to PC.** The runner can reach the PC's agent only while a sync is open, only through the relay the agent itself opened, and only with a grant. The desktop starts the agent with a fresh random launch key on stdin. For each sync it asks the agent for a grant bound to one project and one direction, valid for ten minutes at most and signed with that key. A push grant cannot call `apply`, so a push can never write to the PC. The desktop revokes the grant and stops the relay when the sync ends.

**OpenCode and secrets.** OpenCode runs as the runner's own user. When the sandbox allows unprivileged user namespaces, the runner starts it inside bubblewrap, where the secrets folder is an empty tmpfs. The runner key and `NAUTILUS_OPENCODE_AUTH_JSON` are removed from OpenCode's environment. Each prompt tells the agent the names of the preview's keys, never their values, and the runner redacts stored values from OpenCode's output.

**Previews** are off (`NEXT_PUBLIC_NAUTILUS_PREVIEW_ENABLED`) until the gateway can serve a sandbox port safely.

## Where state lives

Postgres (gateway): `nautilus_devices`, `nautilus_pairing_codes`, `nautilus_rate_limits`. The schema is in `apps/web/lib/server/db.ts` and applied idempotently by each function instance on first use. `nautilus_runner_lease` makes sure only one function starts the runner at a time.

Runner, under `~/nautilus/` in the sandbox:

| Path                | Contents                                                                               |
| ------------------- | -------------------------------------------------------------------------------------- |
| `registry.sqlite`   | Projects, preview tokens, agent sessions and their event logs.                         |
| `secrets/projects/` | Each project's preview values, one 0600 file per project, written only by the desktop. |
| `projects/<id>/`    | The project's files, where the agent works.                                            |
| `shadow/<id>.git`   | The project's shadow repository.                                                       |
| `sync-state/<id>/`  | The sync base, sync history, transactions, recovery records and cached results.        |
| `journal.jsonl`     | The lifecycle journal.                                                                 |
| `opencode/state/`   | OpenCode's data, config and cache directories.                                         |

PC, under `~/.nautilus/`:

| Path                                  | Contents                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `config.json`                         | The gateway URL, the admin token, and the folders to search.                                       |
| `state.json`                          | The projects, recent folders and folder-scan cache. The agent reads projects from it.              |
| `shadow/<id>.git`                     | The PC's shadow repository for each project.                                                       |
| `runners/<runner>/transactions/<id>/` | The sync base, history, transactions, preflights and cached responses, kept apart for each runner. |
| `runners/<runner>/backups/<id>/`      | A bundle of the PC's state before each pull. The last three are kept.                              |

Neither side ever touches the project's own `.git`.

## Restarts

Every sandbox session ends within 45 minutes, so Nautilus treats a resume as a full recycle. When the gateway restarts the runner, it recovers in this order:

1. Open the registry and mark projects that were starting or running as interrupted.
2. Roll back any sync transaction that did not commit.
3. Check every shadow repository. A project whose repository fails its check, whose files differ from the last checkpoint, or whose last checkpoint was cut short is marked unhealthy and left alone.
4. Start OpenCode, and mark sessions that were mid-turn as interrupted so the phone can retry them.
5. Report `ready`, or `degraded` when any project is unhealthy.

The phone reconnects on its own, loads a snapshot, and resumes the event stream from the last sequence it saw.

## Local development

`pnpm dev:local` runs the runner on `127.0.0.1:4000`, the gateway with the PWA on `:4002` and the desktop app. With `NAUTILUS_RUNNER_URL=http://127.0.0.1:4000` set, the gateway skips the sandbox and forwards to that runner, and the relay uses the same URL. `NAUTILUS_RUNNER_KEY`, when set, replaces the key the gateway derives from the auth secret, so a runner started by hand can share it. The gateway still needs `DATABASE_URL`.

## Deploying

The Vercel project builds `apps/web`. Its build bundles the runner into `apps/web/runner-dist/`, which ships with the API functions. Set these in the project's environment:

| Variable                      | Purpose                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- |
| `NAUTILUS_AUTH_SECRET`        | 32+ characters. Signs phone sessions and derives the runner key.           |
| `NAUTILUS_ADMIN_TOKEN`        | 32+ characters. The desktop's token; paste it into the desktop's settings. |
| `DATABASE_URL`                | The Neon connection string (the Neon integration sets it).                 |
| `NAUTILUS_OPENCODE_AUTH_JSON` | Optional. OpenCode's `auth.json`, so the agent can reach its provider.     |

The functions reach Vercel Sandbox with the project's OIDC token, which Vercel provides on its own.
