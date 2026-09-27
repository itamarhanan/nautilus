import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@nautilus/types";
import {
  buildTranscript,
  currentActivity,
  latestTodos,
  subagentsOf,
  threadEvents,
} from "@/lib/transcript";

let sequence = 0;
function event(type: SessionEvent["type"], payload: Record<string, unknown>): SessionEvent {
  sequence += 1;
  return {
    sessionId: "s1",
    projectId: "p1",
    sequence,
    timestamp: `2026-09-25T10:00:${String(sequence).padStart(2, "0")}Z`,
    type,
    durable: true,
    payload,
  };
}

describe("buildTranscript", () => {
  it("groups streamed parts into one assistant turn and keeps the latest text", () => {
    const items = buildTranscript([
      event("session.message", {
        message: { role: "user", text: "Add a button" },
      }),
      event("session.message", { message: { id: "u1", role: "user" } }),
      event("session.message", {
        part: { id: "up", messageID: "u1", type: "text", text: "Add a button" },
      }),
      event("session.message", {
        message: { id: "a1", role: "assistant", modelID: "claude-opus-5-5" },
      }),
      event("session.message", {
        part: { id: "t1", messageID: "a1", type: "text", text: "Look" },
      }),
      event("session.tool", {
        part: {
          id: "tool1",
          messageID: "a1",
          type: "tool",
          tool: "read",
          state: {
            status: "running",
            input: { filePath: "src/App.tsx" },
            time: { start: 0 },
          },
        },
      }),
      event("session.message", {
        part: {
          id: "t1",
          messageID: "a1",
          type: "text",
          text: "Looking at the app",
        },
      }),
      event("session.tool", {
        part: {
          id: "tool1",
          messageID: "a1",
          type: "tool",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            title: "src/App.tsx",
            output: "ok",
            time: { start: 0, end: 1500 },
          },
        },
      }),
      event("session.completed", {}),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    const assistant = items.at(1);
    if (assistant?.kind !== "assistant") throw new Error("expected assistant turn");
    expect(assistant.model).toBe("claude-opus-5-5");
    expect(assistant.parts).toEqual([
      {
        kind: "text",
        id: "t1",
        text: "Looking at the app",
        isStreaming: false,
      },
      {
        kind: "tool",
        id: "tool1",
        call: {
          id: "tool1",
          name: "read",
          status: "complete",
          target: "src/App.tsx",
          duration: "1.5s",
          output: "ok",
          error: undefined,
        },
      },
    ]);
  });

  it("turns lifecycle events into notices", () => {
    const items = buildTranscript([
      event("session.checkpoint", { commit: "abcdef1234" }),
      event("session.interrupted", { error: { name: "MessageAbortedError" } }),
      event("session.error", {
        error: { name: "ProviderAuthError", data: { message: "Invalid key" } },
      }),
      event("session.error", { error: "prompt_failed" }),
    ]);

    expect(items).toMatchObject([
      { kind: "notice", tone: "info", text: "Checkpoint abcdef1" },
      { kind: "notice", tone: "warning", text: "Turn interrupted" },
      { kind: "notice", tone: "error", text: "Invalid key" },
      { kind: "notice", tone: "error", text: "prompt_failed" },
    ]);
  });
});

describe("live turn", () => {
  const start = [
    event("session.message", {
      message: { role: "user", text: "Add a button" },
    }),
    event("session.message", { message: { id: "a2", role: "assistant" } }),
    event("session.message", {
      part: { id: "t2", messageID: "a2", type: "text", text: "" },
    }),
  ];

  it("appends streamed text to the stored part and marks it streaming", () => {
    const items = buildTranscript(start, {
      streaming: { t2: "Adding it now" },
    });
    const assistant = items.at(-1);
    if (assistant?.kind !== "assistant") throw new Error("expected assistant turn");
    expect(assistant.parts).toEqual([
      { kind: "text", id: "t2", text: "Adding it now", isStreaming: true },
    ]);
    expect(currentActivity(items)).toBeNull();
  });

  it("shows a prompt that is still being sent after the log", () => {
    const items = buildTranscript([], {
      outgoing: { text: "Add a button", timestamp: "2026-09-25T10:01:00Z" },
    });
    expect(items).toEqual([
      {
        kind: "user",
        key: "user:outgoing",
        text: "Add a button",
        timestamp: "2026-09-25T10:01:00Z",
        isPending: true,
      },
    ]);
    expect(currentActivity(items)).toBe("Sending");
  });

  it("names the running tool as the current activity", () => {
    const items = buildTranscript([
      ...start,
      event("session.tool", {
        part: {
          id: "tool2",
          messageID: "a2",
          type: "tool",
          tool: "bash",
          state: { status: "running", input: { command: "pnpm test" } },
        },
      }),
    ]);
    expect(currentActivity(items)).toBe("Running bash: pnpm test");
  });
});

describe("notices", () => {
  it("shows a stopped turn once and not as a failure", () => {
    const items = buildTranscript([
      event("session.message", { message: { role: "user", text: "Explore" } }),
      event("session.message", {
        message: {
          id: "a3",
          role: "assistant",
          error: { name: "MessageAbortedError" },
        },
      }),
      event("session.message", {
        part: { id: "t3", messageID: "a3", type: "text", text: "On it" },
      }),
      event("session.interrupted", { reason: "user" }),
      event("session.checkpoint", { commit: "4dc7ebe0" }),
      event("session.interrupted", { error: { name: "MessageAbortedError" } }),
      event("session.checkpoint", { commit: "4dc7ebe0" }),
    ]);
    const assistant = items.find((item) => item.kind === "assistant");
    expect(assistant?.kind === "assistant" && assistant.error).toBeNull();
    expect(items.filter((item) => item.kind === "notice").map((item) => item.text)).toEqual([
      "Turn interrupted",
      "Checkpoint 4dc7ebe",
    ]);
  });
});

describe("subagents and todos", () => {
  const task = (status: string) =>
    event("session.tool", {
      part: {
        id: "task-1",
        messageID: "a1",
        type: "tool",
        tool: "task",
        state: {
          status,
          title: "Explore the server",
          input: {
            description: "Explore",
            prompt: "Read src/",
            subagent_type: "explore",
          },
          metadata: { sessionId: "child-1" },
        },
      },
    });
  const childText = event("session.message", {
    subagent: "child-1",
    part: { id: "c1", messageID: "cm1", type: "text", text: "Reading files" },
  });

  it("keeps a subagent's events out of the main thread and in its own", () => {
    const events = [task("running"), childText];
    const main = buildTranscript(threadEvents(events, null));
    expect(main).toHaveLength(1);
    expect(main[0]?.kind === "assistant" && main[0].parts[0]?.kind).toBe("tool");
    const child = buildTranscript(threadEvents(events, "child-1"));
    expect(child.map((item) => item.kind === "assistant" && item.parts[0]?.kind)).toEqual(["text"]);
    expect(currentActivity(main)).toBe("Waiting on Explore the server");
  });

  it("lists subagents with their brief and status, and settles them when the turn ends", () => {
    expect(subagentsOf([task("running"), childText])).toEqual([
      {
        id: "child-1",
        title: "Explore the server",
        agentType: "explore",
        prompt: "Read src/",
        status: "running",
        error: null,
      },
    ]);
    const stopped = subagentsOf([task("running"), event("session.interrupted", {})]);
    expect(stopped[0]?.status).toBe("error");
    expect(subagentsOf([task("completed")])[0]?.status).toBe("complete");
  });

  it("reads the main agent's latest todo list and ignores a subagent's", () => {
    const todos = latestTodos([
      event("session.todo", {
        todos: [{ id: "1", content: "Old", status: "pending" }],
      }),
      event("session.todo", {
        todos: [
          { id: "1", content: "Plan", status: "completed", priority: "high" },
          { id: "2", content: "Build", status: "in_progress" },
          { id: "3", status: "pending" },
        ],
      }),
      event("session.todo", {
        subagent: "child-1",
        todos: [{ id: "9", content: "Sub", status: "pending" }],
      }),
    ]);
    expect(todos).toEqual([
      { id: "1", content: "Plan", status: "completed", priority: "high" },
      { id: "2", content: "Build", status: "in_progress", priority: "medium" },
    ]);
  });
});

describe("permission requests", () => {
  const asked = (id: string, subagent?: string) =>
    event("session.permission", {
      id,
      permission: "bash",
      patterns: ["git push"],
      title: "bash: git push",
      ...(subagent ? { subagent } : {}),
    });

  it("shows an open request until OpenCode's reply answers it in place", () => {
    const open = buildTranscript([asked("per-1")]);
    expect(open).toEqual([
      expect.objectContaining({
        kind: "permission",
        id: "per-1",
        permission: "bash",
        patterns: ["git push"],
        response: null,
      }),
    ]);
    expect(currentActivity(open)).toBe("Waiting for your approval");

    const answered = buildTranscript([
      asked("per-1"),
      event("session.permission", { id: "per-1", response: "always" }),
    ]);
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({
      kind: "permission",
      response: "always",
    });
    expect(currentActivity(answered)).not.toBe("Waiting for your approval");
  });

  it("ignores a reply with no request before it", () => {
    expect(
      buildTranscript([event("session.permission", { id: "per-9", response: "once" })]),
    ).toEqual([]);
  });

  it("puts a subagent's request in the main thread, where it can be answered", () => {
    const events = [asked("per-2", "child-session")];
    expect(threadEvents(events, null)).toHaveLength(1);
    expect(threadEvents(events, "child-session")).toHaveLength(1);
  });
});

describe("checkpoints", () => {
  it("turns a checkpoint with a starting point into a reviewable item", () => {
    const items = buildTranscript([
      event("session.checkpoint", {
        commit: "b".repeat(40),
        previousHead: "a".repeat(40),
      }),
      event("session.checkpoint", {
        commit: "c".repeat(40),
        previousHead: "b".repeat(40),
        revertOf: "b".repeat(40),
      }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        kind: "checkpoint",
        commit: "b".repeat(40),
        revertOf: null,
      }),
      expect.objectContaining({ kind: "checkpoint", revertOf: "b".repeat(40) }),
    ]);
  });

  it("keeps a checkpoint without a starting point as a plain notice", () => {
    expect(buildTranscript([event("session.checkpoint", { commit: "d".repeat(40) })])).toEqual([
      expect.objectContaining({ kind: "notice", text: "Checkpoint ddddddd" }),
    ]);
  });
});
