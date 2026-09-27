import type { SessionEvent } from "@nautilus/types";

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function errorText(value: unknown): string | null {
  if (typeof value === "string") return value;
  const error = record(value);
  return text(record(error.data).message) ?? text(error.message) ?? text(error.name);
}

const TERMINAL_EVENTS = new Set<SessionEvent["type"]>([
  "session.completed",
  "session.interrupted",
  "session.error",
]);

export function isTerminalEvent(event: SessionEvent): boolean {
  return TERMINAL_EVENTS.has(event.type);
}
