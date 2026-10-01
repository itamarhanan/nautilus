import { ApiError } from "../lib/api";
import { messageOf } from "../lib/errors";
import { scanFolders } from "../lib/folders";
import { projectIdForFolder, touchRecent, withoutProject, withProject } from "../lib/state";
import type { StoreRuntime } from "./runtime";
import { type DesktopActions, homeRoute } from "./types";

const scanMaxAgeMs = 5 * 60 * 1000;

function withoutKey<T>(
  record: Partial<Record<string, T>>,
  key: string,
): Partial<Record<string, T>> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));
}

export function projectsSlice(
  runtime: StoreRuntime,
): Pick<
  DesktopActions,
  "scan" | "addProject" | "updateProject" | "removeProject" | "reregisterProject" | "touchFolder"
> {
  const { get, set, control, persistState, services } = runtime;
  return {
    scan: async (force = false) => {
      const paths = runtime.paths;
      if (!paths || get().scanning) return;
      const { appState, settings } = get();
      const cached = appState.scan;
      const fresh =
        cached &&
        Date.now() - Date.parse(cached.scannedAt) < scanMaxAgeMs &&
        cached.roots.join("\n") === settings.projectRoots.join("\n");
      if (fresh && !force) return;
      set({ scanning: true });
      try {
        const folders = await scanFolders(settings.projectRoots, services.folderIo, paths.home);
        await persistState({
          ...get().appState,
          scan: {
            scannedAt: new Date().toISOString(),
            roots: [...settings.projectRoots],
            folders,
          },
        });
      } finally {
        set({ scanning: false });
      }
    },

    addProject: async ({ folder, name, devCommand }) => {
      const api = control();
      if (!api) throw new Error("Connect to the runner before adding a project.");
      const { appState } = get();
      const existing = appState.projects.find((project) => project.localPath === folder.path);
      if (existing) {
        get().selectProject(existing.id);
        return;
      }
      const id = projectIdForFolder(folder.name, [
        ...appState.projects.map((project) => project.id),
        ...get().projects.map((project) => project.id),
      ]);
      const record = await api.registerProject({
        projectId: id,
        name,
        devCommand,
      });
      set({
        projects: [...get().projects.filter((project) => project.id !== id), record],
      });
      await persistState(
        withProject(get().appState, {
          id,
          name,
          localPath: folder.path,
          devCommand,
          addedAt: new Date().toISOString(),
          acknowledgedExclusions: [],
        }),
      );
      set({
        selectedProjectId: id,
        route: { name: "project", tab: "overview" },
        paletteOpen: false,
      });
      get().notify({
        tone: "success",
        title: `Added ${name}`,
        body: "Push it to give the agent a copy.",
      });
      await get().refreshStatus(id);
    },

    updateProject: async (projectId, changes) => {
      const api = control();
      const project = get().appState.projects.find((entry) => entry.id === projectId);
      if (!project) return "Project is not in this app's state.";
      if (!api) return "Connect to the runner first.";
      const name = changes.name.trim();
      const devCommand = changes.devCommand.trim();
      if (!name) return "Enter a name.";
      if (!devCommand) return "Enter a dev command.";

      try {
        const record = await api.updateProject(projectId, { name, devCommand });
        set({
          projects: get().projects.map((entry) => (entry.id === projectId ? record : entry)),
        });
      } catch (error) {
        return messageOf(error, "Could not save the project");
      }

      await persistState({
        ...get().appState,
        projects: get().appState.projects.map((entry) =>
          entry.id === projectId ? { ...entry, name, devCommand } : entry,
        ),
      });
      get().notify({ tone: "success", title: `Saved ${name}` });
      return null;
    },

    removeProject: async (projectId) => {
      const api = control();
      const local = get().appState.projects.find((project) => project.id === projectId);
      const name = local?.name ?? get().projects.find((project) => project.id === projectId)?.name;
      if (!local && !api) return "Connect to the runner first.";
      if (api) {
        try {
          await api.deleteProject(projectId);
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) {
            return messageOf(error, "Could not remove the project");
          }
        }
      }

      // Every field that points at the project changes in one update, before
      // the disk write, so no render or status poll sees the project gone from
      // state.json while the selection, the route or the runner list still
      // name it.
      const { appState, status, history, environments } = get();
      const next = local ? withoutProject(appState, projectId) : appState;
      set({
        appState: next,
        projects: get().projects.filter((project) => project.id !== projectId),
        status: withoutKey(status, projectId),
        history: withoutKey(history, projectId),
        environments: withoutKey(environments, projectId),
        ...(local
          ? {
              selectedProjectId: next.projects.at(0)?.id ?? null,
              route: homeRoute,
              settingsReturn: homeRoute,
            }
          : {}),
      });
      if (api) {
        void api
          .projects()
          .then((projects) => {
            set({ projects });
            return services.channel.refreshInfo();
          })
          .catch(() => undefined);
      }
      get().notify(
        local
          ? { tone: "info", title: "Project removed", body: "Its folder stays in Recent." }
          : {
              tone: "info",
              title: `Removed ${name ?? projectId} from the runner`,
              body: "Nothing on this PC changed.",
            },
      );
      if (local) {
        // The runner deletes its copy along with the project.
        await services.environment.remove(projectId).catch(() => undefined);
        try {
          await persistState(next);
        } catch (error) {
          get().notify({
            tone: "error",
            title: "Could not save ~/.nautilus/state.json",
            body: messageOf(error, "The project may come back after a restart."),
          });
        }
      }
      return null;
    },

    reregisterProject: async (projectId) => {
      const api = control();
      const project = get().appState.projects.find((entry) => entry.id === projectId);
      if (!api || !project) return;
      try {
        const record = await api.registerProject({
          projectId,
          name: project.name,
          devCommand: project.devCommand,
        });
        set({
          projects: [...get().projects.filter((entry) => entry.id !== projectId), record],
        });
        get().notify({
          tone: "success",
          title: `${project.name} is back on the runner`,
          body: "Push to restore its files.",
        });
        await get().refreshStatus(projectId);
      } catch (error) {
        get().notify({
          tone: "error",
          title: "Could not register the project",
          body: messageOf(error, ""),
        });
      }
    },

    touchFolder: (path) => {
      void persistState(touchRecent(get().appState, path));
    },
  };
}
