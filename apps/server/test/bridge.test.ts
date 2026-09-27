import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { Event, Session } from "@opencode-ai/sdk";
import type { ModelRef, ModelsResponse, ProjectConfig } from "@nautilus/types";
import type { OpenCodeEvent, OpenCodeService } from "../src/opencode";
import { createNautilusApp, type NautilusApp } from "../src/index";
import { Logger } from "../src/logger";
import { Registry } from "../src/registry";
import { SessionService, titleFromPrompt } from "../src/sessions";

const authSecret = "b".repeat(32);

function project(): ProjectConfig {
  return {
    id: "bridge",
    name: "Bridge",
    remotePath: "/tmp/bridge",
    devCommand: "node server.js",
    devPort: 3212,
    previewPath: "/preview/bridge/",
  };
}

class FakeOpenCode implements OpenCodeService {
  private readonly queuedEvents: Array<OpenCodeEvent> = [];
  private readonly waiters: Array<() => void> = [];
  private sessionNumber = 0;
  readonly permissions: Array<{
    requestId: string;
    response: string;
    directory: string;
  }> = [];
  readonly prompts: Array<{ text: string; model?: ModelRef }> = [];

  readonly scripts = new Map<string, (sessionId: string) => Event[]>();

  readonly parents = new Map<string, string>();

  async start(): Promise<void> {}

  createSession(_directory: string, title: string): Promise<Session> {
    const id = `oc-${String(++this.sessionNumber)}`;
    return Promise.resolve({
      id,
      projectID: "project-1",
      directory: "/tmp/bridge",
      title,
      version: "1.18.32",
      time: { created: Date.now(), updated: Date.now() },
    });
  }

  listModels(): Promise<ModelsResponse> {
    return Promise.resolve({
      models: [
        {
          providerId: "anthropic",
          modelId: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          providerName: "Anthropic",
          isReasoning: true,
          contextLimit: 1_000_000,
          variants: ["low", "high"],
        },
      ],
      default: { providerId: "anthropic", modelId: "claude-sonnet-5" },
    });
  }

  prompt(sessionId: string, _directory: string, text: string, model?: ModelRef): Promise<void> {
    this.prompts.push(model ? { text, model } : { text });
    const script = this.scripts.get(text);
    if (script) {
      for (const event of script(sessionId)) this.emit(event);
      return Promise.resolve();
    }
    this.emit({
      type: "message.updated",
      properties: {
        info: { id: `message-${text}`, sessionID: sessionId, role: "user" },
      },
    } as unknown as Event);

    this.emit({
      type: "message.part.delta",
      properties: {
        sessionID: sessionId,
        messageID: "reply",
        partID: "reply-text",
        field: "text",
        delta: "Looking",
      },
    } as unknown as Event);
    this.emit({
      type: "session.idle",
      properties: { sessionID: sessionId },
    });
    return Promise.resolve();
  }

  respondToPermission(
    requestId: string,
    response: "once" | "always" | "reject",
    directory: string,
  ): Promise<void> {
    this.permissions.push({ requestId, response, directory });
    return Promise.resolve();
  }

  askPermission(sessionId: string, id: string): void {
    this.emit({
      type: "permission.asked",
      properties: {
        id,
        sessionID: sessionId,
        permission: "bash",
        patterns: ["git push"],
        metadata: {},
        always: ["git push"],
      },
    } as unknown as Event);
  }

  abort(): Promise<void> {
    return Promise.resolve();
  }

  parentSessionId(sessionId: string): Promise<string | null> {
    return Promise.resolve(this.parents.get(sessionId) ?? null);
  }

  async *events(): AsyncGenerator<OpenCodeEvent> {
    while (this.queuedEvents.length === 0) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    yield this.queuedEvents.shift() as OpenCodeEvent;
  }

  async close(): Promise<void> {}

  private emit(payload: Event): void {
    this.queuedEvents.push({ directory: "/tmp/bridge", payload });
    for (const waiter of this.waiters.splice(0)) {
      waiter();
    }
  }
}

async function listen(app: NautilusApp): Promise<number> {
  await new Promise<void>((resolve) => app.controlServer.listen(0, "127.0.0.1", resolve));
  const address = app.controlServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }
  return address.port;
}

test("OpenCode bridge creates sessions, streams translated events, and replays cursors", async () => {
  const openCode = new FakeOpenCode();
  const app = await createNautilusApp({
    authSecret,
    logger: new Logger(() => undefined),
    projects: [project()],
    openCode,
    registryPath: ":memory:",
  });
  const port = await listen(app);

  try {
    const createdResponse = await fetch(`http://127.0.0.1:${String(port)}/api/sessions`, {
      method: "POST",
      headers: {
        "x-nautilus-control": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectId: "bridge", title: "First turn" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      session: { id: string };
    };
    const sessionId = created.session.id;

    const promptResponse = await fetch(
      `http://127.0.0.1:${String(port)}/api/sessions/${sessionId}/prompt`,
      {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "x-nautilus-control": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "Inspect the project" }),
      },
    );
    expect(promptResponse.status).toBe(200);
    expect(promptResponse.headers.get("content-type")).toContain("text/event-stream");

    expect(promptResponse.headers.get("cache-control")).toContain("no-transform");
    const stream = await promptResponse.text();
    expect(stream).toContain("event: session.message");
    expect(stream).toContain("event: session.delta");
    expect(stream).toContain('"delta":"Looking"');
    expect(stream).toContain("event: session.completed");
    expect(stream).toContain("id: 2");

    const snapshotResponse = await fetch(
      `http://127.0.0.1:${String(port)}/api/sessions/${sessionId}`,
      { headers: { "x-nautilus-control": "1" } },
    );
    const snapshot = (await snapshotResponse.json()) as {
      session: { id: string; lastSequence: number; title: string };
      events: Array<{ sequence: number; type: string }>;
    };
    expect(snapshot.session.id).toBe(sessionId);

    expect(snapshot.session.title).toBe("Inspect the project");
    expect(snapshot.events.length).toBeGreaterThan(1);
    expect(snapshot.events.at(-1)?.sequence).toBe(snapshot.session.lastSequence);

    expect(snapshot.events.some((event) => event.type === "session.delta")).toBe(false);

    const replayResponse = await fetch(
      `http://127.0.0.1:${String(port)}/api/sessions/${sessionId}/events?after=1`,
      { headers: { "x-nautilus-control": "1" } },
    );
    expect(replayResponse.status).toBe(200);
    const replayReader = replayResponse.body?.getReader();
    expect(replayReader).toBeDefined();
    let replay = "";
    if (replayReader) {
      const decoder = new TextDecoder();
      while (!replay.includes("event: session.completed")) {
        const chunk = await replayReader.read();
        if (chunk.done) {
          break;
        }
        replay += decoder.decode(chunk.value, { stream: true });
      }
      await replayReader.cancel();
    }
    expect(replay).toContain("event: session.completed");
    expect(replay).not.toContain("event: session.started");

    const retryPrompt = app.registry.appendAgentSessionEvent(sessionId, "session.message", {
      message: { role: "user", text: "Retry this turn" },
    });
    app.registry.setAgentSessionStatus(sessionId, "interrupted", retryPrompt.sequence);
    const retryResponse = await fetch(
      `http://127.0.0.1:${String(port)}/api/sessions/${sessionId}/retry`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "x-nautilus-control": "1",
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    expect(retryResponse.status).toBe(202);

    const answer = (permissionId: string) =>
      fetch(
        `http://127.0.0.1:${String(port)}/api/sessions/${sessionId}/permissions/${permissionId}`,
        {
          method: "POST",
          headers: {
            "x-nautilus-control": "1",
            "content-type": "application/json",
          },
          body: JSON.stringify({ response: "once" }),
        },
      );

    expect((await answer("per-unknown")).status).toBe(404);

    openCode.askPermission("oc-1", "per-1");
    await vi.waitFor(() => {
      const asked = app.registry
        .listDurableAgentSessionEvents(sessionId)
        .find((event) => event.type === "session.permission");
      expect(asked?.payload).toMatchObject({
        id: "per-1",
        permission: "bash",
        title: "bash: git push",
      });
    });
    expect((await answer("per-1")).status).toBe(200);
    expect(openCode.permissions).toEqual([
      {
        requestId: "per-1",
        response: "once",
        directory: expect.any(String) as string,
      },
    ]);
  } finally {
    await app.close();
  }
});

test("a project registered after boot can open a session", async () => {
  const projectsRoot = await mkdtemp(join(tmpdir(), "nautilus-late-"));
  const app = await createNautilusApp({
    authSecret,
    logger: new Logger(() => undefined),
    projects: [],
    projectsRoot,
    openCode: new FakeOpenCode(),
    registryPath: ":memory:",
  });
  const port = await listen(app);
  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${String(port)}${path}`, {
      method: "POST",
      headers: {
        "x-nautilus-control": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  try {
    expect((await post("/api/projects", { projectId: "late", name: "Late" })).status).toBe(201);
    const created = await post("/api/sessions", {
      projectId: "late",
      title: "First turn",
    });
    expect(created.status).toBe(201);
  } finally {
    await app.close();
    await rm(projectsRoot, { recursive: true, force: true });
  }
});

test("a prompt runs on the model and variant it names, and a retry keeps both", async () => {
  const openCode = new FakeOpenCode();
  const app = await createNautilusApp({
    authSecret,
    logger: new Logger(() => undefined),
    projects: [project()],
    openCode,
    registryPath: ":memory:",
  });
  const port = await listen(app);
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${String(port)}${path}`, {
      method,
      headers: {
        "x-nautilus-control": "1",
        "content-type": "application/json",
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  const sonnet = { providerId: "anthropic", modelId: "claude-sonnet-5" };
  const thinking = { ...sonnet, variant: "high" };

  try {
    const models = (await (await call("GET", "/api/models")).json()) as ModelsResponse;
    expect(models.default).toEqual(sonnet);
    expect(models.models.map((model) => model.name)).toEqual(["Claude Sonnet 5"]);
    expect(models.models[0]?.variants).toEqual(["low", "high"]);

    const created = (await (
      await call("POST", "/api/sessions", {
        projectId: "bridge",
        title: "Models",
      })
    ).json()) as { session: { id: string } };
    const sessionId = created.session.id;

    const invalid = await call("POST", `/api/sessions/${sessionId}/prompt`, {
      prompt: "Hi",
      model: { providerId: "anthropic" },
    });
    expect(invalid.status).toBe(400);
    const badVariant = await call("POST", `/api/sessions/${sessionId}/prompt`, {
      prompt: "Hi",
      model: { ...sonnet, variant: "not a name" },
    });
    expect(badVariant.status).toBe(400);

    const sent = await call("POST", `/api/sessions/${sessionId}/prompt`, {
      prompt: "Hi",
      model: thinking,
    });
    expect(sent.status).toBe(202);
    await vi.waitFor(() => {
      expect(app.registry.getAgentSession(sessionId)?.status).toBe("idle");
    });

    app.registry.setAgentSessionStatus(sessionId, "interrupted");
    expect((await call("POST", `/api/sessions/${sessionId}/retry`, {})).status).toBe(202);
    expect(openCode.prompts).toEqual([
      { text: "Hi", model: thinking },
      { text: "Hi", model: thinking },
    ]);
  } finally {
    await app.close();
  }
});

test("subagent events land on the parent session without ending its turn", async () => {
  const openCode = new FakeOpenCode();
  const app = await createNautilusApp({
    authSecret,
    logger: new Logger(() => undefined),
    projects: [project()],
    openCode,
    registryPath: ":memory:",
  });
  const port = await listen(app);
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${String(port)}${path}`, {
      method,
      headers: {
        "x-nautilus-control": "1",
        "content-type": "application/json",
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  const childText = (sessionID: string, id: string) =>
    ({
      type: "message.part.updated",
      properties: {
        part: {
          id,
          sessionID,
          messageID: `${sessionID}-reply`,
          type: "text",
          text: "Found it",
        },
      },
    }) as unknown as Event;
  const idle = (sessionID: string) =>
    ({ type: "session.idle", properties: { sessionID } }) as unknown as Event;

  openCode.parents.set("child-2", "oc-1");
  openCode.scripts.set("Delegate", (root) => [
    {
      type: "todo.updated",
      properties: {
        sessionID: root,
        todos: [
          {
            id: "1",
            content: "Explore",
            status: "in_progress",
            priority: "high",
          },
        ],
      },
    } as unknown as Event,
    {
      type: "message.part.updated",
      properties: {
        part: {
          id: "task-1",
          sessionID: root,
          messageID: "root-reply",
          type: "tool",
          tool: "task",
          callID: "call-1",
          state: {
            status: "running",
            input: { description: "Explore", prompt: "Look around" },
            metadata: { sessionId: "child-1" },
            time: { start: 1 },
          },
        },
      },
    } as unknown as Event,
    childText("child-1", "child-1-text"),
    idle("child-1"),
    childText("child-2", "child-2-text"),
    {
      type: "session.error",
      properties: { sessionID: "child-2", error: { name: "UnknownError" } },
    } as unknown as Event,
    childText("stranger", "stranger-text"),
    idle(root),
  ]);

  try {
    const created = (await (
      await call("POST", "/api/sessions", {
        projectId: "bridge",
        title: "Subagents",
      })
    ).json()) as { session: { id: string } };
    const sessionId = created.session.id;
    expect(
      (
        await call("POST", `/api/sessions/${sessionId}/prompt`, {
          prompt: "Delegate",
        })
      ).status,
    ).toBe(202);
    await vi.waitFor(() => {
      expect(app.registry.getAgentSession(sessionId)?.status).toBe("idle");
    });

    const events = app.registry.listDurableAgentSessionEvents(sessionId);
    const fromSubagents = events.filter((event) => typeof event.payload.subagent === "string");
    expect(fromSubagents.map((event) => [event.type, event.payload.subagent])).toEqual([
      ["session.message", "child-1"],
      ["session.message", "child-2"],
    ]);
    expect(events.filter((event) => event.type === "session.completed")).toHaveLength(1);
    expect(events.some((event) => event.type === "session.error")).toBe(false);
    expect(events.find((event) => event.type === "session.todo")?.payload.todos).toEqual([
      { id: "1", content: "Explore", status: "in_progress", priority: "high" },
    ]);
    expect(JSON.stringify(events)).not.toContain("stranger-text");
  } finally {
    await app.close();
  }
});

test("an interrupted turn is checkpointed so its edits do not block a sync", async () => {
  const openCode = new FakeOpenCode();
  const registry = new Registry(":memory:");
  registry.upsertProject(project());
  const checkpoints: string[] = [];
  const sessions = new SessionService(
    openCode,
    registry,
    new Map([["bridge", project()]]),
    new Logger(() => undefined),
    {
      checkpoint: (_projectId, sessionId) => {
        checkpoints.push(sessionId);
        return Promise.resolve({ commit: "c".repeat(40), previousHead: null });
      },
      changes: () => Promise.reject(new Error("unused")),
      revert: () => Promise.reject(new Error("unused")),
    },
  );
  openCode.scripts.set("Edit and stop", (sessionID) => [
    {
      type: "session.error",
      properties: { sessionID, error: { name: "MessageAbortedError" } },
    } as unknown as Event,
  ]);
  await sessions.start();
  const session = await sessions.createSession("bridge", "Interrupted");
  await sessions.prompt(session.id, "Edit and stop");
  await vi.waitFor(() => {
    expect(registry.getAgentSession(session.id)?.status).toBe("interrupted");
  });
  expect(checkpoints).toEqual([session.id]);
});

test("a session title is the first line of its first prompt, shortened for a list", () => {
  expect(titleFromPrompt("  Add a login page\nwith a password field  ")).toBe("Add a login page");
  expect(titleFromPrompt("Fix   the\tspacing")).toBe("Fix the spacing");
  expect(titleFromPrompt("\n\n")).toBe("Untitled session");
  const long = titleFromPrompt("x".repeat(100));
  expect(long).toHaveLength(60);
  expect(long.endsWith("…")).toBe(true);
});

test("a session's checkpoints can be read and reverted, and the revert is recorded", async () => {
  const registry = new Registry(":memory:");
  registry.upsertProject(project());
  const reverts: Array<{ commit: string; previousHead: string | null }> = [];
  const sessions = new SessionService(
    new FakeOpenCode(),
    registry,
    new Map([["bridge", project()]]),
    new Logger(() => undefined),
    {
      checkpoint: () => Promise.reject(new Error("unused")),
      changes: (_projectId, from, to) =>
        Promise.resolve({
          files: [
            {
              path: `${String(from)}..${to}`,
              status: "modified",
              binary: false,
              additions: 1,
              deletions: 0,
              hunks: [],
            },
          ],
          additions: 1,
          deletions: 0,
        }),
      revert: (_projectId, commit, previousHead) => {
        reverts.push({ commit, previousHead });
        return Promise.resolve({
          status: "ok",
          checkpoint: { commit: "d".repeat(40), previousHead: "c".repeat(40) },
        });
      },
    },
  );
  const session = await sessions.createSession("bridge", "Work");
  const turn = "b".repeat(40);
  registry.appendAgentSessionEvent(session.id, "session.checkpoint", {
    commit: turn,
    previousHead: "a".repeat(40),
  });

  registry.appendAgentSessionEvent(session.id, "session.checkpoint", {
    commit: "e".repeat(40),
  });

  const diff = await sessions.changes(session.id, turn);
  expect(diff.files[0]?.path).toBe(`${"a".repeat(40)}..${turn}`);
  await expect(sessions.changes(session.id, "e".repeat(40))).rejects.toMatchObject({
    code: "checkpoint_not_found",
  });
  await expect(sessions.changes(session.id, "f".repeat(40))).rejects.toMatchObject({
    code: "checkpoint_not_found",
  });

  expect((await sessions.revert(session.id, turn)).status).toBe("ok");
  expect(reverts).toEqual([{ commit: turn, previousHead: "a".repeat(40) }]);
  const recorded = registry
    .listDurableAgentSessionEvents(session.id)
    .filter((event) => event.type === "session.checkpoint")
    .at(-1);
  expect(recorded?.payload).toMatchObject({
    commit: "d".repeat(40),
    revertOf: turn,
  });
});
