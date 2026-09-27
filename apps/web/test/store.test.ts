import { describe, expect, test, vi } from "vitest";
import type {
  BootstrapResponse,
  ProjectRecord,
  RecoverySummary,
  SessionEvent,
  SessionRecord,
  SyncEvent,
} from "@nautilus/types";
import { createWorkspaceStore } from "@/store";
import { openSessionRecord } from "@/store/selectors";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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

function event(sequence: number, type: SessionEvent["type"], sessionId = "s1"): SessionEvent {
  return {
    sessionId,
    projectId: "p1",
    sequence,
    timestamp: "2026-09-26T10:01:00Z",
    type,
    durable: true,
    payload: {},
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

describe("selecting", () => {
  test("opens the newest session of a project", async () => {
    const { store } = await openStore([session("s2"), session("s1")]);
    expect(store.getState().session?.id).toBe("s2");
    expect(store.getState().view).toBe("chat");
  });

  test("a slow load for a project left behind is ignored", async () => {
    const slow = deferred<Response>();
    stubApi({
      "GET /api/bootstrap": () => json(200, bootstrapBody),
      "GET /api/sessions?projectId=p1": () => slow.promise,
      "GET /api/projects/p1/sync-history": () => json(200, { events: [] }),
      ...projectRoutes("p2", [session("s9", { projectId: "p2" })]),
    });
    const store = createWorkspaceStore();
    await store.getState().actions.bootstrap();
    store.getState().actions.selectProject("p1");
    store.getState().actions.selectProject("p2");
    await vi.waitFor(() => {
      expect(store.getState().project?.isLoaded).toBe(true);
    });
    slow.resolve(json(200, { sessions: [session("s1")] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().project?.id).toBe("p2");
    expect(store.getState().session?.id).toBe("s9");
  });

  test("navigate restores project, session and tab from an address", async () => {
    stubApi({
      "GET /api/bootstrap": () => json(200, bootstrapBody),
      ...projectRoutes("p1", [session("s2"), session("s1")]),
    });
    const store = createWorkspaceStore();
    await store.getState().actions.bootstrap();
    store.getState().actions.navigate({
      projectId: "p1",
      sessionId: "s1",
      view: "history",
      isInfoOpen: false,
    });
    await vi.waitFor(() => {
      expect(store.getState().project?.isLoaded).toBe(true);
    });
    expect(store.getState().session?.id).toBe("s1");
    expect(store.getState().view).toBe("history");
  });
});

describe("the open session", () => {
  test("events move the session's status and end the wait on a terminal event", async () => {
    const { store } = await openStore([session("s1", { status: "running" })]);
    const { actions } = store.getState();
    actions.applySnapshot({
      session: session("s1", { status: "running" }),
      events: [],
    });
    expect(store.getState().session?.awaitingEvent).toBe(true);

    actions.applyEvent(event(1, "session.message"));
    actions.applyEvent(event(2, "session.completed"));
    const state = store.getState();
    expect(state.session?.events.map((one) => one.sequence)).toEqual([1, 2]);
    expect(state.session?.awaitingEvent).toBe(false);
    expect(openSessionRecord(state)?.status).toBe("idle");
  });

  test("events and snapshots for another session are dropped", async () => {
    const { store } = await openStore([session("s1")]);
    const { actions } = store.getState();
    actions.applyEvent(event(1, "session.message", "other"));
    actions.applySnapshot({
      session: session("other"),
      events: [event(1, "session.message")],
    });
    expect(store.getState().session?.events).toEqual([]);
    expect(store.getState().session?.isSnapshotLoaded).toBe(false);
  });
});
