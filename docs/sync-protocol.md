# Sync protocol

Sync moves a project's files between the PC and the runner. The desktop starts every sync, you review it before anything is written, and it never changes either side's own Git history.

## Shadow repositories

Each side keeps a shadow repository per project: a bare Git directory whose worktree is the real project folder. The PC's lives at `~/.nautilus/shadow/<id>.git` and the runner's at `~/nautilus/shadow/<id>.git`. The shadow repository keeps its own index and its own exclude file under `nautilus/`, and two refs:

- `refs/nautilus/head`, the last snapshot or checkpoint of the folder.
- `refs/nautilus/baseline`, the first snapshot, taken the first time the repository opens.

Repositories written by older versions, which kept these under `refs/heads/lines/default/` or `refs/heads/nautilus`, are adopted the first time they open.

The **base** is the last commit both sides agreed on. Each side stores it next to its sync state, and every sync diffs and merges from it.

## What syncs

Regular files sync with their content and executable bit, including binary files, up to the size limits (10 MB per file, 100 MB and 10,000 files per project by default).

Some things cannot survive a round trip through Git, so a sync refuses them outright: symlinks, special files, submodule gitlinks, `.gitmodules`, Git LFS pointers, and a received tree with anything under a `.git` path.

Some things belong to the machine rather than the project, so they stay out: whatever the project's `.gitignore` ignores, `node_modules`, build output, caches, logs and `.env` files. A directory that holds its own `.git`, such as a nested checkout or a worktree, stays out too. It is left untouched on disk, and the desktop mentions it once.

## Requests

The runner sends each request to the agent as JSON through the reverse forward, to `POST /v1/sync`. A request that carries a Git bundle sends the JSON in the `X-Nautilus-Request` header, base64url-encoded, with the bundle as the body.

| Field                                     | Meaning                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `version`                                 | Always `1`.                                                               |
| `requestId`                               | Names the request. A repeated id gets the cached answer and runs nothing. |
| `operation`                               | One of the operations below.                                              |
| `projectId`                               | The project.                                                              |
| `grant`                                   | The grant the desktop had the agent mint for this sync.                   |
| `issuedAt`, `expiresAt`, `nonce`          | A request lives five minutes, and each nonce is used once.                |
| `baseHead`                                | The base the runner believes both sides share.                            |
| `expectedLocalHead`, `expectedRemoteHead` | The heads the request was planned against. A mismatch makes it `stale`.   |
| `payload`                                 | Operation-specific values, such as the runner's base or conflict choices. |

A grant allows only the operations its direction needs:

| Direction | Operations                                                           |
| --------- | -------------------------------------------------------------------- |
| pull      | `state`, `preview`, `import_bundle`, `preflight`, `apply`, `history` |
| push      | `state`, `preview`, `create_bundle`, `history`                       |

Every operation runs under the project's lock. The lock file records who holds it, and a later process takes it over when the holder has died.

A response carries a `status`: `ok`, `conflict`, `stale`, `invalid`, `offline`, `failed` or `recovering`. Conflicts and stale heads are answers to show, not errors.

## Pull

1. The desktop gets a pull grant and opens the reverse forward.
2. **Preview.** The runner diffs its head against the base. That diff is what the review sheet shows.
3. You apply. The runner sends `preview` to the agent, which snapshots the PC's folder into its shadow repository. The runner checks that both sides report the same base.
4. **`import_bundle`.** The runner bundles the commits after the base and the agent imports them. The PC's files are unchanged.
5. **`preflight`.** The agent merges the PC's head and the runner's head from the base with `git merge-tree`, still without touching the files. A clean merge returns an apply token. A path changed on both sides in a way Git cannot combine comes back as a conflict. The runner's head is now on the PC, so the desktop can show both versions of each conflicting file side by side and open the PC's copy in an editor.
6. **`apply`.** The agent checks that the PC's head and files have not moved since the preflight. It writes a bundle of the PC's current state to `backups/`, writes a recovery record, and marks the transaction `prepared`. Then it writes the merge into the folder, moves its base to the runner's head, and marks the transaction `committed`.
7. The runner moves its own base to its head. The desktop revokes the grant and closes the forward.

**Choosing sides.** After a conflict the desktop keeps the grant and the forward open. You pick PC or runner for each conflicting file, and the pull runs again with those choices. The chosen side's version is taken whole. Nothing gets spliced.

## Push

1. The desktop gets a push grant and opens the reverse forward.
2. **Preview.** The agent diffs the PC's folder against the base, and the review sheet shows that diff.
3. You apply. The runner first adopts any edits in its folder that no checkpoint captured, unless an agent turn is still running, in which case it refuses.
4. **`create_bundle`.** The agent snapshots the PC and bundles the commits after the base.
5. The runner imports the bundle and merges from the base, with its own head as "ours" and the PC's as "theirs". A conflict stops here with nothing written, and you can choose sides as with a pull.
6. The runner marks its transaction `prepared`, writes the merge into its folder, moves its base and marks the transaction `committed`.
7. **`state`.** The runner tells the agent its new base, and the agent adopts it. This last step is best effort. If it fails, the next sync carries the base again.

The first push to a runner that has no base for the project sends the whole tree.

## Agent turns

When an agent turn finishes, the runner snapshots the project folder into its shadow repository and records the commit and the head before it as a `session.checkpoint` event. The phone shows each checkpoint under its turn with the files it changed.

**Undo a turn.** The phone can undo one turn's changes and keep everything after it, like `git revert`. The runner merges the turn's parent into the current head, with the turn itself as the base, and saves the result as a new checkpoint. An undo is also a turn's change, so it can be undone too. A turn whose lines were edited again later cannot be undone cleanly, so the runner refuses it and changes nothing.

## Undo a pull

The desktop offers to undo the last pull while nothing has changed on the PC since and neither side has synced again. It works in two steps, and the order matters.

1. The runner rewinds its base from the pulled head to the base before the pull, but only if its base is still the pulled head. Its files stay as they are.
2. The agent puts the PC's files back to their state before the pull and moves its base back too.

Both sides are then where they were before the pull, and the runner offers the same changes on the next pull. If step 2 fails after step 1, the PC's base is ahead of the runner's. The PC's head descends from the runner's older base, so the agent adopts that base on its next request and the two agree again.

## Recovery

Both sides write a transaction record before they change a folder. On startup the agent and the runner each look for transactions left `prepared` or `applied`. They restore the folder from the recovery point, put the base back and mark the transaction `rolled_back`. A sync that was cut off never reports itself as done.

If the runner gives up waiting on a pull while the agent is still working, the agent checks for that at the last two points before it writes anything. A timed-out request cannot land later.

Each side keeps its history bounded. It keeps the last three pull backups and recovery records and the last fifty transactions, but never deletes one that recovery still needs.
