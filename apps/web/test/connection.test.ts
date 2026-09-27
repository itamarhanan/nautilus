import { expect, test } from "vitest";
import { connectionDetail, connectionLabel, connectionTone } from "@/lib/connection";
import type { StreamState } from "@/lib/stream/session-stream";

function stream(overrides: Partial<StreamState> = {}): StreamState {
  return {
    phase: "idle",
    attempt: 0,
    nextRetryAt: null,
    error: null,
    ...overrides,
  };
}

test.each<[string, boolean, string]>([
  ["connected", true, "Live"],
  ["connecting", true, "Connecting"],
  ["reconnecting", true, "Reconnecting"],
  ["idle", true, "No session"],
  ["stopped", true, "Waiting"],
  ["offline", true, "Offline"],
])("the badge reads %s as %s", (phase, online, expected) => {
  expect(connectionLabel(stream({ phase: phase as StreamState["phase"] }), online)).toBe(expected);
});

test("a stopped stream that failed says so, and a lost network outranks the phase", () => {
  expect(connectionLabel(stream({ phase: "stopped", error: "boom" }), true)).toBe("Stream stopped");
  expect(connectionLabel(stream({ phase: "connected" }), false)).toBe("Offline");
});

test("the detail line explains a countdown only when there is a time to count to", () => {
  expect(connectionDetail(stream({ phase: "reconnecting" }), true)).toBe(
    "Connection lost. Reconnecting now.",
  );
  const soon = Date.now() + 4_000;
  expect(connectionDetail(stream({ phase: "reconnecting", nextRetryAt: soon }), true)).toContain(
    "Next attempt in 4s",
  );
});

test("the detail line passes a failure through, and otherwise prompts for a session", () => {
  expect(connectionDetail(stream({ phase: "stopped", error: "runner gone" }), true)).toBe(
    "runner gone",
  );
  expect(connectionDetail(stream(), true)).toBe("Select a session to open its event stream.");
});

test("tone tracks reachability first, then how settled the stream is", () => {
  expect(connectionTone(stream({ phase: "connected" }), true)).toBe("success");
  expect(connectionTone(stream({ phase: "connected" }), false)).toBe("error");
  expect(connectionTone(stream({ phase: "reconnecting" }), true)).toBe("warning");
  expect(connectionTone(stream(), true)).toBe("neutral");
});
