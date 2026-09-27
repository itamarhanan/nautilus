import { writeLocation } from "@/lib/location";
import { rememberDrafts, rememberProject } from "@/lib/storage";
import { locationOf } from "./selectors";
import { openProject, openSession } from "./state";
import type { GetState, SetState, WorkspaceActions, WorkspaceData } from "./state";

type NavigationActions = Pick<
  WorkspaceActions,
  | "setOnline"
  | "setConnection"
  | "selectProject"
  | "selectSession"
  | "setView"
  | "setInfoOpen"
  | "setSignOutConfirmOpen"
  | "navigate"
  | "setDraft"
  | "clearError"
>;

export function navigationActions(set: SetState, get: GetState): NavigationActions {
  const record = (mode: "push" | "replace") => {
    writeLocation(locationOf(get()), mode);
  };

  const openProjectById = (id: string) => {
    set({ project: openProject(id), session: null, view: "chat" });
    rememberProject(id);
    void get().actions.loadProject(id);
  };

  return {
    setOnline: (online) => {
      set({ online });
    },
    setConnection: (connection) => {
      set({ connection });
    },

    selectProject: (id, mode = "push") => {
      if (get().project?.id !== id) openProjectById(id);
      set({ isInfoOpen: false });
      record(mode);
    },

    selectSession: (projectId, sessionId) => {
      if (get().project?.id !== projectId) openProjectById(projectId);
      set((state) => ({
        session: state.session?.id === sessionId ? state.session : openSession(sessionId),
        view: "chat",
        isInfoOpen: false,
        error: null,
      }));
      record("push");
    },

    setView: (view) => {
      if (get().view === view) return;
      set({ view });
      record("push");
    },

    setInfoOpen: (isInfoOpen) => {
      if (get().isInfoOpen === isInfoOpen) return;
      set({ isInfoOpen });
      record("push");
    },

    setSignOutConfirmOpen: (isSignOutConfirmOpen) => {
      set({ isSignOutConfirmOpen });
    },

    navigate: (location) => {
      const state = get();
      const projectChanged = location.projectId !== (state.project?.id ?? null);
      const next: Partial<WorkspaceData> = {
        view: location.view,
        isInfoOpen: location.isInfoOpen,
      };
      if (projectChanged) {
        next.project = location.projectId ? openProject(location.projectId) : null;
      }
      if (projectChanged || location.sessionId !== (state.session?.id ?? null)) {
        next.session = location.sessionId ? openSession(location.sessionId) : null;
      }
      set(next);
      if (projectChanged && location.projectId) {
        rememberProject(location.projectId);
        void get().actions.loadProject(location.projectId);
      }
    },

    setDraft: (sessionId, text) => {
      set((state) => ({ drafts: { ...state.drafts, [sessionId]: text } }));
      rememberDrafts(get().drafts);
    },
    clearError: () => {
      set({ error: null });
    },
  };
}
