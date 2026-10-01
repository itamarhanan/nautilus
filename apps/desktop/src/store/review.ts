import { friendlyError, messageOf } from "../lib/errors";
import { plural } from "../lib/format";
import { SyncSession } from "../lib/sync";
import { pendingEnvironment, sendEnvironment } from "./environment";
import type { StoreRuntime } from "./runtime";
import { conflictsOf, type DesktopActions, type Review } from "./types";

export function reviewSlice(
  runtime: StoreRuntime,
): Pick<
  DesktopActions,
  | "startReview"
  | "applyReview"
  | "resolveConflicts"
  | "closeReview"
  | "compareConflict"
  | "openConflictFile"
  | "undoPull"
> {
  const { get, set, control, services } = runtime;
  let reviewCounter = 0;

  const patchReview = (id: number, partial: Partial<Review>) => {
    const current = get().review;
    if (current?.id === id) set({ review: { ...current, ...partial } });
  };
  return {
    startReview: async (direction, requestedId) => {
      const projectId = requestedId ?? get().selectedProjectId;
      const api = control();
      const agent = runtime.agentProcess?.client;
      const paths = runtime.paths;
      if (!projectId || !api || !agent || !paths) return;
      await runtime.session?.close();
      const id = (reviewCounter += 1);
      set({
        review: {
          id,
          projectId,
          direction,
          phase: "preparing",
          step: null,
          preview: null,
          result: null,
          error: null,
          resolutions: {},
          environmentChanges: [],
          background: false,
        },
      });
      const session = new SyncSession({
        projectId,
        direction,
        control: api,
        agent,
        settings: get().settings,
        home: paths.home,
        spawn: services.spawn,
        localMode: services.localMode,
        onStep: (step) => {
          patchReview(id, { step });
        },
      });
      runtime.session = session;
      try {
        const preview = await session.preview();
        const environmentChanges =
          direction === "push" && preview.status === "ok"
            ? await pendingEnvironment(runtime, projectId)
            : [];
        patchReview(id, {
          preview,
          environmentChanges,
          phase: preview.status === "ok" ? "ready" : "blocked",
          error: preview.status === "ok" ? null : (preview.error?.message ?? null),
        });
        if (preview.status !== "ok") await session.close();
      } catch (error) {
        patchReview(id, {
          phase: "failed",
          error: friendlyError(error).message,
        });
        await session.close();
      }
    },

    applyReview: async () => {
      const review = get().review;
      const current = runtime.session;
      if (!review || (review.phase !== "ready" && review.phase !== "resolving") || !current) {
        return;
      }
      const retrying = review.phase === "resolving";
      let resolvable = false;
      patchReview(review.id, { phase: "applying" });
      try {
        const result = await current.apply(
          retrying ? undefined : review.preview?.requestId,
          undefined,
          retrying ? review.resolutions : undefined,
        );
        const ok = result.status === "ok";
        resolvable = result.status === "conflict" && conflictsOf(result).length > 0;
        patchReview(review.id, {
          result,
          phase: ok ? "done" : resolvable ? "resolving" : "blocked",
          error: ok ? null : (result.error?.message ?? null),
        });
        if (ok && review.direction === "push" && review.environmentChanges.length > 0) {
          await sendEnvironment(runtime, review.projectId).catch((error: unknown) => {
            get().notify({
              tone: "warning",
              title: "The runner did not get the variables",
              body: messageOf(error, "Save them again from the project's settings."),
            });
          });
        }
        const project = get().appState.projects.find((entry) => entry.id === review.projectId);
        const files = review.preview?.diff?.files.length ?? result.diff?.files.length ?? 0;
        const latest = get().review;

        if (latest?.id === review.id && latest.background) {
          get().notify(
            ok
              ? {
                  tone: "success",
                  title: `${review.direction === "pull" ? "Pulled" : "Pushed"} ${plural(files, "file")}`,
                  body: project?.name,
                }
              : {
                  tone: "warning",
                  title: `${review.direction === "pull" ? "Pull" : "Push"} blocked`,
                  body: result.conflicts?.length
                    ? plural(result.conflicts.length, "conflicting file")
                    : (result.error?.message ?? result.status),
                },
          );

          set({ review: ok ? null : { ...latest, background: false } });
        }
      } catch (error) {
        patchReview(review.id, {
          phase: "failed",
          error: friendlyError(error).message,
        });
        const latest = get().review;
        if (latest?.id === review.id && latest.background) {
          get().notify({
            tone: "error",
            title: "Sync failed",
            body: friendlyError(error).message,
          });
          set({ review: { ...latest, background: false } });
        }
      } finally {
        if (!resolvable) {
          await current.close();
          if (runtime.session === current) runtime.session = undefined;
        }
        await get().refreshStatus(review.projectId);
        await get().refreshHistory(review.projectId);
      }
    },

    resolveConflicts: (paths, side) => {
      const review = get().review;
      if (review?.phase !== "resolving") return;
      const chosen = new Set(paths);
      const kept = Object.entries(review.resolutions).filter(([path]) => !chosen.has(path));
      const added = side === null ? [] : paths.map((path) => [path, side] as const);
      set({
        review: {
          ...review,
          resolutions: Object.fromEntries([...kept, ...added]),
        },
      });
    },

    closeReview: async () => {
      const review = get().review;
      if (!review) return;
      if (review.phase === "applying") {
        set({ review: { ...review, background: true } });
        return;
      }
      set({ review: null });
      await runtime.session?.close();
      runtime.session = undefined;
    },

    compareConflict: async (path) => {
      const review = get().review;
      const agent = runtime.agentProcess?.client;
      const remoteHead = review?.preview?.state?.head;
      if (!review || !agent || !remoteHead) throw new Error("The review is no longer open");
      return agent.compare(review.projectId, remoteHead, path);
    },

    openConflictFile: async (path) => {
      const projectId = get().review?.projectId;
      const project = get().appState.projects.find((entry) => entry.id === projectId);
      if (!project) return;
      try {
        await services.openFile(project.localPath, path);
      } catch (error) {
        get().notify({
          tone: "error",
          title: "Could not open the file",
          body: messageOf(error, ""),
        });
      }
    },

    undoPull: async (projectId) => {
      const api = control();
      const agent = runtime.agentProcess?.client;
      const pull = get().status[projectId]?.local?.undoablePull;
      if (!api || !agent || !pull || get().undoingPull !== null) return;
      set({ undoingPull: projectId });
      try {
        await api.rewindSyncBase(projectId, pull.remoteHead, pull.previousBaseHead);
        await agent.undoPull(projectId, pull.requestId);
        get().notify({
          tone: "success",
          title: "Pull undone",
          body: "The runner still has its changes. Pull again whenever you want them.",
        });
      } catch (error) {
        get().notify({
          tone: "error",
          title: "Could not undo the pull",
          body: messageOf(error, ""),
        });
      } finally {
        set({ undoingPull: null });
        await Promise.all([get().refreshStatus(projectId), get().refreshHistory(projectId)]);
      }
    },
  };
}
