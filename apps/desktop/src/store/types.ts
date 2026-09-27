import type {
  ConflictResolution,
  DeviceResponse,
  LocalSyncStatusResponse,
  PairingCodeResponse,
  ProjectRecord,
  SyncConflict,
  SyncDirection,
  SyncEvent,
  SyncFileChange,
  SyncResolutions,
  SyncResponse,
  SyncStatusResponse,
} from "@nautilus/types";
import type { AgentProcess, AgentSnapshot } from "../lib/agent";
import type { ConnectionSnapshot, ControlChannel } from "../lib/control";
import type { DesktopPaths } from "../lib/files";
import type { FolderCandidate, FolderIo } from "../lib/folders";
import type { Spawner } from "../lib/process";
import type { DesktopSettings, SettingsErrors } from "../lib/settings";
import type { AppState } from "../lib/state";
import type { SyncStep } from "../lib/sync";

export type ProjectTab = "overview" | "settings";
export type SettingsSection = "runner" | "search" | "phones" | "about";

export type Route =
  | { name: "home" }
  | { name: "project"; tab: ProjectTab }
  | { name: "settings"; section: SettingsSection };

export const homeRoute: Route = { name: "home" };

export type ProjectStatus = {
  runner: SyncStatusResponse | null;
  local: LocalSyncStatusResponse | null;
  error: string | null;
  errorCode: string | null;
  checkedAt: number | null;
};

type ReviewPhase = "preparing" | "ready" | "applying" | "resolving" | "done" | "blocked" | "failed";

export type Review = {
  id: number;
  projectId: string;
  direction: SyncDirection;
  phase: ReviewPhase;
  step: SyncStep | null;
  preview: SyncResponse | null;
  result: SyncResponse | null;
  error: string | null;

  resolutions: SyncResolutions;

  background: boolean;
};

export type Notice = {
  id: number;
  tone: "success" | "error" | "warning" | "info";
  title: string;
  body?: string;
};

type Pairing = PairingCodeResponse & { url: string };

export function conflictsOf(response: SyncResponse | null | undefined): SyncConflict[] {
  return response?.conflicts ?? response?.error?.conflicts ?? [];
}

type DesktopState = {
  ready: boolean;
  bootError: string | null;
  localMode: boolean;

  home: string;
  settings: DesktopSettings;
  settingsExist: boolean;
  appState: AppState;
  connection: ConnectionSnapshot;
  agent: AgentSnapshot;
  projects: ProjectRecord[];
  devices: DeviceResponse[];
  selectedProjectId: string | null;
  status: Partial<Record<string, ProjectStatus>>;
  history: Partial<Record<string, SyncEvent[]>>;
  route: Route;

  settingsReturn: Route;
  paletteOpen: boolean;
  linkPhoneOpen: boolean;
  pairing: Pairing | null;
  pairingError: string | null;
  review: Review | null;

  undoingPull: string | null;
  scanning: boolean;
  notices: Notice[];
};

export type DesktopActions = {
  init: () => Promise<void>;
  navigate: (route: Route) => void;

  goUp: () => void;
  selectProject: (projectId: string, tab?: ProjectTab) => void;
  setPaletteOpen: (open: boolean) => void;
  setLinkPhoneOpen: (open: boolean) => void;
  refreshRunner: () => Promise<void>;
  refreshStatus: (projectId?: string) => Promise<void>;

  refreshHistory: (projectId?: string) => Promise<void>;
  scan: (force?: boolean) => Promise<void>;
  addProject: (input: {
    folder: FolderCandidate;
    name: string;
    devCommand: string;
  }) => Promise<void>;

  updateProject: (
    projectId: string,
    changes: { name: string; devCommand: string },
  ) => Promise<string | null>;
  removeProject: (projectId: string) => Promise<void>;
  reregisterProject: (projectId: string) => Promise<void>;
  touchFolder: (path: string) => void;
  newPairingCode: () => Promise<void>;
  refreshDevices: () => Promise<void>;
  revokeDevice: (deviceId: string) => Promise<void>;
  startReview: (direction: SyncDirection, projectId?: string) => Promise<void>;
  applyReview: () => Promise<void>;

  resolveConflicts: (paths: string[], side: ConflictResolution | null) => void;
  closeReview: () => Promise<void>;

  compareConflict: (path: string) => Promise<SyncFileChange>;

  openConflictFile: (path: string) => Promise<void>;

  undoPull: (projectId: string) => Promise<void>;
  saveSettings: (
    candidate: DesktopSettings,
  ) => Promise<SettingsErrors | "connection_failed" | null>;

  saveProjectRoots: (roots: string[]) => Promise<string | null>;
  reconnect: () => void;

  shutdown: () => Promise<void>;
  notify: (notice: Omit<Notice, "id">) => void;
  dismissNotice: (id: number) => void;
};

export type DesktopStore = DesktopState & DesktopActions;

export type DesktopServices = {
  paths: () => Promise<DesktopPaths>;
  loadSettings: (paths: DesktopPaths) => Promise<{ settings: DesktopSettings; exists: boolean }>;
  saveSettings: (paths: DesktopPaths, settings: DesktopSettings) => Promise<void>;
  loadState: (paths: DesktopPaths) => Promise<AppState>;
  saveState: (paths: DesktopPaths, state: AppState) => Promise<void>;
  folderIo: FolderIo;
  spawn: Spawner;
  channel: ControlChannel;
  agent: () => Promise<AgentProcess>;
  localMode: boolean;
  alert?: (title: string, body: string) => void;

  openFile: (projectPath: string, path: string) => Promise<void>;
};

export const emptyStatus: ProjectStatus = {
  runner: null,
  local: null,
  error: null,
  errorCode: null,
  checkedAt: null,
};
