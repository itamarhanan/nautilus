import { Button } from "@astryxdesign/core/Button";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Divider } from "@astryxdesign/core/Divider";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { VStack } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { ArrowLeft, LogOut } from "lucide-react";
import { connection as connectionCopy, device, runner as runnerCopy } from "@nautilus/copy";
import { connectionView } from "@/lib/connection";
import { runnerView, type RunnerView } from "@/lib/runner-view";
import type { StreamState } from "@/lib/stream/session-stream";
import { useActions, useSelectedProject, useWorkspace } from "@/store";
import type { RecoverySummary } from "@nautilus/types";

const NARROW = "(width < 480px)";
const LABEL_WIDTH = 140;

type LabelLayout = { position: "top" } | { position: "start"; width: number };

function useLabelLayout(): LabelLayout {
  const isNarrow = useMediaQuery(NARROW);
  return isNarrow ? { position: "top" } : { position: "start", width: LABEL_WIDTH };
}

function Maybe({ value }: { value: string | null | undefined }) {
  return value ? (
    <Timestamp value={value} format="date_time" />
  ) : (
    <Text color="secondary">{device.notAvailable}</Text>
  );
}

export function InfoPanel() {
  const device_ = useWorkspace((state) => state.device);
  const projects = useWorkspace((state) => state.projects);
  const runner_ = useWorkspace((state) => state.runner);
  const connection = useWorkspace((state) => state.connection);
  const online = useWorkspace((state) => state.online);
  const { setInfoOpen, setSignOutConfirmOpen } = useActions();
  const project = useSelectedProject();
  const labelLayout = useLabelLayout();
  const view = runnerView(runner_.lifecycle, runner_.isReachable, projects, runner_.error);

  return (
    <Layout
      height="fill"
      contentWidth={640}
      header={
        <LayoutHeader hasDivider padding={4}>
          <div className="flex items-center gap-2">
            <IconButton
              label={project ? `Back to ${project.name}` : "Close info"}
              tooltip="Back"
              variant="ghost"
              icon={<ArrowLeft className="size-4" aria-hidden />}
              onClick={() => {
                setInfoOpen(false);
              }}
            />
            <Heading level={3} accessibilityLevel={1}>
              Info
            </Heading>
          </div>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={4}>
          <VStack gap={6}>
            <ConnectionSection connection={connection} online={online} />
            <Divider />
            <DeviceSection
              name={device_?.name ?? device.defaultName}
              createdAt={device_?.createdAt}
              labelLayout={labelLayout}
            />
            <Divider />
            <RunnerSection view={view} lifecycle={runner_.lifecycle} labelLayout={labelLayout} />
            <Divider />
            <SignOutSection
              onSignOut={() => {
                setSignOutConfirmOpen(true);
              }}
            />
          </VStack>
        </LayoutContent>
      }
    />
  );
}

function ConnectionSection({ connection, online }: { connection: StreamState; online: boolean }) {
  const view = connectionView(connection, online);
  return (
    <VStack gap={2}>
      <Heading level={4} accessibilityLevel={2}>
        Live connection
      </Heading>
      <div className="flex items-center gap-2">
        <StatusDot variant={view.tone} label={view.label} />
        <Text weight="semibold">{view.label}</Text>
      </div>
      <Text color="secondary">{view.detail}</Text>
      {connection.attempt > 0 ? (
        <Text type="supporting">{connectionCopy.attempt(connection.attempt)}</Text>
      ) : null}
    </VStack>
  );
}

function DeviceSection({
  name,
  createdAt,
  labelLayout,
}: {
  name: string;
  createdAt: string | null | undefined;
  labelLayout: LabelLayout;
}) {
  return (
    <MetadataList
      title={
        <Heading level={4} accessibilityLevel={2}>
          This device
        </Heading>
      }
      label={labelLayout}
    >
      <MetadataListItem label="Name">{name}</MetadataListItem>
      <MetadataListItem label="Linked">
        <Maybe value={createdAt} />
      </MetadataListItem>
    </MetadataList>
  );
}

function RunnerSection({
  view,
  lifecycle,
  labelLayout,
}: {
  view: RunnerView;
  lifecycle: RecoverySummary | null;
  labelLayout: LabelLayout;
}) {
  return (
    <MetadataList
      title={
        <Heading level={4} accessibilityLevel={2}>
          Runner
        </Heading>
      }
      label={labelLayout}
    >
      <MetadataListItem label="State">{view.stateLabel}</MetadataListItem>
      <MetadataListItem label="Since">
        <Maybe value={lifecycle?.updatedAt} />
      </MetadataListItem>
      {view.degraded.length > 0 ? (
        <MetadataListItem label={runnerCopy.needsAttention}>
          {view.degraded.join(", ")}
        </MetadataListItem>
      ) : null}
      {view.detail ? (
        <MetadataListItem label={runnerCopy.detail}>{view.detail}</MetadataListItem>
      ) : null}
    </MetadataList>
  );
}

function SignOutSection({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <VStack gap={0.5}>
        <Heading level={4} accessibilityLevel={2}>
          Sign out
        </Heading>
        <Text color="secondary">{runnerCopy.signOutDescription}</Text>
      </VStack>
      <Button
        label="Sign out"
        variant="destructive"
        icon={<LogOut className="size-4" aria-hidden />}
        onClick={onSignOut}
      />
    </div>
  );
}
