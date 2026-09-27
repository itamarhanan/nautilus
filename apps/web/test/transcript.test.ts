import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@nautilus/types";
import { buildTranscript, currentActivity } from "@/lib/transcript";

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
