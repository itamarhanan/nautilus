import type { BootstrapResponse } from "@nautilus/types";
import * as api from "@/lib/api/endpoints";
import { errorMessage, isUnauthorized } from "@/lib/api/client";
import { writeLocation } from "@/lib/location";
import { rememberDrafts, rememberedDrafts } from "@/lib/storage";
import { initialData } from "./state";
import type { GetState, SetState, WorkspaceActions } from "./state";

type AuthActions = Pick<
  WorkspaceActions,
  "bootstrap" | "refresh" | "pair" | "signOut" | "signOutLocally"
>;

export function authActions(set: SetState, get: GetState): AuthActions {
  let refreshing: Promise<void> | null = null;

  const accept = (body: BootstrapResponse) => {
    set({
      auth: "authenticated",
      device: body.device,
      projects: body.projects,
      runner: { lifecycle: body.lifecycle, isReachable: true, error: null },
    });
  };

  const backgroundRefresh = async () => {
    try {
      accept(await api.bootstrap());
    } catch (error) {
      if (isUnauthorized(error)) {
        get().actions.signOutLocally();
        return;
      }

      set((state) => ({
        runner: {
          ...state.runner,
          isReachable: false,
          error: errorMessage(error, "Runner unavailable"),
        },
      }));
      return;
    }
    const projectId = get().project?.id;
    if (projectId) await get().actions.loadProject(projectId, { background: true });
  };

  return {
    bootstrap: async () => {
      if (Object.keys(get().drafts).length === 0) set({ drafts: rememberedDrafts() });
      try {
        accept(await api.bootstrap());
        set({ error: null });
      } catch (error) {
        if (isUnauthorized(error)) {
          get().actions.signOutLocally();
          return;
        }
        const message = errorMessage(error, "Unable to reach the runner");
        set((state) => ({
          auth: "unavailable",
          error: message,
          runner: { ...state.runner, isReachable: false, error: message },
        }));
      }
    },

    refresh: () => {
      const { auth } = get();

      if (auth === "unavailable") return get().actions.bootstrap();
      if (auth !== "authenticated") return Promise.resolve();

      refreshing ??= backgroundRefresh().finally(() => {
        refreshing = null;
      });
      return refreshing;
    },

    pair: async (code, deviceName) => {
      set((state) => ({
        pending: { ...state.pending, pair: true },
        error: null,
      }));
      try {
        await api.redeemPairingCode(code.trim(), deviceName.trim() || "Phone");
        await get().actions.bootstrap();
      } finally {
        set((state) => ({ pending: { ...state.pending, pair: false } }));
      }
    },

    signOut: async () => {
      try {
        await api.signOut();
      } catch {
        // Signing out locally must happen whether or not the server call
        // succeeds, so the `finally` below does it either way. Swallowing the
        // error is what keeps an offline device from looking still signed in.
      } finally {
        get().actions.signOutLocally();
      }
    },

    signOutLocally: () => {
      set({ ...initialData, auth: "unauthenticated", online: get().online });

      rememberDrafts({});
      writeLocation(
        { projectId: null, sessionId: null, view: "chat", isInfoOpen: false },
        "replace",
      );
    },
  };
}
