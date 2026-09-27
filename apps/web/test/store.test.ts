import { describe, expect, test, vi } from "vitest";
import type {
  BootstrapResponse,
  ProjectRecord,
  RecoverySummary,
  SessionRecord,
  SyncEvent,
} from "@nautilus/types";
import { createWorkspaceStore } from "@/store";

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubApi(routes: Record<string, Handler>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${input}`;
      calls.push(key);
      const route = routes[key];
      return Promise.resolve(route ? route(init) : json(404, { message: `No route ${key}` }));
    }),
  );
  return calls;
}

const lifecycle: RecoverySummary = {
  state: "ready",
  startedAt: "2026-09-26T09:00:00Z",
  updatedAt: "2026-09-26T09:00:00Z",
  recovered: false,
  interruptedSessions: 0,
  degradedProjects: [],
  reason: null,
};

function project(id: string): ProjectRecord {
  return {
    id,
    name: id,
    remotePath: `/projects/${id}`,
    devCommand: "pnpm dev",
    devPort: 5173,
    previewPath: `/preview/${id}/`,
    state: "running",
    lastError: null,
    startedAt: null,
    firstSyncAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-26T09:00:00Z",
  };
}

function session(id: string, patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    projectId: "p1",
    openCodeSessionId: `oc-${id}`,
    title: id,
    status: "idle",
    lastSequence: 0,
    createdAt: "2026-09-26T10:00:00Z",
    updatedAt: "2026-09-26T10:00:00Z",
    ...patch,
  };
}

const bootstrapBody: BootstrapResponse = {
  device: {
    id: "d1",
    name: "iPhone",
    createdAt: "2026-09-26T09:00:00Z",
    lastSeenAt: null,
    revokedAt: null,
  },
  projects: [project("p1"), project("p2")],
  lifecycle,
  activeProject: null,
};

const syncEvent = { requestId: "r1" } as SyncEvent;

function projectRoutes(id: string, sessions: SessionRecord[]): Record<string, Handler> {
  return {
    [`GET /api/sessions?projectId=${id}`]: () => json(200, { sessions }),
    [`GET /api/projects/${id}/sync-history`]: () => json(200, { events: [syncEvent] }),
  };
}

async function openStore(sessions: SessionRecord[], extra: Record<string, Handler> = {}) {
  const calls = stubApi({
    "GET /api/bootstrap": () => json(200, bootstrapBody),
    ...projectRoutes("p1", sessions),
    ...extra,
  });
  const store = createWorkspaceStore();
  await store.getState().actions.bootstrap();
  store.getState().actions.selectProject("p1");
  await vi.waitFor(() => {
    expect(store.getState().project?.isLoaded).toBe(true);
  });
  return { store, calls };
}

describe("bootstrap", () => {
  test("a signed-in device lands in the workspace with runner health", async () => {
    stubApi({ "GET /api/bootstrap": () => json(200, bootstrapBody) });
    const store = createWorkspaceStore();
    await store.getState().actions.bootstrap();
    const state = store.getState();
    expect(state.auth).toBe("authenticated");
    expect(state.device?.name).toBe("iPhone");
    expect(state.projects.map((one) => one.id)).toEqual(["p1", "p2"]);
    expect(state.runner).toEqual({ lifecycle, isReachable: true, error: null });
  });

  test("a 401 goes to pairing", async () => {
    stubApi({
      "GET /api/bootstrap": () => json(401, { error: "unauthorized" }),
    });
    const store = createWorkspaceStore();
    await store.getState().actions.bootstrap();
    expect(store.getState().auth).toBe("unauthenticated");
  });

  test("an unreachable runner shows the outage screen", async () => {
    stubApi({
      "GET /api/bootstrap": () => json(502, { message: "Bad gateway" }),
    });
    const store = createWorkspaceStore();
    await store.getState().actions.bootstrap();
    expect(store.getState().auth).toBe("unavailable");
    expect(store.getState().error).toBe("Bad gateway");
  });
});

describe("refresh", () => {
  test("a failed refresh keeps the workspace and marks the runner unreachable", async () => {
    const { store } = await openStore([session("s1")]);
    stubApi({
      "GET /api/bootstrap": () => json(502, { message: "Bad gateway" }),
    });
    await store.getState().actions.refresh();
    const state = store.getState();
    expect(state.auth).toBe("authenticated");
    expect(state.projects).toHaveLength(2);
    expect(state.runner.isReachable).toBe(false);
    expect(state.error).toBeNull();
  });

  test("a refresh picks up new sessions and sync history for the open project", async () => {
    const { store } = await openStore([session("s1")]);
    stubApi({
      "GET /api/bootstrap": () => json(200, bootstrapBody),
      ...projectRoutes("p1", [session("s2"), session("s1")]),
    });
    await store.getState().actions.refresh();
    const state = store.getState();
    expect(state.project?.sessions.map((one) => one.id)).toEqual(["s2", "s1"]);
    expect(state.project?.syncHistory).toEqual([syncEvent]);

    expect(state.session?.id).toBe("s1");
  });

  test("overlapping refreshes share one request", async () => {
    const { store, calls } = await openStore([session("s1")]);
    const before = calls.length;
    await Promise.all([store.getState().actions.refresh(), store.getState().actions.refresh()]);
    expect(calls.slice(before).filter((call) => call === "GET /api/bootstrap")).toHaveLength(1);
  });
});
