import type { SessionEvent, TodoItem, TodoStatus } from "@nautilus/types";
import { record, text } from "../values";
import { subagentOf } from "./subagents";

const TODO_STATUSES = new Set<string>(["pending", "in_progress", "completed", "cancelled"]);

export function latestTodos(events: readonly SessionEvent[]): TodoItem[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "session.todo" || subagentOf(event)) continue;
    const todos = Array.isArray(event.payload.todos) ? event.payload.todos : [];
    return todos.flatMap((value, position): TodoItem[] => {
      const todo = record(value);
      const content = text(todo.content);
      if (!content) return [];
      const status = text(todo.status) ?? "pending";
      const priority = text(todo.priority);
      return [
        {
          id: text(todo.id) ?? String(position),
          content,
          status: (TODO_STATUSES.has(status) ? status : "pending") as TodoStatus,
          priority: priority === "high" || priority === "low" ? priority : "medium",
        },
      ];
    });
  }
  return [];
}
