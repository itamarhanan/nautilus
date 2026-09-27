import type { TodoItem } from "@nautilus/types";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Text } from "@astryxdesign/core/Text";
import { Circle, CircleCheck, CircleDot, CircleSlash } from "lucide-react";

const ICON = {
  completed: <CircleCheck className="size-4 text-success" aria-label="Done" />,
  in_progress: <CircleDot className="size-4 text-accent" aria-label="In progress" />,
  pending: <Circle className="size-4 text-secondary" aria-label="To do" />,
  cancelled: <CircleSlash className="size-4 text-secondary" aria-label="Cancelled" />,
};

export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const done = todos.filter(
    (todo) => todo.status === "completed" || todo.status === "cancelled",
  ).length;
  const current = todos.find((todo) => todo.status === "in_progress");

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <Collapsible
        defaultIsOpen={false}
        trigger={
          <span className="flex min-w-0 flex-1 flex-col gap-1 text-start">
            <span className="flex min-w-0 items-baseline gap-2">
              <Text weight="semibold" className="shrink-0">
                Tasks
              </Text>
              <Text type="supporting" hasTabularNumbers className="shrink-0">
                {done}/{todos.length}
              </Text>
              {current ? (
                <Text type="supporting" maxLines={1} hasTruncateTooltip={false}>
                  {current.content}
                </Text>
              ) : null}
            </span>
            <ProgressBar value={done} max={todos.length} label="Tasks done" isLabelHidden />
          </span>
        }
      >
        <ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto pt-2">
          {todos.map((todo) => (
            <li key={todo.id} className="flex min-w-0 items-start gap-2">
              <span className="mt-0.5 shrink-0">{ICON[todo.status]}</span>
              <Text
                type={todo.status === "in_progress" ? undefined : "supporting"}
                className={
                  todo.status === "completed" || todo.status === "cancelled"
                    ? "line-through"
                    : undefined
                }
              >
                {todo.content}
              </Text>
            </li>
          ))}
        </ul>
      </Collapsible>
    </div>
  );
}
