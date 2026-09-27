import { describe, expect, it } from "vitest";
import type { TodoItem } from "@nautilus/types";
import {
  formatElapsed,
  lastModelId,
  showsMetadata,
  tabLabel,
  toolCallCount,
  turnStartedAt,
  workingActivity,
} from "@/lib/session-view";
import type { TranscriptItem } from "@/lib/transcript";

const user = (text: string, timestamp: string): TranscriptItem => ({
  kind: "user",
  key: `user:${text}`,
  text,
  timestamp,
  isPending: false,
});

const reply = (key: string, model: string | null, tools = 0): TranscriptItem => ({
  kind: "assistant",
  key,
  parts: Array.from({ length: tools }, (_, index) => ({
    kind: "tool" as const,
    id: `${key}-${String(index)}`,
    call: { id: `${key}-${String(index)}`, name: "read", status: "complete" as const },
  })),
  timestamp: "2026-09-26T10:00:00Z",
  model,
  error: null,
  usage: null,
  turnUsage: null,
});

describe("session view", () => {
  const thread = [
    user("First", "2026-09-26T10:00:00Z"),
    reply("a1", "model-a", 2),
    reply("a2", null, 1),
    user("Second", "2026-09-26T10:05:00Z"),
    reply("a3", "model-b"),
  ];

  it("reads the latest model, the turn's start, and the tool calls", () => {
    expect(lastModelId(thread)).toBe("model-b");
    expect(lastModelId(thread.slice(0, 3))).toBe("model-a");
    expect(turnStartedAt(thread)).toBe("2026-09-26T10:05:00Z");
    expect(turnStartedAt([])).toBeNull();
    expect(toolCallCount(thread)).toBe(3);
  });

  it("shows a turn's time and model once, under its last step, once it is over", () => {
    expect(thread.map((_, index) => showsMetadata(thread, index, false))).toEqual([
      true,
      false,
      true,
      true,
      true,
    ]);
    expect(showsMetadata(thread, 4, true)).toBe(false);
  });

  it("says what is happening, preferring subagents and then the todo in progress", () => {
    const todos: TodoItem[] = [
      { id: "1", content: "Write tests", status: "in_progress", priority: "medium" },
    ];
    expect(workingActivity(thread, [], todos)).toBe("Write tests");
    expect(workingActivity(thread, [], [])).toBe("Thinking");
    expect(workingActivity(thread, [{ title: "Explore", activity: null }], todos)).toBe(
      "Explore: Working",
    );
    expect(
      workingActivity(
        thread,
        [
          { title: "A", activity: "Reading" },
          { title: "B", activity: null },
        ],
        todos,
      ),
    ).toBe("2 subagents working");
  });

  it("formats labels and elapsed time", () => {
    expect(tabLabel("Short")).toBe("Short");
    expect(tabLabel("A title that is much too long for a tab")).toBe(
      "A title that is much too lo…",
    );
    expect(formatElapsed(42)).toBe("42s");
    expect(formatElapsed(125)).toBe("2m 05s");
  });
});
