"use client";

import { create } from "zustand";
import type { ProjectRecord, SessionRecord } from "@nautilus/types";
import { authActions } from "./auth";
import { modelActions } from "./models";
import { navigationActions } from "./navigation";
import { projectActions } from "./project";
import { openSessionRecord, selectedProject } from "./selectors";
import { sessionActions } from "./session";
import { initialData } from "./state";
import type { WorkspaceActions, WorkspaceState } from "./state";

export type { WorkspaceState } from "./state";

export function createWorkspaceStore() {
  return create<WorkspaceState>()((set, get) => ({
    ...initialData,
    actions: {
      ...authActions(set, get),
      ...modelActions(set, get),
      ...navigationActions(set, get),
      ...projectActions(set, get),
      ...sessionActions(set, get),
    },
  }));
}

export const useWorkspace = createWorkspaceStore();

export function useActions(): WorkspaceActions {
  return useWorkspace((state) => state.actions);
}

export function useSelectedProject(): ProjectRecord | null {
  return useWorkspace(selectedProject);
}

export function useOpenSessionRecord(): SessionRecord | null {
  return useWorkspace(openSessionRecord);
}
