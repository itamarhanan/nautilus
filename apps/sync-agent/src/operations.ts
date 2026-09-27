import { createHash, randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadStateProjects, type AgentConfig, type AgentProject } from "./config";
import { GrantError } from "./grants";
import { validateSyncRequest } from "./protocol";
import { parseResolutions } from "@nautilus/types";
import {
  LockBusyError,
  type MergeConflict,
  type MergePick,
  pruneFiles,
  readJson,
  ShadowGit,
  ShadowGitError,
  withLock,
  writeJson,
} from "@nautilus/shadow-git";
import type {
  SyncBundle,
  SyncConflict,
  SyncDiff,
  SyncEvent,
  SyncRequest,
  SyncResolutions,
  SyncResponse,
  SyncStatus,
  SyncTransaction,
} from "@nautilus/types";

const responseVersion = 1 as const;
const requestLifetimeMs = 5 * 60 * 1000;
const clockSkewMs = 60 * 1000;

type JsonRecord = Record<string, unknown>;

type Preflight = {
  id: string;
  projectId: string;
  baseHead: string | null;
  mergeBase: string;
  localHead: string;
  remoteHead: string;
  tree: string;

  resolutions?: SyncResolutions;
  createdAt: string;
};

function pullPicks(resolutions: SyncResolutions = {}): Record<string, MergePick> {
  return Object.fromEntries(
    Object.entries(resolutions).map(([path, side]): [string, MergePick] => [
      path,
      side === "pc" ? "ours" : "theirs",
    ]),
  );
}

function pullConflicts(conflicts: MergeConflict[] = []): SyncConflict[] {
  return conflicts.map((entry) => ({
    path: entry.path,
    reason: entry.reason,
    pc: entry.ours,
    runner: entry.theirs,
  }));
}

type AgentResponseInput = {
  status: SyncStatus;
  state?: SyncResponse["state"];
  diff?: SyncDiff;
  conflicts?: SyncConflict[];
  history?: SyncEvent[];
  bundle?: SyncResponse["bundle"];
  applyToken?: string;
  error?: SyncResponse["error"];
};

type Authenticate = (request: SyncRequest) => void | Promise<void>;

type CachedSyncResponse = {
  digest: string;
  response: SyncResponse;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalRequest(request: SyncRequest): Buffer {
  return Buffer.from(JSON.stringify(request));
}

function requestDigest(request: SyncRequest): string {
  return createHash("sha256").update(canonicalRequest(request)).digest("hex");
}

function now(): string {
  return new Date().toISOString();
}

function response(requestId: string, input: AgentResponseInput): SyncResponse {
  const { status, ...rest } = input;
  return { version: responseVersion, requestId, status, ...rest };
}

function errorResponse(
  requestId: string,
  status: SyncStatus,
  code: string,
  message: string,
  conflicts?: SyncConflict[],
): SyncResponse {
  return response(requestId, {
    status,
    error: { code, message, ...(conflicts ? { conflicts } : {}) },
  });
}

export class SyncAgent {
  private readonly gitByProject = new Map<string, ShadowGit>();
  private readonly usedNonces = new Set<string>();

  constructor(
    private readonly config: AgentConfig,
    private readonly authenticateRequest: Authenticate,
  ) {}

  private async projects(): Promise<AgentProject[]> {
    return this.config.statePath
      ? loadStateProjects(this.config.statePath, this.config.home)
      : this.config.projects;
  }

  async handle(
    value: unknown,
    rawBundle?: Uint8Array,
    signal?: AbortSignal,
  ): Promise<SyncResponse> {
    let request: SyncRequest;
    try {
      request = validateSyncRequest(value);
    } catch (error) {
      const requestId =
        isRecord(value) && typeof value.requestId === "string" ? value.requestId : "unknown";
      return errorResponse(
        requestId,
        "invalid",
        "invalid_request",
        error instanceof Error ? error.message : "Invalid request",
      );
    }
    if (request.operation === "health") {
      return response(request.requestId, { status: "ok" });
    }
    let eventProject: AgentProject | undefined;
    try {
      const project = (await this.projects()).find((entry) => entry.id === request.projectId);
      if (!project)
        return errorResponse(
          request.requestId,
          "invalid",
          "project_not_configured",
          "Project is not configured",
        );
      eventProject = project;
      return await this.withLock(project, async () => {
        const cached = await this.cachedResponse(request, project);
        if (cached) {
          await this.authenticate(request, true);
          return { ...cached, replayed: true };
        }
        await this.authenticate(request);
        const result = await this.dispatch(request, project, rawBundle, signal);
        await this.cacheResponse(request, result, project);
        if (result.status !== "ok") await this.recordFailure(request, project, result);
        return result;
      });
    } catch (error) {
      let result: SyncResponse;
      if (error instanceof SyncAgentError) {
        result = errorResponse(
          request.requestId,
          error.status,
          error.code,
          error.message,
          error.conflicts,
        );
      } else if (error instanceof ShadowGitError) {
        const status =
          error.code.includes("ancestry") || error.code.includes("head") ? "conflict" : "failed";
        result = errorResponse(request.requestId, status, error.code, error.message);
      } else {
        result = errorResponse(
          request.requestId,
          "failed",
          "sync_operation_failed",
          error instanceof Error ? error.message : "Sync operation failed",
        );
      }
      if (eventProject) await this.recordFailure(request, eventProject, result);
      return result;
    }
  }

  private async dispatch(
    request: SyncRequest,
    project: AgentProject,
    rawBundle?: Uint8Array,
    signal?: AbortSignal,
  ): Promise<SyncResponse> {
    switch (request.operation) {
      case "state":
        return this.state(request, project);
      case "preview":
        return this.preview(request, project);
      case "create_bundle":
        return this.createBundle(request, project);
      case "import_bundle":
        return this.importBundle(request, project, rawBundle);
      case "preflight":
        return this.preflight(request, project);
      case "apply":
        return this.apply(request, project, signal);
      case "history":
        return this.history(request, project);
      default:
        throw new SyncAgentError("invalid", "invalid_operation", "Operation is not supported");
    }
  }

  private async state(request: SyncRequest, project: AgentProject): Promise<SyncResponse> {
    const git = await this.git(project);
    const head = await git.head();
    const baseHead = await this.reconcileBase(request, project, git);
    return response(request.requestId, {
      status: "ok",
      state: {
        projectId: project.id,
        head,
        baseHead,
        dirty: !(await git.isClean()),
        changes: head ? await git.diff(baseHead, head) : emptyDiff(),
      },
    });
  }

  private async preview(request: SyncRequest, project: AgentProject): Promise<SyncResponse> {
    const git = await this.git(project);
    const head = await git.snapshot(`Nautilus local preview ${now()}`);

    const baseHead = await this.reconcileBase(request, project, git);
    const changes = await git.diff(baseHead, head);
    return response(request.requestId, {
      status: "ok",
      state: {
        projectId: project.id,
        head,
        baseHead,
        dirty: false,
        changes,
      },
      diff: changes,
    });
  }

  private async createBundle(request: SyncRequest, project: AgentProject): Promise<SyncResponse> {
    const git = await this.git(project);
    const head = await git.snapshot(`Nautilus local snapshot ${now()}`);

    const baseHead = await this.reconcileBase(request, project, git);
    const directory = this.projectDirectory(project, "bundles");
    const bundle = await git.createBundle(head, directory, baseHead);

    await rm(join(directory, `${head}.bundle`), { force: true });
    if (bundle.bytes.length > this.config.maxBundleBytes) {
      throw new SyncAgentError(
        "invalid",
        "bundle_too_large",
        "Bundle exceeds the configured size limit",
      );
    }
    return response(request.requestId, {
      status: "ok",
      bundle: {
        head: bundle.head,
        sha256: bundle.sha256,
        bytesBase64: Buffer.from(bundle.bytes).toString("base64"),
      },
      state: {
        projectId: project.id,
        head,
        baseHead,
        dirty: false,

        changes: emptyDiff(),
      },
    });
  }

  private async importBundle(
    request: SyncRequest,
    project: AgentProject,
    rawBundle?: Uint8Array,
  ): Promise<SyncResponse> {
    const payload = request.payload;
    if (typeof payload.head !== "string" || typeof payload.sha256 !== "string") {
      throw new SyncAgentError("invalid", "invalid_bundle", "Bundle metadata is incomplete");
    }
    const bytes = rawBundle
      ? Buffer.from(rawBundle)
      : typeof payload.bytesBase64 === "string"
        ? Buffer.from(payload.bytesBase64, "base64")
        : undefined;
    if (!bytes) {
      throw new SyncAgentError("invalid", "invalid_bundle", "Bundle body is missing");
    }
    if (bytes.length > this.config.maxBundleBytes) {
      throw new SyncAgentError(
        "invalid",
        "bundle_too_large",
        "Bundle exceeds the configured size limit",
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== payload.sha256 || (request.digest !== undefined && request.digest !== digest)) {
      throw new SyncAgentError("invalid", "bundle_digest_mismatch", "Bundle digest does not match");
    }
    const bundle: SyncBundle = {
      bytes,
      sha256: payload.sha256,
      head: payload.head,
    };
    const git = await this.git(project);
    await git.importBundle(bundle, request.baseHead);
    return response(request.requestId, {
      status: "ok",
      state: {
        projectId: project.id,
        head: await git.head(),
        baseHead: request.baseHead,
        dirty: !(await git.isClean()),
        changes: emptyDiff(),
      },
    });
  }

  private async preflight(request: SyncRequest, project: AgentProject): Promise<SyncResponse> {
    const baseHead =
      request.baseHead === null ? null : this.requiredHead(request.baseHead, "baseHead");
    const localHead = this.requiredHead(request.expectedLocalHead, "expectedLocalHead");
    const remoteHead = this.requiredHead(request.expectedRemoteHead, "expectedRemoteHead");
    const git = await this.git(project);
    if ((await git.head()) !== localHead)
      throw new SyncAgentError("stale", "stale_local_head", "Local head changed before preflight");
    if (!(await git.isClean()))
      throw new SyncAgentError(
        "conflict",
        "local_worktree_dirty",
        "Local worktree has unexpected changes",
      );
    const mergeBase = baseHead ?? (await git.mergeBase());
    const resolutions = parseResolutions(request.payload.resolutions);
    const merge = await git.mergeTree(mergeBase, localHead, remoteHead, pullPicks(resolutions));
    if (!merge.clean || !merge.tree) {
      return response(request.requestId, {
        status: "conflict",
        conflicts: pullConflicts(merge.conflicts),
      });
    }
    const preflight: Preflight = {
      id: randomUUID(),
      projectId: project.id,
      baseHead,
      mergeBase,
      localHead,
      remoteHead,
      tree: merge.tree,
      resolutions,
      createdAt: now(),
    };
    await writeJson(
      join(this.projectDirectory(project, "preflights"), `${preflight.id}.json`),
      preflight,
    );
    return response(request.requestId, {
      status: "ok",
      applyToken: preflight.id,
      diff: await git.diff(baseHead, remoteHead),
    });
  }

  private async apply(
    request: SyncRequest,
    project: AgentProject,
    signal?: AbortSignal,
  ): Promise<SyncResponse> {
    const abandoned = () => {
      if (signal?.aborted)
        throw new SyncAgentError(
          "failed",
          "request_timeout",
          "The runner stopped waiting before the pull was applied",
        );
    };
    const token = this.headValue(request.payload.applyToken);
    if (!token)
      throw new SyncAgentError("invalid", "invalid_apply_token", "Apply token is required");
    const preflightPath = join(this.projectDirectory(project, "preflights"), `${token}.json`);
    const preflight = await readJson<Preflight | undefined>(preflightPath, undefined);
    if (
      !preflight ||
      preflight.projectId !== project.id ||
      Date.parse(preflight.createdAt) + requestLifetimeMs < Date.now()
    ) {
      throw new SyncAgentError("stale", "expired_apply_token", "Apply token is expired or unknown");
    }
    const expectedLocalHead = this.requiredHead(request.expectedLocalHead, "expectedLocalHead");
    const expectedRemoteHead = this.requiredHead(request.expectedRemoteHead, "expectedRemoteHead");
    if (request.baseHead !== preflight.baseHead)
      throw new SyncAgentError("stale", "stale_base_head", "Base head changed before apply");
    if (expectedLocalHead !== preflight.localHead || expectedRemoteHead !== preflight.remoteHead)
      throw new SyncAgentError(
        "stale",
        "stale_expected_head",
        "Expected heads changed before apply",
      );
    const git = await this.git(project);
    if ((await git.head()) !== expectedLocalHead)
      throw new SyncAgentError("stale", "stale_local_head", "Local head changed before apply");
    if (!(await git.isClean()))
      throw new SyncAgentError(
        "conflict",
        "local_worktree_dirty",
        "Local worktree changed before apply",
      );
    const merge = await git.mergeTree(
      preflight.mergeBase,
      preflight.localHead,
      preflight.remoteHead,
      pullPicks(preflight.resolutions),
    );
    if (!merge.clean || !merge.tree)
      throw new SyncAgentError(
        "conflict",
        "content_conflict",
        "Merge is no longer clean",
        pullConflicts(merge.conflicts),
      );
    abandoned();
    await rm(preflightPath, { force: true });
    const previousBase = await this.base(project);
    const transaction: SyncTransaction = {
      requestId: request.requestId,
      projectId: project.id,
      direction: "pull",
      status: "prepared",
      baseHead: preflight.baseHead,
      expectedLocalHead: preflight.localHead,
      expectedRemoteHead: preflight.remoteHead,
      preflight: preflight.id,
      recoveryPath: null,
      previousBaseHead: previousBase,
      createdAt: now(),
      updatedAt: now(),
    };
    const transactionPath = join(
      this.projectDirectory(project, "transactions"),
      `${request.requestId}.json`,
    );
    const recoveryPath = join(
      this.projectDirectory(project, "recovery"),
      `${request.requestId}.json`,
    );

    const backupBundle = await git.createBundle(
      preflight.localHead,
      join(this.config.backupPath, project.id, "bundles"),
      null,
    );
    const backupPath = join(this.config.backupPath, project.id, `${request.requestId}.bundle`);
    const backupFile = await open(backupPath, "w", 0o600);
    try {
      await backupFile.writeFile(backupBundle.bytes);
      await backupFile.sync();
    } finally {
      await backupFile.close();
    }

    await rm(join(this.config.backupPath, project.id, "bundles"), {
      recursive: true,
      force: true,
    });
    await writeJson(recoveryPath, {
      head: preflight.localHead,
      baseHead: previousBase,
      bundlePath: backupPath,
    });
    transaction.recoveryPath = recoveryPath;

    abandoned();
    await writeJson(transactionPath, transaction);
    try {
      const mergedHead = await git.applyTree(
        merge.tree,
        [preflight.localHead, preflight.remoteHead],
        "Nautilus pull merge",
      );
      await this.setBase(project, preflight.remoteHead);
      transaction.status = "committed";
      transaction.resultHead = mergedHead;
      transaction.updatedAt = now();
      await writeJson(transactionPath, transaction);
      await this.appendEvent(project, {
        requestId: request.requestId,
        projectId: project.id,
        direction: "pull",
        status: "ok",
        baseHead: preflight.baseHead,
        localHead: mergedHead,
        remoteHead: preflight.remoteHead,
        errorCode: null,
        conflicts: [],
        createdAt: transaction.createdAt,
        committedAt: now(),
      });
      const result = response(request.requestId, {
        status: "ok",
        state: {
          projectId: project.id,
          head: mergedHead,
          baseHead: preflight.remoteHead,
          dirty: false,
          changes: emptyDiff(),
        },
      });
      await this.cacheResponse(request, result, project);
      await this.pruneHistory(project);
      return result;
    } catch (error) {
      if (transaction.status !== "committed") {
        await git.restoreHead(preflight.localHead).catch(() => undefined);
        if (previousBase === null) {
          await rm(this.stateFile(project), { force: true });
        } else {
          await this.setBase(project, previousBase);
        }
      }
      transaction.status = "failed";
      transaction.updatedAt = now();
      await writeJson(transactionPath, transaction);
      throw error;
    }
  }

  private async history(request: SyncRequest, project: AgentProject): Promise<SyncResponse> {
    return response(request.requestId, {
      status: "ok",
      history: await this.readEvents(project),
    });
  }

  private async authenticate(request: SyncRequest, allowReplay = false): Promise<void> {
    const nowMs = Date.now();
    const issued = Date.parse(request.issuedAt);
    const expires = Date.parse(request.expiresAt);
    if (
      !Number.isFinite(issued) ||
      !Number.isFinite(expires) ||
      issued > nowMs + clockSkewMs ||
      expires < nowMs - clockSkewMs ||
      expires <= issued
    ) {
      throw new SyncAgentError(
        "invalid",
        "request_expired",
        "Request timestamps are invalid or expired",
      );
    }
    if (!allowReplay && this.usedNonces.has(request.nonce))
      throw new SyncAgentError(
        "invalid",
        "request_replayed",
        "Request nonce has already been used",
      );
    const project = (await this.projects()).find((entry) => entry.id === request.projectId);
    if (!project)
      throw new SyncAgentError("invalid", "project_not_configured", "Project is not configured");
    try {
      await this.authenticateRequest(request);
    } catch (error) {
      if (error instanceof GrantError)
        throw new SyncAgentError("invalid", error.code, error.message);
      throw error;
    }
    if (!allowReplay) {
      this.usedNonces.add(request.nonce);
      const path = join(this.projectDirectory(project, "transactions"), "nonces.json");
      const nonces = await readJson<string[]>(path, []);
      await writeJson(path, [...nonces.slice(-999), request.nonce]);
    }
  }

  private async cachedResponse(
    request: SyncRequest,
    project: AgentProject,
  ): Promise<SyncResponse | undefined> {
    const path = join(this.projectDirectory(project, "requests"), `${request.requestId}.json`);
    const cached = await readJson<CachedSyncResponse | undefined>(path, undefined);
    return cached?.digest === requestDigest(request) ? cached.response : undefined;
  }

  private async cacheResponse(
    request: SyncRequest,
    value: SyncResponse,
    project: AgentProject,
  ): Promise<void> {
    await writeJson(join(this.projectDirectory(project, "requests"), `${request.requestId}.json`), {
      digest: requestDigest(request),
      response: value,
    } satisfies CachedSyncResponse);
  }

  private async recordFailure(
    request: SyncRequest,
    project: AgentProject,
    result: SyncResponse,
  ): Promise<void> {
    if (!["create_bundle", "import_bundle", "preflight", "apply"].includes(request.operation))
      return;
    await this.appendEvent(project, {
      requestId: request.requestId,
      projectId: project.id,
      direction: request.operation === "create_bundle" ? "push" : "pull",
      status: result.status,
      baseHead: request.baseHead,
      localHead: request.expectedLocalHead,
      remoteHead: request.expectedRemoteHead,
      errorCode: result.error?.code ?? null,
      conflicts: result.conflicts ?? result.error?.conflicts ?? [],
      createdAt: now(),
      committedAt: null,
    });
  }

  private async appendEvent(project: AgentProject, event: SyncEvent): Promise<void> {
    const events = await this.readEvents(project);
    const existing = events.findIndex((entry) => entry.requestId === event.requestId);
    if (existing === -1) events.push(event);
    else events[existing] = event;
    await writeJson(
      join(this.projectDirectory(project, "events"), "history.json"),
      events.slice(-1000),
    );
  }

  private async readEvents(project: AgentProject): Promise<SyncEvent[]> {
    return readJson<SyncEvent[]>(
      join(this.projectDirectory(project, "events"), "history.json"),
      [],
    );
  }

  private async git(project: AgentProject): Promise<ShadowGit> {
    const existing = this.gitByProject.get(project.id);
    if (existing) return existing;
    const git = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.localPath,
      limits: {
        maxFileBytes: this.config.maxFileBytes,
        maxTotalBytes: this.config.maxTotalBytes,
        maxFileCount: this.config.maxFileCount,
      },
    });
    await git.initialize();
    this.gitByProject.set(project.id, git);
    return git;
  }

  private async withLock<T>(project: AgentProject, action: () => Promise<T>): Promise<T> {
    try {
      return await withLock(join(this.config.transactionPath, `${project.id}.lock`), action);
    } catch (error) {
      if (error instanceof LockBusyError)
        throw new SyncAgentError("conflict", "project_busy", error.message);
      throw error;
    }
  }

  private async pruneHistory(project: AgentProject): Promise<void> {
    await pruneFiles(join(this.config.backupPath, project.id), {
      keep: 3,
      suffix: ".bundle",
    });
    await pruneFiles(this.projectDirectory(project, "recovery"), {
      keep: 3,
      suffix: ".json",
    });
    await pruneFiles(this.projectDirectory(project, "transactions"), {
      keep: 50,
      suffix: ".json",
      protect: async (path) => {
        if (path.endsWith("nonces.json")) return true;
        const transaction = await readJson<SyncTransaction | undefined>(path, undefined);
        return transaction?.status === "prepared" || transaction?.status === "applied";
      },
    });
    await pruneFiles(this.projectDirectory(project, "requests"), {
      keep: 200,
      suffix: ".json",
    });
    await pruneFiles(this.projectDirectory(project, "preflights"), {
      keep: 20,
      suffix: ".json",
    });
  }

  private projectDirectory(project: AgentProject, kind: string): string {
    const root = join(this.config.transactionPath, project.id);
    return kind === "" ? root : join(root, kind);
  }

  private async reconcileBase(
    request: SyncRequest,
    project: AgentProject,
    git: ShadowGit,
  ): Promise<string | null> {
    const current = await this.base(project);
    if (!("runnerBase" in request.payload)) return current;
    const runnerBase = request.payload.runnerBase;
    if (runnerBase === null) {
      if (current !== null) await rm(this.stateFile(project), { force: true });
      return null;
    }
    if (typeof runnerBase !== "string" || runnerBase === current) return current;
    const head = await git.head();
    if (!/^[0-9a-f]{40,64}$/.test(runnerBase) || head === null) return current;
    if (!(await git.isAncestor(runnerBase, head))) return current;
    await this.setBase(project, runnerBase);
    return runnerBase;
  }

  private stateFile(project: AgentProject): string {
    return this.projectDirectory(project, join("state", "base.json"));
  }

  private async base(project: AgentProject): Promise<string | null> {
    return readJson<string | null>(this.stateFile(project), null);
  }

  private async setBase(project: AgentProject, value: string): Promise<void> {
    await writeJson(this.stateFile(project), value);
  }

  private requiredHead(value: string | null | undefined, name: string): string {
    if (!value || !/^[0-9a-f]{40,64}$/.test(value))
      throw new SyncAgentError("invalid", `invalid_${name}`, `${name} is required`);
    return value;
  }

  private headValue(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }
}

export class SyncAgentError extends Error {
  constructor(
    readonly status: SyncStatus,
    readonly code: string,
    message: string,
    readonly conflicts?: SyncConflict[],
  ) {
    super(message);
    this.name = "SyncAgentError";
  }
}

function emptyDiff(): SyncDiff {
  return { files: [], additions: 0, deletions: 0 };
}
