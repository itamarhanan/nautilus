import type { ProjectRecord } from "@nautilus/types";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { LayoutHeader } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ExternalLink, History, MessagesSquare, MonitorPlay, Play, Square } from "lucide-react";
import { useOpenPreview } from "@/hooks/useOpenPreview";
import { VIEWS } from "@/lib/location";
import { projectStatus } from "@/lib/project";
import type { Tone } from "@nautilus/copy";
import { useActions, useWorkspace } from "@/store";

const BADGE_VARIANT = {
  success: "success",
  accent: "info",
  warning: "warning",
  error: "error",
  neutral: "neutral",
} as const satisfies Record<Tone, string>;

type ProjectHeaderProps = {
  project: ProjectRecord;

  hasAlert: boolean;
};

export function ProjectHeader({ project, hasAlert }: ProjectHeaderProps) {
  const view = useWorkspace((state) => state.view);
  const control = useWorkspace((state) => state.pending.projectControl);
  const { setView, changeProjectState } = useActions();
  const openPreview = useOpenPreview();
  const status = projectStatus(project);

  return (
    <LayoutHeader hasDivider padding={4} paddingBlockEnd={0}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3 sm:items-start">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0">
                <Heading level={3} accessibilityLevel={1} maxLines={1}>
                  {project.name}
                </Heading>
              </div>
              <span className="inline-flex shrink-0">
                <Badge variant={BADGE_VARIANT[status.tone]} label={status.label} />
              </span>
            </div>
            <span className="hidden sm:block">
              <Text type="supporting" maxLines={1}>
                {project.remotePath}
              </Text>
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {view === "preview" ? null : (
              <IconButton
                label="Open preview in a new tab"
                tooltip="Open preview"
                size="sm"
                variant="secondary"
                icon={<ExternalLink className="size-3.5" aria-hidden />}
                isDisabled={!status.isReady}
                clickAction={openPreview}
              />
            )}
            <Button
              label={status.isRunning ? "Stop" : "Start"}
              size="sm"
              variant="secondary"
              icon={
                status.isRunning ? (
                  <Square className="size-3.5" aria-hidden />
                ) : (
                  <Play className="size-3.5" aria-hidden />
                )
              }
              isLoading={control !== null}
              isDisabled={control !== null || !status.canToggle}
              onClick={() => void changeProjectState(status.isRunning ? "stop" : "start")}
            />
          </div>
        </div>
        <TabList
          value={view}
          onChange={(value) => {
            const next = VIEWS.find((candidate) => candidate === value);
            if (next) setView(next);
          }}
          layout="fill"
          isFullBleed
        >
          <Tab
            value="chat"
            label="Chat"
            icon={<MessagesSquare className="size-4" aria-hidden />}
            endContent={
              hasAlert && view !== "chat" ? (
                <StatusDot variant="error" label="Error in chat" />
              ) : undefined
            }
          />
          <Tab
            value="preview"
            label="Preview"
            icon={<MonitorPlay className="size-4" aria-hidden />}
          />
          <Tab
            value="history"
            label="Sync history"
            icon={<History className="size-4" aria-hidden />}
          />
        </TabList>
      </div>
    </LayoutHeader>
  );
}
