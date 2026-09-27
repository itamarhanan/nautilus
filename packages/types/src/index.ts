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
