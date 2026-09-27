import type { ReactNode } from "react";
import type { ProjectRecord } from "@nautilus/types";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import { MessageSquarePlus, PackageOpen } from "lucide-react";
import { isProjectReady, projectNotReadyReason } from "@/lib/project";
import { useActions, useWorkspace } from "@/store";
import { CenteredEmptyState } from "../common/CenteredEmptyState";
import { SessionChat } from "./SessionChat";

type ChatPanelProps = {
  project: ProjectRecord;

  alerts: ReactNode;
};

export function ChatPanel({ project, alerts }: ChatPanelProps) {
  const isLoaded = useWorkspace((state) => state.project?.isLoaded ?? false);
  const session = useWorkspace((state) => state.session);
  const isCreating = useWorkspace((state) => state.pending.newSession);
  const { createSession } = useActions();

  if (!isProjectReady(project)) {
    return (
      <WithAlerts alerts={alerts}>
        <CenteredEmptyState
          icon={PackageOpen}
          title="No code on the runner yet"
          description={projectNotReadyReason(project)}
        />
      </WithAlerts>
    );
  }

  if (!session) {
    if (!isLoaded) {
      return (
        <WithAlerts alerts={alerts}>
          <div className="flex h-full items-center justify-center p-6">
            <Spinner size="lg" label="Loading sessions" />
          </div>
        </WithAlerts>
      );
    }
    return (
      <WithAlerts alerts={alerts}>
        <CenteredEmptyState
          icon={MessageSquarePlus}
          title="No sessions yet"
          description="Start a session to give the agent its first instruction."
          actions={
            <Button
              label="New session"
              variant="primary"
              isLoading={isCreating}
              clickAction={createSession}
            />
          }
        />
      </WithAlerts>
    );
  }

  return <SessionChat key={session.id} session={session} alerts={alerts} />;
}

function WithAlerts({ alerts, children }: { alerts: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">{children}</div>
      <div className="mx-auto w-full max-w-xl px-4 pb-4 empty:hidden">{alerts}</div>
    </div>
  );
}
