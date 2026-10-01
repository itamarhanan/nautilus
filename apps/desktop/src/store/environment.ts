import { ApiError } from "../lib/api";
import { changedVariables, environmentDigests, environmentError } from "../lib/environment";
import { messageOf } from "../lib/errors";
import { plural } from "../lib/format";
import type { StoreRuntime } from "./runtime";
import type { DesktopActions } from "./types";

function warnFallback({ get }: StoreRuntime, projectId: string, keychain: boolean): void {
  if (keychain) return;
  get().notify({
    tone: "warning",
    title: "The OS keychain is not available",
    body: `The variables are saved in ~/.nautilus/env/${projectId}.json, readable only by your user.`,
  });
}

// Sends the keychain's set to the runner when the runner's copy is missing
// keys or holds stale values, and returns the keys that changed. Returns null
// when the runner is too old to hold variables.
export async function sendEnvironment(
  runtime: StoreRuntime,
  projectId: string,
): Promise<string[] | null> {
  const api = runtime.control();
  if (!api) throw new Error("Connect to the runner first.");
  const stored = await runtime.services.environment.load(projectId);
  let runner;
  try {
    runner = await api.environment(projectId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  const changed = await changedVariables(stored, runner.keys);
  if (changed.length === 0) {
    runtime.set({ environments: { ...runtime.get().environments, [projectId]: runner } });
    return changed;
  }
  const updated = await api.updateEnvironment(projectId, stored.variables);
  await runtime.services.environment.save(
    projectId,
    stored.variables,
    await environmentDigests(stored.variables),
  );
  runtime.set({ environments: { ...runtime.get().environments, [projectId]: updated } });
  return changed;
}

export async function pendingEnvironment(
  runtime: StoreRuntime,
  projectId: string,
): Promise<string[]> {
  const api = runtime.control();
  if (!api) return [];
  try {
    const [stored, runner] = await Promise.all([
      runtime.services.environment.load(projectId),
      api.environment(projectId),
    ]);
    return await changedVariables(stored, runner.keys);
  } catch {
    return [];
  }
}

export function environmentSlice(
  runtime: StoreRuntime,
): Pick<DesktopActions, "readEnvironment" | "refreshEnvironment" | "saveEnvironment"> {
  const { get, set, control, services } = runtime;
  return {
    readEnvironment: async (projectId) => {
      const project = get().appState.projects.find((entry) => entry.id === projectId);
      // A failed scan only costs the suggestions, so the saved variables still
      // load, but the reason is shown rather than an empty list.
      const [stored, scanned] = await Promise.all([
        services.environment.load(projectId),
        project
          ? services.environment.scan(project.localPath).then(
              (files) => ({ files, scanError: null }),
              (error: unknown) => ({
                files: [],
                scanError: messageOf(error, "Could not read the env files"),
              }),
            )
          : { files: [], scanError: null },
      ]);
      return { variables: stored.variables, keychain: stored.keychain, ...scanned };
    },

    refreshEnvironment: async (projectId) => {
      const api = control();
      if (!api) return;
      try {
        const environment = await api.environment(projectId);
        set({ environments: { ...get().environments, [projectId]: environment } });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          set({ environments: { ...get().environments, [projectId]: null } });
        }
      }
    },

    saveEnvironment: async (projectId, variables) => {
      const invalid = environmentError(variables);
      if (invalid) return invalid;
      let keychain: boolean;
      try {
        const stored = await services.environment.load(projectId);
        keychain = (await services.environment.save(projectId, variables, stored.sent)).keychain;
      } catch (error) {
        return messageOf(error, "Could not save the variables on this PC");
      }
      warnFallback(runtime, projectId, keychain);

      if (!control()) {
        get().notify({
          tone: "info",
          title: "Saved on this PC",
          body: "The runner gets them on your next push.",
        });
        return null;
      }
      try {
        const changed = await sendEnvironment(runtime, projectId);
        if (changed === null) return "The runner is too old to hold variables. Update it first.";
        get().notify({
          tone: "success",
          title: changed.length > 0 ? `Sent ${plural(changed.length, "variable")}` : "Saved",
          body:
            changed.length > 0 ? "A running preview restarts to pick them up." : "Nothing changed.",
        });
      } catch (error) {
        return `Saved on this PC, but the runner did not get them: ${messageOf(error, "unknown error")}. They go with your next push.`;
      }
      return null;
    },
  };
}
