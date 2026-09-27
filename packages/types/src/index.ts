export type RunnerLifecycleState =
  | "stopped"
  | "starting"
  | "installing"
  | "ready"
  | "degraded"
  | "restarting"
  | "stopped-by-user"
  | "error";

export type RecoverySummary = {
  state: RunnerLifecycleState;
  startedAt: string;
  updatedAt: string;
  recovered: boolean;
  interruptedSessions: number;
  degradedProjects: string[];
  reason: string | null;
};

export type HealthResponse = {
  status: "ok";
  service: "nautilus-server";
  lifecycle: RecoverySummary;
  activeProject?: ProjectRecord | undefined;
};

export type SyncDirection = "pull" | "push";

export type SyncOperation =
  | "health"
  | "state"
  | "preview"
  | "create_bundle"
  | "import_bundle"
  | "preflight"
  | "apply"
  | "history";

export type SyncStatus =
  | "ok"
  | "offline"
  | "conflict"
  | "stale"
  | "invalid"
  | "failed"
  | "recovering";

export type ConflictChange = "added" | "modified" | "deleted";

export type SyncConflict = {
  path: string;
  reason: string;
  pc?: ConflictChange | undefined;
  runner?: ConflictChange | undefined;
};

export type ConflictResolution = "pc" | "runner";

export type SyncResolutions = Record<string, ConflictResolution>;

const maxResolutions = 1_000;

export function parseResolutions(value: unknown): SyncResolutions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const resolutions: SyncResolutions = {};
  for (const [path, side] of Object.entries(value as Record<string, unknown>).slice(
    0,
    maxResolutions,
  )) {
    if (path.length === 0 || path.length > 4096 || path.includes("\0")) continue;
    if (side === "pc" || side === "runner") resolutions[path] = side;
  }
  return resolutions;
}

export type SyncFileChange = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string | undefined;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: SyncDiffHunk[];
  omitted?: "generated" | "large" | "limit" | undefined;
};

const generatedFileNames = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
]);

export function isGeneratedFile(path: string): boolean {
  return generatedFileNames.has(path.slice(path.lastIndexOf("/") + 1));
}

export type SyncDiffLine = {
  type: "context" | "addition" | "deletion";
  oldLine: number | null;
  newLine: number | null;
  content: string;
};

export type SyncDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: SyncDiffLine[];
};

export type SyncDiff = {
  files: SyncFileChange[];
  additions: number;
  deletions: number;
};

export type SyncState = {
  projectId: string;
  head: string | null;
  baseHead: string | null;
  dirty: boolean;
  changes: SyncDiff;

  excludedRepositories?: string[] | undefined;
};
export type ProjectId = string;

export type ProjectState =
  | "inactive"
  | "starting"
  | "running"
  | "editing"
  | "checkpointing"
  | "idle"
  | "unhealthy"
  | "stopped"
  | "error";

export type ProjectConfig = {
  id: ProjectId;
  name: string;
  remotePath: string;
  devCommand: string;
  devPort: number;
  previewPath: string;
};

export type ProjectRecord = ProjectConfig & {
  state: ProjectState;
  lastError: string | null;
  startedAt: string | null;
  firstSyncAt: string | null;
  updatedAt: string;
};

export type PairingCodeResponse = {
  id: string;
  code: string;
  expiresAt: string;
};

export type DeviceResponse = {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
};

export type BootstrapResponse = {
  device: DeviceResponse | null;
  projects: ProjectRecord[];
  lifecycle: RecoverySummary;
  activeProject: ProjectRecord | null;
};

export type PreviewTokenResponse = {
  token: string;
  projectId: ProjectId;
  previewPath: string;
  previewUrl?: string | undefined;
  expiresAt: string;
};

export type SessionStatus = "idle" | "running" | "interrupted" | "error";

export type SessionRecord = {
  id: string;
  projectId: ProjectId;
  openCodeSessionId: string;
  title: string;
  status: SessionStatus;
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
};

export type SessionEventType =
  | "session.started"
  | "session.retry"
  | "session.message"
  | "session.delta"
  | "session.tool"
  | "session.todo"
  | "session.file_change"
  | "session.permission"
  | "session.checkpoint"
  | "session.completed"
  | "session.interrupted"
  | "session.error";

export type SessionEvent = {
  sessionId: string;
  projectId: ProjectId;
  sequence: number;
  timestamp: string;
  type: SessionEventType;
  durable: boolean;
  payload: Record<string, unknown>;
};

export type SubagentTag = { subagent?: string | undefined };

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
  priority: "high" | "medium" | "low";
};

export type SessionSnapshot = {
  session: SessionRecord;
  events: SessionEvent[];
};

export type ModelRef = {
  providerId: string;
  modelId: string;
  variant?: string | undefined;
};

export type AgentModel = ModelRef & {
  name: string;
  providerName: string;
  isReasoning: boolean;

  contextLimit: number | null;

  variants: string[];
};

export type ModelsResponse = {
  models: AgentModel[];

  default: ModelRef | null;
};
