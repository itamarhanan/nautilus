import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  ProjectConfig,
  SyncBundle,
  SyncEvent,
  SyncRequest,
  SyncResponse,
  SyncStatusResponse,
} from "@nautilus/types";
import { readJson, ShadowGit, type ShadowGitLimits } from "@nautilus/shadow-git";

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

  connect(hooks: Pick<CoordinatorOptions, "onEvent" | "onFirstSync" | "busy">): void {
    Object.assign(this.options, hooks);
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

  private projectState(projectId: string): string {
    return join(this.options.statePath, projectId);
  }

  private eventsPath(projectId: string): string {
    return join(this.projectState(projectId), "events.json");
  }

  private basePath(projectId: string): string {
    return join(this.projectState(projectId), "base.json");
  }
}
