import type { StoreApi } from "zustand/vanilla";
import type { AgentProcess } from "../lib/agent";
import type { ControlApi } from "../lib/api";
import type { DesktopPaths } from "../lib/files";
import type { AppState } from "../lib/state";
import type { SyncSession } from "../lib/sync";
import type { DesktopServices, DesktopStore } from "./types";

export type StoreRuntime = {
  services: DesktopServices;
  set: StoreApi<DesktopStore>["setState"];
  get: () => DesktopStore;

  paths?: DesktopPaths;
  agentProcess?: AgentProcess;

  session?: SyncSession;

  control: () => ControlApi | null;

  persistState: (next: AppState) => Promise<void>;
};

export function createRuntime(
  services: DesktopServices,
  set: StoreRuntime["set"],
  get: StoreRuntime["get"],
): StoreRuntime {
  const runtime: StoreRuntime = {
    services,
    set,
    get,
    control: () => get().connection.api,
    persistState: async (next) => {
      set({ appState: next });
      if (runtime.paths) await services.saveState(runtime.paths, next);
    },
  };
  return runtime;
}
