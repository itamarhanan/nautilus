import type { SyncStatusResponse } from "@nautilus/types";
import { ApiError } from "../lib/api";
import { messageOf } from "../lib/errors";
import { plural } from "../lib/format";
import type { StoreRuntime } from "./runtime";
import { type DesktopActions, emptyStatus } from "./types";

const localModeWebPort = String(import.meta.env.VITE_NAUTILUS_WEB_PORT ?? "3000");

function reportExclusions({ get, set }: StoreRuntime, projectId: string, excluded: string[]): void {
  if (excluded.length === 0) return;
  const project = get().appState.projects.find((entry) => entry.id === projectId);
  if (!project) return;
  const known = new Set([...project.acknowledgedExclusions, "."]);
  const fresh = excluded.filter((path) => !known.has(path));
  if (fresh.length === 0) return;
  set({
    appState: {
      ...get().appState,
      projects: get().appState.projects.map((entry) =>
        entry.id === projectId
          ? {
              ...entry,
              acknowledgedExclusions: [...entry.acknowledgedExclusions, ...fresh],
            }
          : entry,
      ),
    },
  });
  get().notify({
    tone: "info",
    title: "Some folders are not synchronized",
    body:
      `${fresh.join(", ")} ${fresh.length === 1 ? "has" : "have"} its own Git ` +
      "metadata, so it is not synchronized. Add it as a project of its own to " +
      "synchronize it separately.",
  });
}

function announceRunnerChanges(
  { get, services }: StoreRuntime,
  projectId: string,
  before: SyncStatusResponse,
  after: SyncStatusResponse,
): void {
  if (after.head === before.head || after.changedFiles === 0) return;
  const name = get().appState.projects.find((entry) => entry.id === projectId)?.name ?? projectId;
  services.alert?.(
    `New changes in ${name}`,
    `${plural(after.changedFiles, "file")} ready to pull from the runner.`,
  );
}

export function runnerSlice(
  runtime: StoreRuntime,
): Pick<
  DesktopActions,
  | "refreshRunner"
  | "refreshStatus"
  | "refreshHistory"
  | "newPairingCode"
  | "refreshDevices"
  | "revokeDevice"
> {
  const { get, set, control } = runtime;
  return {
    refreshRunner: async () => {
      const api = control();
      if (!api) return;
      try {
        const [projects, devices] = await Promise.all([api.projects(), api.devices()]);
        set({ projects, devices });

        await Promise.all([get().refreshStatus(), get().refreshHistory()]);
      } catch (error) {
        get().notify({
          tone: "error",
          title: "Could not load runner data",
          body: messageOf(error, ""),
        });
      }
    },

    refreshStatus: async (projectId) => {
      const ids = projectId ? [projectId] : get().appState.projects.map((project) => project.id);
      const api = control();
      const agent = runtime.agentProcess?.client;
      await Promise.all(
        ids.map(async (id) => {
          const registered = get().projects.some((project) => project.id === id);
          const [runner, local] = await Promise.allSettled([
            api && registered ? api.syncStatus(id) : Promise.resolve(null),
            agent ? agent.status(id) : Promise.resolve(null),
          ]);
          const error =
            runner.status === "rejected"
              ? messageOf(runner.reason, "Runner status unavailable")
              : local.status === "rejected"
                ? messageOf(local.reason, "Local status unavailable")
                : null;

          const errorCode =
            runner.status === "rejected" && runner.reason instanceof ApiError
              ? runner.reason.code
              : null;
          const previous = get().status[id] ?? emptyStatus;
          if (runner.status === "fulfilled" && runner.value && previous.runner) {
            announceRunnerChanges(runtime, id, previous.runner, runner.value);
          }
          set({
            status: {
              ...get().status,
              [id]: {
                runner: runner.status === "fulfilled" ? runner.value : previous.runner,
                local: local.status === "fulfilled" ? local.value : previous.local,
                error,
                errorCode,
                checkedAt: Date.now(),
              },
            },
          });
          if (runner.status === "fulfilled") {
            reportExclusions(runtime, id, runner.value?.excludedRepositories ?? []);
          }
        }),
      );
    },

    refreshHistory: async (projectId) => {
      const api = control();
      if (!api) return;
      const registered = new Set(get().projects.map((project) => project.id));
      const ids = projectId ? [projectId] : get().appState.projects.map((project) => project.id);
      await Promise.all(
        ids
          .filter((id) => registered.has(id))
          .map(async (id) => {
            try {
              const events = await api.syncHistory(id);
              set({ history: { ...get().history, [id]: events } });
            } catch {
              // History is a background refresh over every known project, so one
              // project failing must not reject the batch and discard the
              // histories that did arrive. The next refresh picks it up.
            }
          }),
      );
    },

    newPairingCode: async () => {
      const api = control();
      if (!api) {
        set({ pairingError: "Connect to the runner to link a phone." });
        return;
      }
      try {
        const code = await api.pairingCode();
        const base = get().localMode
          ? `http://127.0.0.1:${localModeWebPort}`
          : get().settings.runnerUrl;
        set({
          pairing: {
            ...code,
            url: `${base}/?pair=${encodeURIComponent(code.code)}`,
          },
          pairingError: null,
        });
      } catch (error) {
        set({
          pairingError: messageOf(error, "Could not create a pairing code"),
        });
      }
    },

    refreshDevices: async () => {
      const api = control();
      if (!api) return;
      try {
        set({ devices: await api.devices() });
      } catch {
        // The device list is polled in the background. A transient failure
        // leaves the previously fetched list on screen rather than raising an
        // error the user cannot act on between two polls.
      }
    },

    revokeDevice: async (deviceId) => {
      const api = control();
      if (!api) return;
      try {
        await api.revokeDevice(deviceId);
        await get().refreshDevices();
        get().notify({ tone: "info", title: "Phone access revoked" });
      } catch (error) {
        get().notify({
          tone: "error",
          title: "Could not revoke the phone",
          body: messageOf(error, ""),
        });
      }
    },
  };
}
