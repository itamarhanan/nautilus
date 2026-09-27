import { type DesktopActions, homeRoute } from "./types";
import type { StoreRuntime } from "./runtime";

export function navigationSlice({
  get,
  set,
  persistState,
}: StoreRuntime): Pick<
  DesktopActions,
  "navigate" | "goUp" | "selectProject" | "setPaletteOpen" | "setLinkPhoneOpen"
> {
  return {
    navigate: (route) => {
      const current = get().route;

      if (route.name === "settings" && current.name !== "settings") {
        set({ route, settingsReturn: current });
      } else {
        set({ route });
      }
    },

    goUp: () => {
      const { route, settingsReturn, selectedProjectId, appState } = get();
      if (route.name === "settings") {
        const back =
          settingsReturn.name === "project" &&
          !appState.projects.some((project) => project.id === selectedProjectId)
            ? homeRoute
            : settingsReturn;
        set({ route: back });
      } else if (route.name === "project") {
        set({
          route: route.tab === "overview" ? homeRoute : { name: "project", tab: "overview" },
        });
      }
    },

    selectProject: (projectId, tab = "overview") => {
      set({ selectedProjectId: projectId, route: { name: "project", tab } });
      void persistState({ ...get().appState, lastProjectId: projectId });
      void get().refreshStatus(projectId);
      void get().refreshHistory(projectId);
    },

    setPaletteOpen: (open) => {
      set({ paletteOpen: open });
      if (open) void get().scan();
    },

    setLinkPhoneOpen: (open) => {
      set({
        linkPhoneOpen: open,
        pairingError: open ? null : get().pairingError,
      });
      if (open) {
        void get().newPairingCode();
      } else {
        set({ pairing: null });
      }
    },
  };
}
