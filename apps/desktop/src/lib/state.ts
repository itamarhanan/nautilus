import type { FolderCandidate } from "./folders";

export type StateProject = {
  id: string;
  name: string;

  localPath: string;

  devCommand: string;
  addedAt: string;
  acknowledgedExclusions: string[];
};

type RecentFolder = {
  path: string;
  lastUsedAt: string;
};

export type AppState = {
  version: 1;
  projects: StateProject[];
  recentFolders: RecentFolder[];
  lastProjectId: string | null;
  scan: {
    scannedAt: string;
    roots: string[];
    folders: FolderCandidate[];
  } | null;
};

export const maxRecentFolders = 20;

export const emptyState: AppState = {
  version: 1,
  projects: [],
  recentFolders: [],
  lastProjectId: null,
  scan: null,
};

const projectIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readState(value: unknown): AppState {
  const input = record(value) ?? {};
  const projects = (Array.isArray(input.projects) ? input.projects : [])
    .map(record)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .filter(
      (entry) =>
        typeof entry.id === "string" &&
        projectIdPattern.test(entry.id) &&
        typeof entry.localPath === "string",
    )
    .map((entry) => {
      const addedAt = typeof entry.addedAt === "string" ? entry.addedAt : new Date(0).toISOString();
      const localPath = entry.localPath as string;
      return {
        id: entry.id as string,
        name: typeof entry.name === "string" && entry.name ? entry.name : (entry.id as string),
        localPath,
        devCommand:
          typeof entry.devCommand === "string" && entry.devCommand
            ? entry.devCommand
            : "npm run dev",
        addedAt,
        acknowledgedExclusions: (Array.isArray(entry.acknowledgedExclusions)
          ? entry.acknowledgedExclusions
          : []
        )
          .filter((value): value is string => typeof value === "string")

          .map((value) => value.replace(/^default:/, "")),
      };
    });
  const recentFolders = (Array.isArray(input.recentFolders) ? input.recentFolders : [])
    .map(record)
    .filter(
      (entry): entry is Record<string, unknown> =>
        entry !== undefined &&
        typeof entry.path === "string" &&
        typeof entry.lastUsedAt === "string",
    )
    .map((entry) => ({
      path: entry.path as string,
      lastUsedAt: entry.lastUsedAt as string,
    }))
    .slice(0, maxRecentFolders);
  const scan = record(input.scan);
  return {
    version: 1,
    projects,
    recentFolders,
    lastProjectId:
      typeof input.lastProjectId === "string" &&
      projects.some((project) => project.id === input.lastProjectId)
        ? input.lastProjectId
        : null,
    scan:
      scan && typeof scan.scannedAt === "string" && Array.isArray(scan.folders)
        ? {
            scannedAt: scan.scannedAt,
            roots: Array.isArray(scan.roots)
              ? scan.roots.filter((root) => typeof root === "string")
              : [],
            folders: scan.folders as FolderCandidate[],
          }
        : null,
  };
}

export function touchRecent(state: AppState, path: string, now = new Date()): AppState {
  const recentFolders = [
    { path, lastUsedAt: now.toISOString() },
    ...state.recentFolders.filter((entry) => entry.path !== path),
  ].slice(0, maxRecentFolders);
  return { ...state, recentFolders };
}

export function withProject(state: AppState, project: StateProject): AppState {
  return touchRecent(
    {
      ...state,
      projects: [...state.projects.filter((entry) => entry.id !== project.id), project],
      lastProjectId: project.id,
    },
    project.localPath,
    new Date(project.addedAt),
  );
}

export function withoutProject(state: AppState, projectId: string): AppState {
  return {
    ...state,
    projects: state.projects.filter((entry) => entry.id !== projectId),
    lastProjectId: state.lastProjectId === projectId ? null : state.lastProjectId,
  };
}

export function projectIdForFolder(name: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const base = /^[a-z0-9]/.test(slug) ? slug : `project-${slug || "folder"}`.slice(0, 60);
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${String(suffix)}`;
  return id;
}
