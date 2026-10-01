# Architecture

Nautilus lets you steer a coding agent from your phone while your code stays on your PC. There are three machines, each with one job.

- **The runner** is a Lightning AI Studio. It runs OpenCode, the project's dev server, the API and the PWA.
- **The phone** runs the PWA. It sends prompts, answers permission requests, watches the preview and can undo a turn.
- **The PC** runs the desktop app. It links phones, registers project folders and moves changes between the PC and the runner, always with a review first.

The PC does not need to be online while the agent works. It only needs to be online to sync.

## Processes and ports

```text
Lightning public HTTPS port
          |
          v
  gateway 127.0.0.1:8080 ----- /api/*      -> API        127.0.0.1:4000
          |                    /preview/*  -> dev server 127.0.0.1:3100-3199
          |                    everything else -> PWA    127.0.0.1:4002
          |
  preview listener (optional, NAUTILUS_PREVIEW_PORT): the active project at /

  control API 127.0.0.1:4001   reached only through the desktop's SSH -L forward
  OpenCode    127.0.0.1:4096   started and supervised by the API process

PC
  desktop app (Tauri)
    ssh -L 127.0.0.1:<ephemeral> -> runner 127.0.0.1:4001   held open while the app runs
    ssh -R runner 127.0.0.1:4200 -> PC 127.0.0.1:4100        opened only during a sync
  sync agent 127.0.0.1:4100    a child of the desktop app, shipped inside it
```

Both SSH forwards go through Lightning's own endpoint, `ssh.lightning.ai`, using the key that `lightning ssh configure` creates. The runner needs no second public listener and the PC exposes no SSH daemon.

## Code layout

| Path                  | What it is                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server`         | The runner. `app.ts` boots it, `routes/` is the API as a route table, `sync.ts` is the runner's side of sync, `sessions.ts` bridges OpenCode sessions.  |
| `apps/web`            | The PWA (Next.js App Router, Tailwind, Astryx). `lib/transcript/` turns a session's event log into chat rows. `store/` is one zustand store in slices.  |
| `apps/desktop`        | The Tauri app. `src/store/` holds its slices, `src/lib/` the SSH, agent and API clients, `src-tauri/` the shell: tray, plugins and the capability file. |
| `apps/sync-agent`     | The PC's side of sync. `operations.ts` holds the transaction logic, `grants.ts` the per-sync grants, `cli.ts` the program the desktop runs.             |
| `packages/shadow-git` | The shadow repository wrapper and the durable-file helpers (atomic JSON, locks, pruning) that the runner and the agent share.                           |
| `packages/types`      | Wire types shared by every side.                                                                                                                        |
| `packages/brand`      | The logo, colors and icon generator.                                                                                                                    |

## Trust boundaries

The Lightning port proxy is on the public internet, and it weakens the browser's defaults. It rewrites every cookie to `SameSite=None` and adds `access-control-allow-origin: *` to every response. Nautilus does not rely on either.

**Phone to runner.** A phone links once with a single-use pairing code that the desktop creates, as text or as a QR code. Redeeming it sets an httpOnly session cookie holding a signed JWT. The runner stores only a hash of each code, and the desktop can revoke a phone at once. Every write through the gateway must carry a same-origin `Origin` header and `X-Nautilus-Request: 1`, which a cross-site form cannot send. That is the CSRF guard. The gateway also strips the proxy's permissive CORS header.

**Previews.** The gateway never serves a preview for a bare project id. The API issues a signed link that lives at most five minutes and works once. The gateway redeems it for a cookie scoped to that project and removes the token from the URL. It strips Nautilus's own cookies before a request reaches the dev server.

**Desktop to runner.** The desktop holds no Nautilus credential. Its control traffic goes over the SSH local forward, so the SSH key is the authentication. Administrative routes, such as registering projects, creating pairing codes, revoking phones and syncing, exist only on the control listener. A phone asking for one gets a 404. Because anything on the PC could reach the forward's local port, including a web page, each control request must have a loopback `Host`, no `Origin` or the Tauri webview's, and `X-Nautilus-Control: 1`.

**Runner to PC.** The runner can reach the PC's agent only while a sync is open, and only with a grant. The desktop starts the agent with a fresh random launch key on stdin. For each sync it asks the agent for a grant bound to one project and one direction, valid for ten minutes at most and signed with that key. The runner forwards the grant on each request, and cannot make one. A push grant cannot call `apply`, so a push can never write to the PC. The desktop revokes the grant when the sync ends. The agent never runs arbitrary commands. It answers a fixed set of sync operations (see [sync-protocol.md](sync-protocol.md)).

**The desktop's own reach.** The Tauri capability file (`apps/desktop/src-tauri/capabilities/default.json`) is the boundary for the desktop itself. It can start exactly three programs with fixed argument validators: `ssh` with the control forward, `ssh` with the sync forward, and its own sync agent binary. It reads and writes only `~/.nautilus`, reads folder listings and `package.json` files for the project picker, makes HTTP requests only to `127.0.0.1`, and opens a file in its default app only under the home directory.

**OpenCode and secrets.** OpenCode runs as the runner's own user, so file permissions cannot keep it out of `~/nautilus/secrets`. When the machine allows unprivileged user namespaces, as Lightning does, the runner starts it inside bubblewrap. There the secrets folder is an empty tmpfs and OpenCode has its own PID namespace, so neither the preview values nor `/proc/<pid>/environ` of the dev server are readable. The network is shared, so the runner still reaches it on loopback. Each prompt tells the agent the names of the preview's keys, never their values, and the runner replaces any stored value of four characters or more with `[redacted:KEY]` in OpenCode's output before it reaches the registry or the phone. A value split across two streamed deltas can still reach a phone that is watching live; the stored copy is redacted whole.

**A known gap.** Any process on the runner that runs as the same Unix user can reach the loopback listeners, sandboxed OpenCode included. Outside the sandbox, such as on a machine without user namespaces, it can also read `~/nautilus/secrets`. Serving the control API on a Unix socket with a peer check would close the first part.

## Where state lives

Runner, under `~/nautilus/`:

| Path                  | Contents                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `registry.sqlite`     | Projects, phones, pairing codes, preview tokens and sessions, agent sessions and their event logs. |
| `secrets/auth-secret` | Signs phone sessions and preview links. Created on first boot, mode 0600, never leaves the runner. |
| `secrets/projects/`   | Each project's preview values, one 0600 file per project, written only by the desktop.             |
| `projects/<id>/`      | The project's files, where the agent works and the dev server runs.                                |
| `shadow/<id>.git`     | The project's shadow repository.                                                                   |
| `sync-state/<id>/`    | The sync base, sync history, transactions, recovery records and cached results.                    |
| `journal.jsonl`       | The lifecycle journal.                                                                             |
| `opencode/state/`     | OpenCode's data, config and cache directories.                                                     |

PC, under `~/.nautilus/`:

| Path                                  | Contents                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `config.json`                         | The runner URL, the SSH host, user and key path, and the folders to search.                        |
| `state.json`                          | The projects, recent folders and folder-scan cache. The agent reads projects from it.              |
| `shadow/<id>.git`                     | The PC's shadow repository for each project.                                                       |
| `runners/<runner>/transactions/<id>/` | The sync base, history, transactions, preflights and cached responses, kept apart for each runner. |
| `runners/<runner>/backups/<id>/`      | A bundle of the PC's state before each pull. The last three are kept.                              |

`<runner>` is `local` for a runner on the same PC, otherwise `runner-` and a short hash of the runner URL. The desktop starts the agent with it, and restarts the agent when the runner changes, so switching runners never carries one runner's base to another. State from before this layout stays in `transactions/<id>/` and `backups/<id>/` until a runner names the same base, and then moves under that runner.

Neither side ever touches the project's own `.git`.

## Restarts

A free Studio restarts every four hours. Nautilus treats that as a full recycle. Processes die and `node_modules` disappears, and a file changed shortly before the restart can come back older or truncated.

`.lightning_studio/on_start.sh` runs on every boot. It reinstalls Node if needed, installs dependencies and starts the server, which then recovers in this order:

1. Open the registry and mark projects that were starting or running as interrupted.
2. Roll back any sync transaction that did not commit.
3. Check every shadow repository. A project whose repository fails its check, whose files differ from the last checkpoint, or whose last checkpoint was cut short is marked unhealthy and left alone.
4. Restart the dev server that was active.
5. Start OpenCode, and mark sessions that were mid-turn as interrupted so the phone can retry them.
6. Report `ready`, or `degraded` when any project is unhealthy.

The phone reconnects on its own, loads a snapshot, and resumes the event stream from the last sequence it saw. An interrupted turn shows as interrupted, never as finished.
