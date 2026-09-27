import { createStore, type StoreApi } from "zustand/vanilla";
import { inferDevCommand, type FolderCandidate } from "./lib/folders";
import { emptyState } from "./lib/state";
import { appSlice } from "./store/app";
import { navigationSlice } from "./store/navigation";
import { projectsSlice } from "./store/projects";
import { reviewSlice } from "./store/review";
import { runnerSlice } from "./store/runner";
import { createRuntime } from "./store/runtime";
import { type DesktopServices, type DesktopStore, homeRoute } from "./store/types";

export * from "./store/types";

export function createDesktopStore(services: DesktopServices): StoreApi<DesktopStore> {
  return createStore<DesktopStore>((set, get) => {
    const runtime = createRuntime(services, set, get);
    return {
      ready: false,
      bootError: null,
      localMode: services.localMode,
      home: "",
      settings: {
        runnerUrl: "",
        ssh: {
          host: "ssh.lightning.ai",
          user: "",
          keyPath: "~/.ssh/lightning_rsa",
        },
        projectRoots: ["~"],
      },
      settingsExist: false,
      appState: emptyState,
      connection: services.channel.current,
      agent: { phase: "stopped", error: null },
      projects: [],
      devices: [],
      selectedProjectId: null,
      status: {},
      history: {},
      route: homeRoute,
      settingsReturn: homeRoute,
      paletteOpen: false,
      linkPhoneOpen: false,
      pairing: null,
      pairingError: null,
      review: null,
      undoingPull: null,
      scanning: false,
      notices: [],
      ...appSlice(runtime),
      ...navigationSlice(runtime),
      ...runnerSlice(runtime),
      ...projectsSlice(runtime),
      ...reviewSlice(runtime),
    };
  });
}

export function suggestedDevCommand(folder: FolderCandidate): string {
  return inferDevCommand(folder.packageManager, folder.devScript) ?? "npm run dev";
}
