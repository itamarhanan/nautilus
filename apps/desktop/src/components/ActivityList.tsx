import type { SyncEvent } from "@nautilus/types";
import { Badge } from "@astryxdesign/core/Badge";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { ArrowDownToLine, ArrowUpFromLine, Bot } from "lucide-react";
import { readableStatus } from "@nautilus/copy";

const DIRECTION_ICON = {
  pull: <ArrowDownToLine className="size-4 text-secondary" aria-hidden />,
  push: <ArrowUpFromLine className="size-4 text-secondary" aria-hidden />,
  system: <Bot className="size-4 text-secondary" aria-hidden />,
};

function eventTitle(event: SyncEvent): string {
  if (event.direction === "system") return "Agent checkpoint";
  if (event.undone) return "Pulled to this PC, then undone";
  return event.direction === "pull" ? "Pulled to this PC" : "Pushed to the runner";
}

export function ActivityList({
  events,
  projectNames,
}: {
  events: SyncEvent[];
  projectNames?: Partial<Record<string, string>>;
}) {
  if (events.length === 0) {
    return (
      <Text type="supporting">Nothing yet. Pushes, pulls, and agent checkpoints show up here.</Text>
    );
  }
  return (
    <List hasDividers>
      {events
        .slice(-8)
        .reverse()
        .map((event) => (
          <ListItem
            key={`${event.projectId}:${event.requestId}`}
            label={eventTitle(event)}
            description={projectNames ? projectNames[event.projectId] : undefined}
            startContent={DIRECTION_ICON[event.direction]}
            endContent={
              <div className="flex items-center gap-2">
                {event.status === "ok" ? null : (
                  <Badge
                    variant={
                      event.status === "conflict" || event.status === "stale" ? "warning" : "error"
                    }
                    label={readableStatus(event.status)}
                  />
                )}
                <Text type="supporting">
                  <Timestamp value={event.committedAt ?? event.createdAt} format="relative" />
                </Text>
              </div>
            }
          />
        ))}
    </List>
  );
}
