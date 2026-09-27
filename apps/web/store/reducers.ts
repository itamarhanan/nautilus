import type { SessionEvent, SessionRecord } from "@nautilus/types";
import { isTerminalEvent, record } from "@/lib/values";

export function mergeEvents(current: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  for (const event of incoming) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function statusAfter(
  event: SessionEvent,
  current: SessionRecord["status"],
): SessionRecord["status"] {
  if (isUserPrompt(event)) return "running";
  switch (event.type) {
    case "session.retry":
      return "running";
    case "session.completed":
      return "idle";
    case "session.interrupted":
      return "interrupted";
    case "session.error":
      return "error";
    default:
      return current;
  }
}

export function sessionAfter(session: SessionRecord, event: SessionEvent): SessionRecord {
  return {
    ...session,
    status: statusAfter(event, session.status),
    lastSequence: Math.max(session.lastSequence, event.sequence),
    updatedAt: event.timestamp,
  };
}

export function replaceById<T extends { id: string }>(list: T[], updated: T): T[] {
  return list.map((item) => (item.id === updated.id ? updated : item));
}

export function pickSessionId(sessions: SessionRecord[], currentId: string | null): string | null {
  if (currentId && sessions.some((session) => session.id === currentId)) return currentId;
  return sessions[0]?.id ?? null;
}

export function mergeSessionList(
  incoming: SessionRecord[],
  current: SessionRecord[],
): SessionRecord[] {
  const known = new Map(current.map((session) => [session.id, session]));
  return incoming.map((session) => {
    const local = known.get(session.id);
    return local && local.lastSequence > session.lastSequence ? local : session;
  });
}

export function streamingAfter(
  streaming: Record<string, string>,
  event: SessionEvent,
): Record<string, string> {
  if (event.type === "session.delta") {
    const { partId, field, delta } = event.payload;
    if (typeof partId !== "string" || typeof delta !== "string" || field !== "text") {
      return streaming;
    }
    return { ...streaming, [partId]: (streaming[partId] ?? "") + delta };
  }
  if (isTerminalEvent(event)) return Object.keys(streaming).length > 0 ? {} : streaming;
  const partId = record(event.payload.part).id;
  if (typeof partId !== "string" || !(partId in streaming)) return streaming;
  return Object.fromEntries(Object.entries(streaming).filter(([id]) => id !== partId));
}

export function isUserPrompt(event: SessionEvent): boolean {
  const message = record(event.payload.message);
  return (
    event.type === "session.message" && message.role === "user" && typeof message.text === "string"
  );
}
