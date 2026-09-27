import type {
  AgentModel,
  ModelRef,
  DeviceResponse,
  ProjectRecord,
  RecoverySummary,
  SessionEvent,
  SessionRecord,
  SessionSnapshot,
  SyncEvent,
} from "@nautilus/types";
import type { StoreApi } from "zustand";
import type { AppLocation, ProjectView } from "@/lib/location";
import type { PermissionResponse } from "@/lib/transcript";
import { idleStream } from "@/lib/stream/session-stream";
import type { StreamState } from "@/lib/stream/session-stream";

type AuthState = "loading" | "authenticated" | "unauthenticated" | "unavailable";

type RunnerState = {
  lifecycle: RecoverySummary | null;

  isReachable: boolean;
  error: string | null;
};

export type OpenProject = {
  id: string;
  sessions: SessionRecord[];
  syncHistory: SyncEvent[];

  isLoaded: boolean;
};

export type OpenSession = {
  id: string;
  events: SessionEvent[];
  isSnapshotLoaded: boolean;

  awaitingEvent: boolean;
  streaming: Record<string, string>;

  outgoing: { text: string; timestamp: string } | null;
};

export type Pending = {
  pair: boolean;
  projectControl: "start" | "stop" | null;
  newSession: boolean;
  turn: "prompt" | "retry" | null;
  interrupt: boolean;

  permission: string | null;

  revert: string | null;
};

export type ModelCatalog = {
  status: "idle" | "loading" | "ready" | "error";
  models: AgentModel[];

  default: ModelRef | null;
};

export type WorkspaceData = {
  auth: AuthState;
  device: DeviceResponse | null;
  projects: ProjectRecord[];
  runner: RunnerState;
  online: boolean;
  connection: StreamState;
  project: OpenProject | null;
  session: OpenSession | null;
  view: ProjectView;
  isInfoOpen: boolean;
  isSignOutConfirmOpen: boolean;

  drafts: Record<string, string>;
  models: ModelCatalog;

  model: ModelRef | null;
  pending: Pending;

  error: string | null;
};

export type WorkspaceActions = {
  bootstrap: () => Promise<void>;

  refresh: () => Promise<void>;
  pair: (code: string, deviceName: string) => Promise<void>;
  signOut: () => Promise<void>;
  signOutLocally: () => void;

  setOnline: (online: boolean) => void;
  setConnection: (connection: StreamState) => void;
  selectProject: (id: string, mode?: "push" | "replace") => void;
  selectSession: (projectId: string, sessionId: string) => void;
  setView: (view: ProjectView) => void;
  setInfoOpen: (open: boolean) => void;
  setSignOutConfirmOpen: (open: boolean) => void;

  navigate: (location: AppLocation) => void;
  setDraft: (sessionId: string, text: string) => void;
  clearError: () => void;

  loadProject: (projectId: string, options?: { background?: boolean }) => Promise<void>;
  changeProjectState: (action: "start" | "stop") => Promise<void>;
  createSession: () => Promise<void>;
  previewUrl: () => Promise<string>;

  loadModels: () => Promise<void>;
  setModel: (model: ModelRef | null) => void;

  sendPrompt: (text: string) => Promise<boolean>;
  retrySession: () => Promise<void>;
  interruptSession: () => Promise<void>;
  respondToPermission: (permissionId: string, response: PermissionResponse) => Promise<void>;

  revertCheckpoint: (commit: string) => Promise<void>;
  applySnapshot: (snapshot: SessionSnapshot) => void;
  applyEvent: (event: SessionEvent) => void;
};

export type WorkspaceState = WorkspaceData & { actions: WorkspaceActions };

export type SetState = StoreApi<WorkspaceState>["setState"];
export type GetState = StoreApi<WorkspaceState>["getState"];

export const idlePending: Pending = {
  pair: false,
  projectControl: null,
  newSession: false,
  turn: null,
  interrupt: false,
  permission: null,
  revert: null,
};

const emptyCatalog: ModelCatalog = {
  status: "idle",
  models: [],
  default: null,
};

export function openProject(id: string): OpenProject {
  return { id, sessions: [], syncHistory: [], isLoaded: false };
}

export function openSession(id: string): OpenSession {
  return {
    id,
    events: [],
    isSnapshotLoaded: false,
    awaitingEvent: false,
    streaming: {},
    outgoing: null,
  };
}

export const initialData: WorkspaceData = {
  auth: "loading",
  device: null,
  projects: [],
  runner: { lifecycle: null, isReachable: true, error: null },
  online: true,
  connection: idleStream,
  project: null,
  session: null,
  view: "chat",
  isInfoOpen: false,
  isSignOutConfirmOpen: false,
  drafts: {},
  models: emptyCatalog,
  model: null,
  pending: idlePending,
  error: null,
};
