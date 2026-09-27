import * as api from "@/lib/api/endpoints";
import { isTerminalEvent } from "@/lib/values";
import { runPending } from "./pending";
import { isUserPrompt, mergeEvents, replaceById, sessionAfter, streamingAfter } from "./reducers";
import { openSessionRecord } from "./selectors";
import type { GetState, OpenSession, SetState, WorkspaceActions } from "./state";

type SessionActions = Pick<
  WorkspaceActions,
  | "sendPrompt"
  | "retrySession"
  | "interruptSession"
  | "respondToPermission"
  | "revertCheckpoint"
  | "applySnapshot"
  | "applyEvent"
>;

export function sessionActions(set: SetState, get: GetState): SessionActions {
  const markAwaiting = (sessionId: string) => {
    set((state) =>
      state.session?.id === sessionId
        ? { session: { ...state.session, awaitingEvent: true } }
        : state,
    );
  };

  const setOutgoing = (sessionId: string, outgoing: OpenSession["outgoing"]) => {
    set((state) =>
      state.session?.id === sessionId ? { session: { ...state.session, outgoing } } : state,
    );
  };

  return {
    sendPrompt: (text) => {
      const state = get();
      const record = openSessionRecord(state);
      const prompt = text.trim();
      if (
        !record ||
        !prompt ||
        !state.session?.isSnapshotLoaded ||
        record.status === "running" ||
        state.pending.turn
      ) {
        return Promise.resolve(false);
      }

      setOutgoing(record.id, {
        text: prompt,
        timestamp: new Date().toISOString(),
      });
      return runPending(
        set,
        get,
        "turn",
        "prompt",
        async () => {
          const isFirstPrompt = !(state.session?.events ?? []).some(isUserPrompt);
          try {
            await api.sendPrompt(record.id, prompt, get().model);
          } catch (error) {
            setOutgoing(record.id, null);
            throw error;
          }
          markAwaiting(record.id);

          if (isFirstPrompt)
            void get().actions.loadProject(record.projectId, {
              background: true,
            });
        },
        "Unable to submit prompt",
      );
    },

    interruptSession: async () => {
      const state = get();
      const record = openSessionRecord(state);
      if (!record || state.pending.interrupt) return;
      if (record.status !== "running" && !state.session?.awaitingEvent) return;
      await runPending(
        set,
        get,
        "interrupt",
        true,
        () => api.interruptSession(record.id),
        "Unable to stop the agent",
      );
    },

    respondToPermission: async (permissionId, response) => {
      const state = get();
      const record = openSessionRecord(state);
      if (!record || state.pending.permission) return;

      await runPending(
        set,
        get,
        "permission",
        permissionId,
        () => api.respondToPermission(record.id, permissionId, response),
        "Unable to answer the agent",
      );
    },

    revertCheckpoint: async (commit) => {
      const state = get();
      const record = openSessionRecord(state);
      if (!record || state.pending.revert || record.status === "running") return;
      await runPending(
        set,
        get,
        "revert",
        commit,
        async () => {
          const result = await api.revertCheckpoint(record.id, commit);
          if (result.status === "conflict") {
            const files = result.conflicts.join(", ");
            throw new Error(
              `Later changes touch the same lines in ${files}, so nothing was undone.`,
            );
          }
        },
        "Unable to undo these changes",
      );
    },

    retrySession: async () => {
      const state = get();
      const record = openSessionRecord(state);
      if (!record || (record.status !== "interrupted" && record.status !== "error")) return;
      if (state.pending.turn) return;
      await runPending(
        set,
        get,
        "turn",
        "retry",
        async () => {
          await api.retrySession(record.id);
          markAwaiting(record.id);
        },
        "Unable to retry this turn",
      );
    },

    applySnapshot: (snapshot) => {
      set((state) => {
        if (state.session?.id !== snapshot.session.id) return state;
        return {
          session: {
            ...state.session,
            events: mergeEvents(state.session.events, snapshot.events),
            isSnapshotLoaded: true,
            awaitingEvent: snapshot.session.status === "running",
          },
          project: state.project && {
            ...state.project,
            sessions: replaceById(state.project.sessions, snapshot.session),
          },
        };
      });
    },

    applyEvent: (event) => {
      set((state) => {
        if (state.session?.id !== event.sessionId) return state;
        const streaming = streamingAfter(state.session.streaming, event);

        if (event.type === "session.delta") {
          return { session: { ...state.session, streaming } };
        }
        const isTerminal = isTerminalEvent(event);
        return {
          session: {
            ...state.session,
            events: mergeEvents(state.session.events, [event]),
            awaitingEvent: isTerminal ? false : state.session.awaitingEvent,
            streaming,
            outgoing: isUserPrompt(event) || isTerminal ? null : state.session.outgoing,
          },
          project: state.project && {
            ...state.project,
            sessions: state.project.sessions.map((session) =>
              session.id === event.sessionId ? sessionAfter(session, event) : session,
            ),
          },
        };
      });
    },
  };
}
