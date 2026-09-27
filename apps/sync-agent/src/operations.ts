import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { loadStateProjects, type AgentConfig, type AgentProject } from "./config";
import { GrantError } from "./grants";
import { validateSyncRequest } from "./protocol";
import {
  LockBusyError,
  readJson,
  ShadowGit,
  ShadowGitError,
  withLock,
  writeJson,
} from "@nautilus/shadow-git";
import type {
  SyncConflict,
  SyncDiff,
  SyncEvent,
  SyncRequest,
  SyncResponse,
  SyncStatus,
} from "@nautilus/types";

const responseVersion = 1 as const;
const clockSkewMs = 60 * 1000;

type JsonRecord = Record<string, unknown>;

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

  async handle(value: unknown): Promise<SyncResponse> {
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
        const result = await this.dispatch(request, project);
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

  private async dispatch(request: SyncRequest, project: AgentProject): Promise<SyncResponse> {
    switch (request.operation) {
      case "state":
        return this.state(request, project);
      case "preview":
        return this.preview(request, project);
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
