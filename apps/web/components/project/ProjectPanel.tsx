import { useState } from "react";
import type { ProjectRecord } from "@nautilus/types";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { useWorkspace } from "@/store";
import { ChatAlerts } from "../chat/ChatAlerts";
import { ChatPanel } from "../chat/ChatPanel";
import { HistoryPanel } from "../history/HistoryPanel";
import { PreviewPanel } from "../preview/PreviewPanel";
import { ProjectHeader } from "./ProjectHeader";

export function ProjectPanel({ project }: { project: ProjectRecord }) {
  const view = useWorkspace((state) => state.view);
  const hasError = useWorkspace((state) => state.error !== null);

  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const projectError = project.lastError !== dismissedError ? project.lastError : null;

  return (
    <Layout
      height="fill"
      header={<ProjectHeader project={project} hasAlert={hasError || projectError !== null} />}
      content={
        <LayoutContent padding={0} isScrollable={view === "history"}>
          {view === "chat" ? (
            <ChatPanel
              project={project}
              alerts={
                <ChatAlerts
                  projectError={projectError}
                  onDismissProjectError={() => {
                    setDismissedError(projectError);
                  }}
                />
              }
            />
          ) : view === "preview" ? (
            <PreviewPanel project={project} />
          ) : (
            <HistoryPanel project={project} />
          )}
        </LayoutContent>
      }
    />
  );
}
