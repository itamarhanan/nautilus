import { createHash, randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ProjectConfig,
  SyncBundle,
  SyncDiff,
  SyncEvent,
  SyncRequest,
  SyncResponse,
  SyncResolutions,
  SyncStatusResponse,
  SyncTransaction,
} from "@nautilus/types";
import {
  commitPattern,
  LockBusyError,
  type MergeConflict,
  type MergePick,
  pruneFiles,
  readJson,
  ShadowGit,
  ShadowGitError,
  withLock,
  writeJson,
  type ShadowGitLimits,
  type ShadowGitValidation,
} from "@nautilus/shadow-git";

type JsonRecord = Record<string, unknown>;

export type Checkpoint = { commit: string; previousHead: string | null };

export type RevertResult =
  | { status: "ok"; checkpoint: Checkpoint }
  | { status: "conflict"; conflicts: string[] };

const syncResponseStatuses = new Set([
  "ok",
  "offline",
  "conflict",
  "stale",
  "invalid",
  "failed",
  "recovering",
]);

function validatedSyncResponse(value: unknown, requestId: string): SyncResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Record<string, unknown>).version !== 1 ||
    (value as Record<string, unknown>).requestId !== requestId ||
    typeof (value as Record<string, unknown>).status !== "string" ||
    !syncResponseStatuses.has((value as Record<string, unknown>).status as string)
  ) {
    throw new SyncOfflineError();
  }
  return value as SyncResponse;
}

export class SyncOfflineError extends Error {
  readonly code = "pc_offline";

  constructor() {
    super("PC offline");
    this.name = "SyncOfflineError";
  }
}

export class SyncCoordinatorError extends Error {
  constructor(
    readonly status: "invalid" | "stale" | "conflict" | "failed",
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SyncCoordinatorError";
  }
}

type RequestValues = {
  grant: string;
  baseHead?: string | null;
  expectedLocalHead?: string | null;
  expectedRemoteHead?: string | null;
  payload?: JsonRecord;
  requestId?: string;
};

export class TunnelSyncClient {
  constructor(
    private readonly options: {
      endpoint?: string;
      timeoutMs?: number;
      maxBundleBytes?: number;
    },
  ) {}

  async request(
    operation: SyncRequest["operation"],
    projectId: string,
    values: RequestValues,
  ): Promise<SyncResponse> {
    const request = this.createRequest(operation, projectId, values);
    return this.sendJson(request);
  }

  async requestWithBundle(
    bundle: SyncBundle,
    projectId: string,
    values: Omit<RequestValues, "payload">,
  ): Promise<SyncResponse> {
    const request = this.createRequest("import_bundle", projectId, {
      ...values,
      payload: { head: bundle.head, sha256: bundle.sha256 },
    });
    request.digest = bundle.sha256;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.options.timeoutMs ?? 30_000);
    try {
      const result = await fetch(this.options.endpoint ?? "http://127.0.0.1:4200/v1/sync", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-nautilus-request": Buffer.from(JSON.stringify(request)).toString("base64url"),
          "x-nautilus-digest": bundle.sha256,
        },
        body: bundle.bytes,
        signal: controller.signal,
      });
      return await this.readResponse(result, request.requestId);
    } catch (error) {
      if (error instanceof SyncOfflineError) throw error;
      throw new SyncOfflineError();
    } finally {
      clearTimeout(timeout);
    }
  }

  private createRequest(
    operation: SyncRequest["operation"],
    projectId: string,
    values: RequestValues,
  ): SyncRequest {
    const now = Date.now();
    return {
      version: 1,
      requestId: values.requestId ?? randomUUID(),
      operation,
      projectId,
      grant: values.grant,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
      nonce: randomUUID(),
      baseHead: values.baseHead ?? null,
      expectedLocalHead: values.expectedLocalHead ?? null,
      expectedRemoteHead: values.expectedRemoteHead ?? null,
      payload: values.payload ?? {},
    };
  }

  private async sendJson(request: SyncRequest): Promise<SyncResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.options.timeoutMs ?? 30_000);
    try {
      const result = await fetch(this.options.endpoint ?? "http://127.0.0.1:4200/v1/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      return await this.readResponse(result, request.requestId);
    } catch (error) {
      if (error instanceof SyncOfflineError) throw error;
      throw new SyncOfflineError();
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readResponse(result: Response, requestId: string): Promise<SyncResponse> {
    if (result.headers.get("content-type")?.startsWith("application/octet-stream")) {
      const responseHeader = result.headers.get("x-nautilus-response");
      if (!responseHeader) throw new SyncOfflineError();
      const metadata: unknown = JSON.parse(
        Buffer.from(responseHeader, "base64url").toString("utf8"),
      );
      if (typeof metadata !== "object" || metadata === null) throw new SyncOfflineError();
      const response = metadata as SyncResponse;
      const bytes = await this.readBoundedBody(result);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (
        !response.bundle ||
        result.headers.get("x-nautilus-digest") !== digest ||
        response.bundle.sha256 !== digest
      ) {
        throw new SyncOfflineError();
      }
      return {
        ...validatedSyncResponse(response, requestId),
        bundle: {
          ...response.bundle,
          bytesBase64: bytes.toString("base64"),
        },
      };
    }
    const body: unknown = await result.json();
    if (typeof body !== "object" || body === null) throw new SyncOfflineError();
    return validatedSyncResponse(body, requestId);
  }

  private async readBoundedBody(result: Response): Promise<Buffer> {
    if (!result.body) return Buffer.alloc(0);
    const reader = result.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      let complete = false;
      while (!complete) {
        const next = await reader.read();
        if (next.done) {
          complete = true;
          continue;
        }
        size += next.value.byteLength;
        if (size > (this.options.maxBundleBytes ?? 100_000_000)) {
          await reader.cancel();
          throw new Error("bundle_too_large");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }
}

type CoordinatorOptions = {
  projects: ProjectConfig[];
  shadowRoot: string;
  statePath: string;
  client: TunnelSyncClient;
  onEvent?: (event: SyncEvent) => void | Promise<void>;
  onFirstSync?: (projectId: string) => void | Promise<void>;
  busy?: (projectId: string) => boolean;
  limits?: Partial<ShadowGitLimits>;
};

export class SyncCoordinator {
  private readonly projects: Map<string, ProjectConfig>;
  private readonly gitByProject = new Map<string, ShadowGit>();

  constructor(private readonly options: CoordinatorOptions) {
    this.projects = new Map(options.projects.map((project) => [project.id, project]));
  }

  addProject(project: ProjectConfig): void {
    this.projects.set(project.id, project);
  }

  // Runs under the project's lock, so a sync still in flight refuses the removal
  // with project_busy instead of losing its shadow repository mid-transaction.
  // The lock file itself is released, and so removed, once the action returns.
  async removeProject(projectId: string): Promise<void> {
    await this.withLock(projectId, async () => {
      this.projects.delete(projectId);
      this.gitByProject.delete(projectId);
      await rm(join(this.options.shadowRoot, `${projectId}.git`), {
        recursive: true,
        force: true,
      });
      await rm(this.projectState(projectId), { recursive: true, force: true });
    });
  }

  connect(hooks: Pick<CoordinatorOptions, "onEvent" | "onFirstSync" | "busy">): void {
    Object.assign(this.options, hooks);
  }

  async preview(
    projectId: string,
    direction: "pull" | "push",
    grant: string,
    requestId: string = randomUUID(),
  ): Promise<SyncResponse> {
    return this.withLock(projectId, async () => {
      this.project(projectId);
      if (direction === "push") {
        return this.options.client.request("preview", projectId, {
          grant,
          requestId,
          payload: { runnerBase: await this.base(projectId) },
        });
      }
      const git = await this.git(this.project(projectId));
      await this.adoptWorktree(projectId, git);
      const remoteHead = (await git.head()) ?? (await git.baseline());
      const synchronizedBase = await this.base(projectId);
      const diff = await git.diff(synchronizedBase, remoteHead);
      return {
        version: 1,
        requestId,
        status: "ok",
        state: {
          projectId,
          head: remoteHead,
          baseHead: synchronizedBase,
          dirty: !(await git.isClean()),
          changes: { files: [], additions: 0, deletions: 0 },
          excludedRepositories: await git.excludedRepositories(),
        },
        diff,
      };
    });
  }

  async pull(
    projectId: string,
    grant: string,
    requestId: string = randomUUID(),
    resolutions: SyncResolutions = {},
  ): Promise<SyncResponse> {
    return this.withCachedResult(projectId, requestId, "pull", () =>
      this.pullInternal(projectId, grant, requestId, resolutions),
    );
  }

  async rewindBase(projectId: string, from: string, to: string): Promise<void> {
    await this.withLock(projectId, async () => {
      const git = await this.git(this.project(projectId));
      if ((await this.base(projectId)) !== from) {
        throw new SyncCoordinatorError(
          "stale",
          "stale_base_head",
          "The runner has synchronized since this pull",
        );
      }
      if (!commitPattern.test(to) || !(await git.isAncestor(to, from))) {
        throw new SyncCoordinatorError(
          "invalid",
          "invalid_base_head",
          "The earlier base is not part of this project's history",
        );
      }
      await this.setBase(projectId, to);
      const path = this.eventsPath(projectId);
      const events = await readJson<SyncEvent[]>(path, []);
      let pulled = events.length - 1;
      while (pulled >= 0) {
        const event = events[pulled];
        if (event?.direction === "pull" && event.status === "ok" && event.baseHead === from) break;
        pulled -= 1;
      }
      const lastPull = events[pulled];
      if (pulled !== -1 && lastPull) {
        const event = { ...lastPull, undone: true };
        events[pulled] = event;
        await writeJson(path, events);
        await this.options.onEvent?.(event);
      }
    });
  }

  private async pullInternal(
    projectId: string,
    grant: string,
    requestId: string,
    resolutions: SyncResolutions = {},
  ): Promise<SyncResponse> {
    this.project(projectId);
    const git = await this.git(this.project(projectId));
    await this.adoptWorktree(projectId, git);
    const local = await this.options.client.request("preview", projectId, {
      grant,
      requestId: `${requestId}-preview`,
      payload: { runnerBase: await this.base(projectId), includeDiff: false },
    });

    if (local.status !== "ok") return { ...local, requestId };
    if (!local.state)
      throw new SyncCoordinatorError("failed", "pc_state_failed", "PC returned no state");
    const remoteHead = (await git.head()) ?? (await git.baseline());
    const synchronizedBase = await this.base(projectId);
    if (synchronizedBase !== null && local.state.baseHead !== synchronizedBase) {
      throw new SyncCoordinatorError(
        "stale",
        "base_mismatch",
        "PC and runner synchronization bases differ",
      );
    }
    const bundle = await git.createBundle(
      remoteHead,
      this.stateDir(projectId, "bundles"),
      synchronizedBase,
    );
    let imported: SyncResponse;
    try {
      imported = await this.options.client.requestWithBundle(bundle, projectId, {
        grant,
        baseHead: synchronizedBase,
        requestId: `${requestId}-import`,
      });
    } finally {
      await rm(join(this.stateDir(projectId, "bundles"), `${remoteHead}.bundle`), {
        force: true,
      });
    }
    if (imported.status !== "ok") return { ...imported, requestId };
    const preflight = await this.options.client.request("preflight", projectId, {
      grant,
      baseHead: synchronizedBase,
      expectedLocalHead: local.state.head,
      expectedRemoteHead: remoteHead,
      requestId: `${requestId}-preflight`,

      payload: { resolutions },
    });
    if (preflight.status !== "ok" || !preflight.applyToken) {
      return { ...preflight, requestId };
    }
    const applied = await this.options.client.request("apply", projectId, {
      grant,
      baseHead: synchronizedBase,
      expectedLocalHead: local.state.head,
      expectedRemoteHead: remoteHead,
      requestId: `${requestId}-apply`,
      payload: { applyToken: preflight.applyToken },
    });
    if (applied.status === "ok") await this.setBase(projectId, remoteHead);
    return {
      ...applied,
      requestId,
      ...(preflight.diff ? { diff: preflight.diff } : {}),
      ...(applied.status === "conflict" ? { conflicts: applied.conflicts ?? [] } : {}),
    };
  }

  async push(
    projectId: string,
    grant: string,
    requestId: string = randomUUID(),
    resolutions: SyncResolutions = {},
  ): Promise<SyncResponse> {
    return this.withCachedResult(projectId, requestId, "push", () =>
      this.pushInternal(projectId, grant, requestId, resolutions),
    );
  }

  private async withCachedResult(
    projectId: string,
    requestId: string,
    direction: "pull" | "push",
    action: () => Promise<SyncResponse>,
  ): Promise<SyncResponse> {
    return this.withLock(projectId, async () => {
      const cached = await this.cachedResult(projectId, requestId);
      if (cached) return { ...cached, replayed: true };
      try {
        const result = await action();
        await this.cacheResult(projectId, requestId, result);
        await this.recordResult(result, projectId, direction, requestId);
        await this.pruneHistory(projectId);
        return result;
      } catch (error) {
        await this.failureEvent(projectId, direction, requestId, error);
        throw error;
      }
    });
  }

  private async pushInternal(
    projectId: string,
    grant: string,
    requestId: string,
    resolutions: SyncResolutions = {},
  ): Promise<SyncResponse> {
    this.project(projectId);
    const git = await this.git(this.project(projectId));
    await this.adoptWorktree(projectId, git);
    const localState = await this.options.client.request("create_bundle", projectId, {
      grant,
      requestId,
      payload: { runnerBase: await this.base(projectId) },
    });
    if (localState.status !== "ok" || !localState.bundle) return localState;
    const localBundle: SyncBundle = {
      head: localState.bundle.head,
      sha256: localState.bundle.sha256,
      bytes: Buffer.from(localState.bundle.bytesBase64, "base64"),
    };
    const remoteHead = (await git.head()) ?? (await git.baseline());
    // The base cannot change between here and the transaction write: nothing
    // below writes it until the try block, which is why one read serves both
    // the merge base and the transaction's previousBaseHead.
    const previousBase = await this.base(projectId);
    const mergeBase = previousBase ?? (await git.mergeBase());

    await this.requireCleanWorktree(git);
    await git.importBundle(localBundle, previousBase);

    const localChanges = await git.diff(localState.state?.baseHead ?? null, localBundle.head);

    const preflight = await this.preflightMerge(git, {
      mergeBase,
      remoteHead,
      localBundle,
      resolutions,
    });
    if (!preflight.clean || !preflight.tree) {
      return this.conflictResponse(git, requestId, mergeBase, localBundle, preflight.conflicts);
    }
    const paths = this.transactionPaths(projectId, requestId);
    const transaction = this.buildTransaction({
      requestId,
      projectId,
      mergeBase,
      localBundle,
      remoteHead,
      preflightTree: preflight.tree,
      recoveryPath: paths.recovery,
      previousBaseHead: previousBase,
    });
    await writeJson(paths.recovery, { head: remoteHead });
    await writeJson(paths.transaction, transaction);
    const nextBase =
      previousBase === null ? (localState.state?.baseHead ?? localBundle.head) : localBundle.head;

    try {
      await this.assertRemoteUnchanged(git, remoteHead);
      const mergedHead = await git.applyTree(
        preflight.tree,
        [remoteHead, localBundle.head],
        "Nautilus push merge",
      );
      await this.setBase(projectId, nextBase);
      transaction.status = "committed";
      transaction.updatedAt = new Date().toISOString();
      await writeJson(paths.transaction, transaction);

      await this.options.client
        .request("state", projectId, {
          grant,
          requestId: `${requestId}-base`,
          payload: { runnerBase: await this.base(projectId) },
        })
        .catch(() => undefined);

      if (previousBase === null) {
        await this.options.onFirstSync?.(projectId);
      }
      const result: SyncResponse = {
        version: 1,
        requestId,
        status: "ok",
        state: {
          projectId,
          head: mergedHead,
          baseHead: nextBase,
          dirty: false,
          changes: localChanges,
        },
        diff: localState.diff ?? localChanges,
      };
      return result;
    } catch (error) {
      transaction.status = "failed";
      transaction.updatedAt = new Date().toISOString();
      await git.restoreHead(remoteHead).catch(() => undefined);
      if (previousBase === null) {
        await rm(this.basePath(projectId), { force: true });
      } else {
        await this.setBase(projectId, previousBase);
      }
      await writeJson(paths.transaction, transaction);
      throw error;
    }
  }

  private async requireCleanWorktree(git: ShadowGit): Promise<void> {
    if (!(await git.isClean())) {
      throw new SyncCoordinatorError(
        "conflict",
        "remote_worktree_dirty",
        "Runner worktree changed during the push; try again",
      );
    }
  }

  private async assertRemoteUnchanged(git: ShadowGit, remoteHead: string): Promise<void> {
    if ((await git.head()) !== remoteHead) {
      throw new SyncCoordinatorError(
        "stale",
        "stale_remote_head",
        "Remote head changed before apply",
      );
    }
    if (!(await git.isClean())) {
      throw new SyncCoordinatorError(
        "conflict",
        "remote_worktree_dirty",
        "Remote worktree changed before apply",
      );
    }
  }

  private picksOf(resolutions: SyncResolutions): Record<string, MergePick> {
    return Object.fromEntries(
      Object.entries(resolutions).map(([path, side]): [string, MergePick] => [
        path,
        side === "runner" ? "ours" : "theirs",
      ]),
    );
  }

  private preflightMerge(
    git: ShadowGit,
    input: {
      mergeBase: string;
      remoteHead: string;
      localBundle: SyncBundle;
      resolutions: SyncResolutions;
    },
  ) {
    return git.mergeTree(
      input.mergeBase,
      input.remoteHead,
      input.localBundle.head,
      this.picksOf(input.resolutions),
    );
  }

  private async conflictResponse(
    git: ShadowGit,
    requestId: string,
    mergeBase: string,
    localBundle: SyncBundle,
    conflicts: MergeConflict[] | undefined,
  ): Promise<SyncResponse> {
    return {
      version: 1,
      requestId,
      status: "conflict",
      conflicts: (conflicts ?? []).map((entry) => ({
        path: entry.path,
        reason: entry.reason,
        runner: entry.ours,
        pc: entry.theirs,
      })),
      diff: await git.diff(mergeBase, localBundle.head),
    };
  }

  private transactionPaths(
    projectId: string,
    requestId: string,
  ): { recovery: string; transaction: string } {
    return {
      recovery: join(this.stateDir(projectId, "recovery"), `${requestId}.json`),
      transaction: join(this.stateDir(projectId, "transactions"), `${requestId}.json`),
    };
  }

  private buildTransaction(input: {
    requestId: string;
    projectId: string;
    mergeBase: string;
    localBundle: SyncBundle;
    remoteHead: string;
    preflightTree: string;
    recoveryPath: string;
    previousBaseHead: string | null;
  }): SyncTransaction {
    const now = new Date().toISOString();
    return {
      requestId: input.requestId,
      projectId: input.projectId,
      direction: "push",
      status: "prepared",
      baseHead: input.mergeBase,
      expectedLocalHead: input.localBundle.head,
      expectedRemoteHead: input.remoteHead,
      preflight: input.preflightTree,
      recoveryPath: input.recoveryPath,
      previousBaseHead: input.previousBaseHead,
      createdAt: now,
      updatedAt: now,
    };
  }

  async checkpoint(projectId: string, sessionId: string): Promise<Checkpoint> {
    const git = await this.git(this.project(projectId));
    return this.commitWorktree(projectId, git, sessionId, `Nautilus agent checkpoint ${sessionId}`);
  }

  async changes(projectId: string, from: string | null, to: string): Promise<SyncDiff> {
    const git = await this.git(this.project(projectId));
    await this.requireCheckpoints(git, from, to);
    if (from === to) return { files: [], additions: 0, deletions: 0 };
    return git.diff(from, to);
  }

  async revert(
    projectId: string,
    commit: string,
    previousHead: string | null,
    sessionId: string,
  ): Promise<RevertResult> {
    return this.withLock(projectId, async () => {
      const git = await this.git(this.project(projectId));
      if (previousHead === null)
        throw new SyncCoordinatorError(
          "invalid",
          "nothing_to_revert",
          "This turn has no earlier state",
        );
      await this.requireCheckpoints(git, previousHead, commit);

      await this.adoptWorktree(projectId, git);
      const head = (await git.head()) ?? commit;
      const merge = await git.mergeTree(commit, head, previousHead);
      if (!merge.clean || !merge.tree) {
        return {
          status: "conflict",
          conflicts: (merge.conflicts ?? []).map((conflict) => conflict.path),
        };
      }
      if (!(await git.isClean()))
        throw new SyncCoordinatorError(
          "conflict",
          "remote_worktree_dirty",
          "The runner's files changed during the revert; try again",
        );
      const intentPath = this.pendingCheckpointPath(projectId);
      await writeJson(intentPath, {
        sessionId,
        previousHead: head,
        createdAt: new Date().toISOString(),
      });
      const reverted = await git.applyTree(merge.tree, [head], `Nautilus revert of ${commit}`);
      await this.recordCheckpoint(projectId, reverted);
      await rm(intentPath, { force: true });
      return {
        status: "ok",
        checkpoint: { commit: reverted, previousHead: head },
      };
    });
  }

  private async requireCheckpoints(git: ShadowGit, from: string | null, to: string): Promise<void> {
    const head = await git.head();
    const known = async (commit: string): Promise<boolean> =>
      commitPattern.test(commit) && head !== null ? git.isAncestor(commit, head) : false;
    if (!(await known(to)) || (from !== null && !(await known(from))))
      throw new SyncCoordinatorError(
        "invalid",
        "checkpoint_not_found",
        "That checkpoint is not in this project's history",
      );
  }

  private async adoptWorktree(projectId: string, git: ShadowGit): Promise<void> {
    if ((await this.base(projectId)) === null || (await git.isClean())) return;
    if (this.options.busy?.(projectId)) {
      throw new SyncCoordinatorError(
        "conflict",
        "agent_running",
        "An agent is still editing the runner; wait for it to finish or stop it",
      );
    }
    await this.commitWorktree(projectId, git, "recovered", "Nautilus recovered checkpoint");
  }

  private async commitWorktree(
    projectId: string,
    git: ShadowGit,
    sessionId: string,
    message: string,
  ): Promise<Checkpoint> {
    const intentPath = this.pendingCheckpointPath(projectId);
    const previousHead = await git.head();
    await writeJson(intentPath, {
      sessionId,
      previousHead,
      createdAt: new Date().toISOString(),
    });
    const commit = await git.snapshot(message);
    await this.recordCheckpoint(projectId, commit);
    await rm(intentPath, { force: true });
    return { commit, previousHead };
  }

  private async recordCheckpoint(projectId: string, head: string): Promise<void> {
    await this.record({
      requestId: randomUUID(),
      projectId,
      direction: "system",
      status: "ok",
      baseHead: await this.base(projectId),
      localHead: null,
      remoteHead: head,
      errorCode: null,
      conflicts: [],
      createdAt: new Date().toISOString(),
      committedAt: new Date().toISOString(),
    });
  }

  async hasCode(projectId: string): Promise<boolean> {
    this.project(projectId);
    return (await this.base(projectId)) !== null;
  }

  async status(projectId: string): Promise<SyncStatusResponse> {
    const project = this.project(projectId);
    const git = await this.git(project);
    const baseHead = await this.base(projectId);
    const changedPaths = baseHead === null ? [] : await git.changedPaths(baseHead);
    const events = await this.history(projectId);
    const latest = (predicate: (event: SyncEvent) => boolean) =>
      [...events].reverse().find((event) => predicate(event) && event.committedAt)?.committedAt ??
      null;
    return {
      projectId,
      excludedRepositories: await git.excludedRepositories(),
      neverSynced: baseHead === null,
      baseHead,
      head: await git.head(),
      changedFiles: changedPaths.length,
      changedPaths: changedPaths.slice(0, 50),
      lastCheckpointAt: latest((event) => event.direction === "system"),
      lastSyncAt: latest((event) => event.direction !== "system" && event.status === "ok"),
    };
  }

  async history(projectId: string): Promise<SyncEvent[]> {
    this.project(projectId);
    return readJson<SyncEvent[]>(this.eventsPath(projectId), []);
  }

  async recover(projectId: string): Promise<void> {
    const project = this.project(projectId);
    let git: ShadowGit;
    try {
      git = await this.git(project);
    } catch (error) {
      // Nothing can be rolled back into a folder that is gone; validation marks
      // the project unhealthy instead of the whole runner failing to start.
      if (error instanceof ShadowGitError && error.code === "worktree_missing") return;
      throw error;
    }
    const directory = this.stateDir(projectId, "transactions");
    for (const entry of await readdir(directory).catch(() => [])) {
      if (!entry.endsWith(".json")) continue;
      const path = join(directory, entry);
      const transaction = await readJson<SyncTransaction | undefined>(path, undefined);
      if (!transaction || (transaction.status !== "prepared" && transaction.status !== "applied")) {
        continue;
      }
      if (transaction.recoveryPath) {
        const recovery = await readJson<{ head: string; baseHead?: string | null } | undefined>(
          transaction.recoveryPath,
          undefined,
        );
        if (recovery?.head) await git.restoreHead(recovery.head);
        if (transaction.previousBaseHead === null) {
          await rm(this.basePath(projectId), { force: true });
        } else if (transaction.previousBaseHead) {
          await this.setBase(projectId, transaction.previousBaseHead);
        }
      }
      transaction.status = "rolled_back";
      transaction.updatedAt = new Date().toISOString();
      await writeJson(path, transaction);
    }
  }

  async validateAll(): Promise<Map<string, ShadowGitValidation>> {
    const results = new Map<string, ShadowGitValidation>();
    await Promise.all(
      [...this.projects.values()].map(async (project) => {
        try {
          results.set(project.id, await (await this.git(project)).validate());
        } catch (error) {
          // One project that cannot be opened is reported, not a failed boot.
          results.set(project.id, {
            valid: false,
            dirty: false,
            head: null,
            error: error instanceof ShadowGitError ? error.code : "shadow_validation_failed",
          });
        }
      }),
    );
    return results;
  }

  async pendingCheckpoints(): Promise<string[]> {
    const pending: string[] = [];
    for (const projectId of this.projects.keys()) {
      const path = this.pendingCheckpointPath(projectId);
      if (await readJson<unknown>(path, null)) pending.push(projectId);
    }
    return pending;
  }

  async recoverAll(): Promise<void> {
    await Promise.all([...this.projects.keys()].map((projectId) => this.recover(projectId)));
  }

  private async pruneHistory(projectId: string): Promise<void> {
    const root = this.projectState(projectId);
    await pruneFiles(join(root, "results"), { keep: 200, suffix: ".json" });
    await pruneFiles(join(root, "recovery"), { keep: 3, suffix: ".json" });
    await pruneFiles(join(root, "transactions"), {
      keep: 50,
      suffix: ".json",
      protect: async (path) => {
        const transaction = await readJson<SyncTransaction | undefined>(path, undefined);
        return transaction?.status === "prepared" || transaction?.status === "applied";
      },
    });
  }

  private async cachedResult(
    projectId: string,
    requestId: string,
  ): Promise<SyncResponse | undefined> {
    return readJson<SyncResponse | undefined>(
      join(this.stateDir(projectId, "results"), `${requestId}.json`),
      undefined,
    );
  }

  private async cacheResult(
    projectId: string,
    requestId: string,
    result: SyncResponse,
  ): Promise<void> {
    await writeJson(join(this.stateDir(projectId, "results"), `${requestId}.json`), result);
  }

  private async withLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    try {
      return await withLock(join(this.options.statePath, `${projectId}.lock`), action);
    } catch (error) {
      if (error instanceof LockBusyError)
        throw new SyncCoordinatorError("conflict", "project_busy", error.message);
      throw error;
    }
  }

  private async git(project: ProjectConfig): Promise<ShadowGit> {
    const existing = this.gitByProject.get(project.id);
    if (existing) return existing;
    const git = new ShadowGit({
      gitDir: join(this.options.shadowRoot, `${project.id}.git`),
      workTree: project.remotePath,
      limits: this.options.limits,
    });
    await git.initialize();
    this.gitByProject.set(project.id, git);
    return git;
  }

  private project(id: string): ProjectConfig {
    const project = this.projects.get(id);
    if (!project)
      throw new SyncCoordinatorError(
        "invalid",
        "project_not_configured",
        "Project is not configured",
      );
    return project;
  }

  private async base(projectId: string): Promise<string | null> {
    return readJson<string | null>(this.basePath(projectId), null);
  }

  private async setBase(projectId: string, head: string): Promise<void> {
    await writeJson(this.basePath(projectId), head);
  }

  private projectState(projectId: string): string {
    return join(this.options.statePath, projectId);
  }

  private stateDir(
    projectId: string,
    kind: "bundles" | "recovery" | "results" | "transactions",
  ): string {
    return join(this.projectState(projectId), kind);
  }

  private eventsPath(projectId: string): string {
    return join(this.projectState(projectId), "events.json");
  }

  private pendingCheckpointPath(projectId: string): string {
    return join(this.projectState(projectId), "checkpoint.pending.json");
  }

  private basePath(projectId: string): string {
    return join(this.projectState(projectId), "base.json");
  }

  private async recordResult(
    result: SyncResponse,
    projectId: string,
    direction: "pull" | "push",
    requestId: string,
  ): Promise<void> {
    await this.record({
      requestId,
      projectId,
      direction,
      status: result.status,
      baseHead: result.state?.baseHead ?? null,
      localHead: result.state?.head ?? null,
      remoteHead: result.state?.head ?? null,
      errorCode: result.error?.code ?? null,
      conflicts: result.conflicts ?? result.error?.conflicts ?? [],
      createdAt: new Date().toISOString(),
      committedAt: result.status === "ok" ? new Date().toISOString() : null,
    });
  }

  private async failureEvent(
    projectId: string,
    direction: "pull" | "push",
    requestId: string,
    error: unknown,
  ): Promise<void> {
    const status =
      error instanceof SyncOfflineError
        ? "offline"
        : error instanceof SyncCoordinatorError
          ? error.status
          : "failed";
    const code =
      error instanceof SyncCoordinatorError
        ? error.code
        : error instanceof SyncOfflineError
          ? error.code
          : "sync_operation_failed";
    await this.record({
      requestId,
      projectId,
      direction,
      status,
      baseHead: await this.base(projectId),
      localHead: null,
      remoteHead: null,
      errorCode: code,
      conflicts: [],
      createdAt: new Date().toISOString(),
      committedAt: null,
    });
  }

  private async record(event: SyncEvent): Promise<void> {
    const path = this.eventsPath(event.projectId);
    const events = await readJson<SyncEvent[]>(path, []);
    const existing = events.findIndex((entry) => entry.requestId === event.requestId);
    if (existing === -1) events.push(event);
    else events[existing] = event;
    await writeJson(path, events.slice(-1000));
    await this.options.onEvent?.(event);
  }
}
