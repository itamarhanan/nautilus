import type { ProjectRecord, SyncEvent } from "@nautilus/types";
import { Badge } from "@astryxdesign/core/Badge";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { ArrowDownToLine, ArrowUpFromLine, CircleDot, History } from "lucide-react";
import { readableStatus } from "@nautilus/copy";
import { isProjectReady, projectNotReadyReason } from "@/lib/project";
import { useWorkspace } from "@/store";
import { CenteredEmptyState } from "../common/CenteredEmptyState";

const NO_HISTORY: SyncEvent[] = [];

const DIRECTION_ICON = {
  pull: <ArrowDownToLine className="size-4 text-secondary" aria-hidden />,
  push: <ArrowUpFromLine className="size-4 text-secondary" aria-hidden />,
  system: <CircleDot className="size-4 text-secondary" aria-hidden />,
};

function eventTitle(event: SyncEvent): string {
  if (event.direction === "system") return "Runner checkpoint";
  return event.undone ? "Pull, undone on the PC" : readableStatus(event.direction);
}

export function HistoryPanel({ project }: { project: ProjectRecord }) {
  const history = useWorkspace((state) => state.project?.syncHistory ?? NO_HISTORY);

  if (history.length === 0) {
    const isUnset = !isProjectReady(project);
    return (
      <CenteredEmptyState
        icon={History}
        title={isUnset ? "Nothing synced yet" : "No sync history yet"}
        description={
          isUnset ? projectNotReadyReason(project) : "Pull and push events from the PC appear here."
        }
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl p-2 sm:p-4">
      <List hasDividers>
        {[...history].reverse().map((event) => (
          <ListItem
            key={event.requestId}
            label={eventTitle(event)}
            startContent={DIRECTION_ICON[event.direction]}
            description={
              <span className="flex flex-col gap-1">
                <Timestamp value={event.createdAt} format="date_time" />
                {event.errorCode ? <Text type="supporting">{event.errorCode}</Text> : null}
                {event.conflicts.map((conflict) => (
                  <Text key={conflict.path} type="code" size="xsm" wordBreak="break-all">
                    {conflict.path}: {conflict.reason}
                  </Text>
                ))}
              </span>
            }
            endContent={
              event.status === "ok" ? (
                <Text type="supporting">Done</Text>
              ) : (
                <Badge
                  variant={event.status === "conflict" ? "warning" : "error"}
                  label={readableStatus(event.status)}
                />
              )
            }
          />
        ))}
      </List>
    </div>
  );
}
