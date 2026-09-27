import type { ProjectRecord, SessionRecord } from "@nautilus/types";
import type { AppLocation } from "@/lib/location";
import type { WorkspaceData } from "./state";

export function selectedProject(state: WorkspaceData): ProjectRecord | null {
  const id = state.project?.id;
  return id ? (state.projects.find((project) => project.id === id) ?? null) : null;
}

export function openSessionRecord(state: WorkspaceData): SessionRecord | null {
  const id = state.session?.id;
  return id ? (state.project?.sessions.find((session) => session.id === id) ?? null) : null;
}

export function openSessionId(state: WorkspaceData): string | null {
  return state.session?.id ?? null;
}

export function locationOf(state: WorkspaceData): AppLocation {
  return {
    projectId: state.project?.id ?? null,
    sessionId: state.session?.id ?? null,
    view: state.view,
    isInfoOpen: state.isInfoOpen,
  };
}
