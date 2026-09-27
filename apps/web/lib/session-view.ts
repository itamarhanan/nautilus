import { activity as text } from "@nautilus/copy";
import type { SessionEvent, TodoItem } from "@nautilus/types";
import {
  currentActivity,
  foldEvents,
  subagentsOf,
  type Subagent,
  type Thread,
  type TranscriptItem,
  threadEvents,
  withLive,
} from "./transcript";

export function isRunning(status: Subagent["status"]): boolean {
  return status === "running" || status === "pending";
}

export function toolCallCount(items: readonly TranscriptItem[]): number {
  let count = 0;
  for (const item of items) {
    if (item.kind === "assistant")
      count += item.parts.filter((part) => part.kind === "tool").length;
  }
  return count;
}

export function lastModelId(items: readonly TranscriptItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "assistant" && item.model) return item.model;
  }
  return null;
}

export function turnStartedAt(items: readonly TranscriptItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "user") return item.timestamp;
  }
  return null;
}

export function showsMetadata(
  items: readonly TranscriptItem[],
  index: number,
  isWorking: boolean,
): boolean {
  if (items[index]?.kind !== "assistant") return true;
  return index === items.length - 1 ? !isWorking : items[index + 1]?.kind !== "assistant";
}

export function workingActivity(
  transcript: readonly TranscriptItem[],
  running: readonly { title: string; activity: string | null }[],
  todos: readonly TodoItem[],
): string | null {
  const only = running.at(0);
  if (running.length === 1 && only) return `${only.title}: ${only.activity ?? text.working}`;
  if (running.length > 1) return text.subagentsWorking(running.length);
  const activity = currentActivity(transcript);
  if (activity !== text.thinking) return activity;
  return todos.find((todo) => todo.status === "in_progress")?.content ?? activity;
}

export function tabLabel(title: string): string {
  return title.length > 28 ? `${title.slice(0, 27).trimEnd()}…` : title;
}

export function formatElapsed(seconds: number): string {
  return seconds < 60
    ? `${String(seconds)}s`
    : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function threadActivity(
  status: Subagent["status"],
  items: readonly TranscriptItem[],
): string | null {
  return isRunning(status) ? (currentActivity(items) ?? text.working) : null;
}

export function buildThreads(
  events: readonly SessionEvent[],
  streaming: Readonly<Record<string, string>>,
): Map<string, Thread> {
  const byId = new Map<string, Thread>();
  for (const subagent of subagentsOf(events)) {
    const items = withLive(foldEvents(threadEvents(events, subagent.id)), { streaming });
    byId.set(subagent.id, {
      ...subagent,
      items,
      steps: toolCallCount(items),
      activity: threadActivity(subagent.status, items),
    });
  }
  return byId;
}

export function isSessionWorking(
  status: string | null | undefined,
  awaitingEvent: boolean,
): boolean {
  return status === "running" || awaitingEvent;
}

export function canRetryTurn(status: string | null | undefined): boolean {
  return status === "interrupted" || status === "error";
}

export function hasOpenTodos(todos: readonly TodoItem[]): boolean {
  return todos.some((todo) => todo.status === "pending" || todo.status === "in_progress");
}
