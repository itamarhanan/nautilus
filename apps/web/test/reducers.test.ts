import { expect, test } from "vitest";
import type { SessionEvent, SessionRecord } from "@nautilus/types";
import {
  mergeEvents,
  mergeSessionList,
  pickSessionId,
  sessionAfter,
  streamingAfter,
} from "@/store/reducers";

function event(sequence: number, type: SessionEvent["type"] = "session.message"): SessionEvent {
  return {
    sessionId: "s1",
    projectId: "p1",
    sequence,
    timestamp: `2026-09-26T10:00:${String(sequence).padStart(2, "0")}Z`,
    type,
    durable: true,
    payload: { copy: sequence },
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

test("merges events by sequence, in order, with the later copy winning", () => {
  const replaced = { ...event(2), payload: { copy: "new" } };
  expect(mergeEvents([event(3), event(1)], [replaced, event(4)])).toEqual([
    event(1),
    replaced,
    event(3),
    event(4),
  ]);
});

test("moves a session's status with lifecycle events", () => {
  const running = session("s1", { status: "running", lastSequence: 3 });
  expect(sessionAfter(running, event(4, "session.completed"))).toMatchObject({
    status: "idle",
    lastSequence: 4,
  });
  expect(sessionAfter(running, event(2, "session.message"))).toMatchObject({
    status: "running",
    lastSequence: 3,
  });
  expect(sessionAfter(session("s1"), event(5, "session.retry")).status).toBe("running");
});

test("keeps the open session if it still exists, otherwise opens the newest", () => {
  const list = [session("new"), session("old")];
  expect(pickSessionId(list, "old")).toBe("old");
  expect(pickSessionId(list, "gone")).toBe("new");
  expect(pickSessionId(list, null)).toBe("new");
  expect(pickSessionId([], "old")).toBeNull();
});

test("a fetched list does not undo what the stream has already applied", () => {
  const fetched = [session("s1", { status: "running", lastSequence: 5 }), session("s2")];
  const local = [session("s1", { status: "idle", lastSequence: 7 })];
  expect(mergeSessionList(fetched, local)).toEqual([local[0], fetched[1]]);

  expect(mergeSessionList([session("s1", { lastSequence: 9 })], local)[0]?.lastSequence).toBe(9);
});

test("streamed text builds up per part until a stored update of the part supersedes it", () => {
  const delta = (partId: string, text: string): SessionEvent => ({
    ...event(4, "session.delta"),
    durable: false,
    payload: { partId, field: "text", delta: text },
  });
  let streaming = streamingAfter({}, delta("t1", "Hel"));
  streaming = streamingAfter(streaming, delta("t1", "lo"));
  streaming = streamingAfter(streaming, delta("t2", "Hmm"));
  expect(streaming).toEqual({ t1: "Hello", t2: "Hmm" });

  const update: SessionEvent = {
    ...event(5),
    payload: { part: { id: "t1", text: "Hello" } },
  };
  expect(streamingAfter(streaming, update)).toEqual({ t2: "Hmm" });
  expect(streamingAfter(streaming, event(6, "session.completed"))).toEqual({});
});

test("the runner's copy of a prompt marks the session running", () => {
  const prompt: SessionEvent = {
    ...event(3),
    payload: { message: { role: "user", text: "Add a button" } },
  };
  expect(sessionAfter(session("s1"), prompt).status).toBe("running");
});
