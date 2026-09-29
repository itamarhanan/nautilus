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

  test("a 401 from something other than the runner keeps the device signed in", async () => {
    stubApi({ "GET /api/bootstrap": () => json(401, {}) });
    const store = createWorkspaceStore();
    await store.getState().actions.bootstrap();
    expect(store.getState().auth).not.toBe("unauthenticated");
    expect(store.getState().runner.isReachable).toBe(false);
  });

  test("a 401 keeps the pairing code a link opened the app with", async () => {
    stubApi({
      "GET /api/bootstrap": () => json(401, { error: "unauthorized" }),
    });
    const location = { pathname: "/", search: "?pair=ABCD-1234", hash: "" };
    vi.stubGlobal("window", {
      location,
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => {
          location.search = url.includes("?") ? url.slice(url.indexOf("?")) : "";
        },
        pushState: () => undefined,
      },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    });
    const store = createWorkspaceStore();
    await store.getState().actions.bootstrap();
    expect(store.getState().auth).toBe("unauthenticated");
    expect(location.search).toBe("?pair=ABCD-1234");
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

describe("actions", () => {
  test("a prompt can be sent while a start request is in flight", async () => {
    const start = deferred<Response>();
    const { store, calls } = await openStore([session("s1")], {
      "POST /api/projects/p1/start": () => start.promise,
      "POST /api/sessions/s1/prompt": () => json(202, {}),
    });
    const { actions } = store.getState();
    actions.applySnapshot({ session: session("s1"), events: [] });
    const starting = actions.changeProjectState("start");
    expect(store.getState().pending.projectControl).toBe("start");

    expect(await actions.sendPrompt("Add a button")).toBe(true);
    expect(calls).toContain("POST /api/sessions/s1/prompt");
    expect(store.getState().session?.awaitingEvent).toBe(true);

    start.resolve(json(200, { project: { ...project("p1"), state: "starting" } }));
    await starting;
    expect(store.getState().pending.projectControl).toBeNull();
    expect(store.getState().projects[0]?.state).toBe("starting");
  });

  test("a second prompt waits for the first request", async () => {
    const first = deferred<Response>();
    const { store } = await openStore([session("s1")], {
      "POST /api/sessions/s1/prompt": () => first.promise,
    });
    const { actions } = store.getState();
    actions.applySnapshot({ session: session("s1"), events: [] });
    const sending = actions.sendPrompt("one");
    expect(await actions.sendPrompt("two")).toBe(false);
    first.resolve(json(202, {}));
    expect(await sending).toBe(true);
  });

  test("a sent prompt shows at once and gives way to the runner's copy", async () => {
    const { store } = await openStore([session("s1")], {
      "POST /api/sessions/s1/prompt": () => json(202, {}),
    });
    const { actions } = store.getState();
    actions.applySnapshot({ session: session("s1"), events: [] });
    const sending = actions.sendPrompt("  Add a button ");
    expect(store.getState().session?.outgoing?.text).toBe("Add a button");
    expect(await sending).toBe(true);

    actions.applyEvent({
      ...event(1, "session.message"),
      payload: { message: { role: "user", text: "Add a button" } },
    });
    expect(store.getState().session?.outgoing).toBeNull();
    expect(openSessionRecord(store.getState())?.status).toBe("running");
  });

  test("a permission request can be answered, and an undo conflict is explained", async () => {
    const { store, calls } = await openStore([session("s1")], {
      "POST /api/sessions/s1/permissions/per-1": () => json(200, { accepted: true }),
      "POST /api/sessions/s1/revert": () =>
        json(409, { status: "conflict", conflicts: ["src/App.tsx"] }),
    });
    const { actions } = store.getState();
    actions.applySnapshot({ session: session("s1"), events: [] });

    await actions.respondToPermission("per-1", "always");
    expect(calls).toContain("POST /api/sessions/s1/permissions/per-1");
    expect(store.getState().pending.permission).toBeNull();

    await actions.revertCheckpoint("c".repeat(40));
    expect(store.getState().error).toContain("src/App.tsx");
    expect(store.getState().pending.revert).toBeNull();
  });

  test("an undo refused for another reason shows the runner's message", async () => {
    const { store } = await openStore([session("s1")], {
      "POST /api/sessions/s1/revert": () =>
        json(409, {
          error: "agent_running",
          message: "An agent is still editing the runner",
        }),
    });
    const { actions } = store.getState();
    actions.applySnapshot({ session: session("s1"), events: [] });
    await actions.revertCheckpoint("c".repeat(40));
    expect(store.getState().error).toBe("An agent is still editing the runner");
  });

  test("a delta streams into the open session without joining its log", async () => {
    const { store } = await openStore([session("s1")]);
    const { actions } = store.getState();
    actions.applySnapshot({ session: session("s1"), events: [] });
    actions.applyEvent({
      ...event(0, "session.delta"),
      durable: false,
      payload: { partId: "t1", field: "text", delta: "Hi" },
    });
    expect(store.getState().session).toMatchObject({
      events: [],
      streaming: { t1: "Hi" },
    });
  });

  test("a prompt carries the picked model, and a remembered model the runner lacks is dropped", async () => {
    const saved = new Map([
      ["nautilus:model", JSON.stringify({ providerId: "old", modelId: "gone" })],
    ]);
    const sonnet = { providerId: "anthropic", modelId: "claude-sonnet-5" };
    const bodies: unknown[] = [];
    const { store } = await openStore([session("s1")], {
      "GET /api/models": () =>
        json(200, {
          models: [
            {
              ...sonnet,
              name: "Claude Sonnet 5",
              providerName: "Anthropic",
              isReasoning: true,
              contextLimit: 1_000_000,
            },
          ],
          default: null,
        }),
      "POST /api/sessions/s1/prompt": (init) => {
        bodies.push(JSON.parse(init?.body as string));
        return json(202, {});
      },
    });

    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => saved.set(key, value),
        removeItem: (key: string) => saved.delete(key),
      },
    });
    const { actions } = store.getState();
    await actions.loadModels();
    expect(store.getState().models.status).toBe("ready");
    expect(store.getState().model).toBeNull();

    actions.setModel(sonnet);
    expect(JSON.parse(saved.get("nautilus:model") ?? "null")).toEqual(sonnet);
    actions.applySnapshot({ session: session("s1"), events: [] });
    expect(await actions.sendPrompt("Add a button")).toBe(true);
    expect(bodies).toEqual([{ prompt: "Add a button", model: sonnet }]);
  });

  test("stop interrupts a running turn", async () => {
    const { store, calls } = await openStore([session("s1", { status: "running" })], {
      "POST /api/sessions/s1/interrupt": () => json(200, {}),
    });
    const { actions } = store.getState();
    actions.applySnapshot({
      session: session("s1", { status: "running" }),
      events: [],
    });
    await actions.interruptSession();
    expect(calls).toContain("POST /api/sessions/s1/interrupt");
    expect(store.getState().pending.interrupt).toBe(false);
  });

  test("a failed prompt reports the runner's message and returns false", async () => {
    const { store } = await openStore([session("s1")], {
      "POST /api/sessions/s1/prompt": () => json(409, { message: "Session is busy" }),
    });
    const { actions } = store.getState();
    actions.applySnapshot({ session: session("s1"), events: [] });
    expect(await actions.sendPrompt("hello")).toBe(false);
    expect(store.getState().error).toBe("Session is busy");
    expect(store.getState().session?.outgoing).toBeNull();
    expect(store.getState().pending.turn).toBeNull();
  });

  test("a 401 from an action signs the device out", async () => {
    const { store } = await openStore([session("s1")], {
      "POST /api/projects/p1/stop": () => json(401, { error: "unauthorized" }),
    });
    await store.getState().actions.changeProjectState("stop");
    expect(store.getState().auth).toBe("unauthenticated");
    expect(store.getState().project).toBeNull();
  });

  test("a new session opens at once", async () => {
    const { store } = await openStore([session("s1")], {
      "POST /api/sessions": () => json(201, { session: session("s2") }),
    });
    await store.getState().actions.createSession();
    const state = store.getState();
    expect(state.project?.sessions.map((one) => one.id)).toEqual(["s2", "s1"]);
    expect(state.session).toMatchObject({ id: "s2", isSnapshotLoaded: true });
  });
});
