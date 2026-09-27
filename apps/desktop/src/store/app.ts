import { friendlyError, messageOf } from "../lib/errors";
import { settingsComplete, validateSettings } from "../lib/settings";
import type { StoreRuntime } from "./runtime";
import { type DesktopActions, homeRoute } from "./types";

export function appSlice(
  runtime: StoreRuntime,
): Pick<
  DesktopActions,
  | "init"
  | "saveSettings"
  | "saveProjectRoots"
  | "reconnect"
  | "shutdown"
  | "notify"
  | "dismissNotice"
> {
  const { get, set, services } = runtime;

  let initialized = false;
  let noticeCounter = 0;
  return {
    init: async () => {
      if (initialized) return;
      initialized = true;
      try {
        const paths = await services.paths();
        runtime.paths = paths;
        const [{ settings, exists }, appState] = await Promise.all([
          services.loadSettings(paths),
          services.loadState(paths),
        ]);
        set({
          home: paths.home,
          settings,
          settingsExist: exists,
          appState,
          selectedProjectId: appState.lastProjectId ?? appState.projects.at(0)?.id ?? null,
          route: settingsComplete(settings, services.localMode)
            ? homeRoute
            : { name: "settings", section: "runner" },
          ready: true,
        });
      } catch (error) {
        set({
          ready: true,
          bootError: messageOf(error, "Could not read ~/.nautilus"),
        });
        return;
      }
      services.channel.subscribe((connection) => {
        const wasConnected = get().connection.phase === "connected";
        set({ connection });
        if (connection.phase === "connected" && !wasConnected) void get().refreshRunner();
      });
      void services
        .agent()
        .then((process) => {
          runtime.agentProcess = process;
          process.subscribe((agent) => {
            set({ agent });
          });
          return process.start();
        })
        .then(() => get().refreshStatus())
        .catch(() => undefined);
      if (settingsComplete(get().settings, services.localMode)) {
        void services.channel.connect(get().settings).catch(() => undefined);
      }
      void get().scan();
    },

    saveSettings: async (candidate) => {
      const errors = validateSettings(candidate, services.localMode);
      if (Object.keys(errors).length > 0) return errors;
      const previous = get().settings;
      try {
        await services.channel.connect(candidate, { retry: false });
      } catch (error) {
        set({
          connection: {
            ...get().connection,
            error: friendlyError(error).message,
          },
        });
        if (settingsComplete(previous, services.localMode)) {
          void services.channel.connect(previous).catch(() => undefined);
        }
        return "connection_failed";
      }
      if (runtime.paths) await services.saveSettings(runtime.paths, candidate);
      const rootsChanged = candidate.projectRoots.join("\n") !== previous.projectRoots.join("\n");
      set({ settings: candidate, settingsExist: true });
      if (rootsChanged) void get().scan(true);
      return null;
    },

    saveProjectRoots: async (roots) => {
      const candidate = { ...get().settings, projectRoots: roots };
      const errors = validateSettings(candidate, services.localMode);
      if (errors.projectRoots) return errors.projectRoots;
      if (runtime.paths) await services.saveSettings(runtime.paths, candidate);
      const changed = roots.join("\n") !== get().settings.projectRoots.join("\n");
      set({ settings: candidate });
      if (changed) void get().scan(true);
      return null;
    },

    reconnect: () => {
      services.channel.reconnect();
      if (get().agent.phase === "error") void runtime.agentProcess?.start().catch(() => undefined);
    },

    shutdown: async () => {
      await Promise.allSettled([services.channel.disconnect(), runtime.agentProcess?.stop()]);
    },

    notify: (notice) => {
      const id = (noticeCounter += 1);
      set({ notices: [...get().notices, { ...notice, id }] });
    },

    dismissNotice: (id) => {
      set({ notices: get().notices.filter((notice) => notice.id !== id) });
    },
  };
}
