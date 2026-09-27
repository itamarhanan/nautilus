import * as api from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import { writeLocation } from "@/lib/location";
import { sessionTitle } from "@/lib/project";
import { runPending } from "./pending";
import { mergeSessionList, pickSessionId, replaceById } from "./reducers";
import { locationOf } from "./selectors";
import { openSession } from "./state";
import type { GetState, SetState, WorkspaceActions } from "./state";

type ProjectActions = Pick<
  WorkspaceActions,
  "loadProject" | "changeProjectState" | "createSession" | "previewUrl"
>;

export function projectActions(set: SetState, get: GetState): ProjectActions {
  return {
    loadProject: async (projectId, { background = false } = {}) => {
      try {
        const [sessions, syncHistory] = await Promise.all([
          api.listSessions(projectId),

          api.getSyncHistory(projectId).catch(() => null),
        ]);
        const state = get();
        if (state.project?.id !== projectId) return;
        const currentId = state.session?.id ?? null;
        const sessionId = pickSessionId(sessions, currentId);
        set({
          project: {
            id: projectId,
            sessions: mergeSessionList(sessions, state.project.sessions),
            syncHistory: syncHistory ?? state.project.syncHistory,
            isLoaded: true,
          },
          session:
            sessionId === currentId ? state.session : sessionId ? openSession(sessionId) : null,
        });

        if (sessionId !== currentId) writeLocation(locationOf(get()), "replace");
      } catch (error) {
        if (!background && get().project?.id === projectId) {
          set({ error: errorMessage(error, "Unable to load this project") });
        }
      }
    },

    changeProjectState: async (action) => {
      const projectId = get().project?.id;
      if (!projectId || get().pending.projectControl) return;
      await runPending(
        set,
        get,
        "projectControl",
        action,
        async () => {
          const project = await api.setProjectRunning(projectId, action);
          set((state) => ({ projects: replaceById(state.projects, project) }));
        },
        `Unable to ${action} project`,
      );
    },

    createSession: async () => {
      const projectId = get().project?.id;
      if (!projectId || get().pending.newSession) return;
      await runPending(
        set,
        get,
        "newSession",
        true,
        async () => {
          const session = await api.createSession(projectId, sessionTitle(new Date()));
          if (get().project?.id !== projectId) return;
          set((state) => ({
            project: state.project && {
              ...state.project,
              sessions: [session, ...state.project.sessions],
            },

            session: { ...openSession(session.id), isSnapshotLoaded: true },
            view: "chat",
            isInfoOpen: false,
          }));
          writeLocation(locationOf(get()), "push");
        },
        "Unable to create session",
      );
    },

    previewUrl: async () => {
      const projectId = get().project?.id;
      if (!projectId) throw new Error("Select a project first");
      return api.createPreviewUrl(projectId);
    },
  };
}
