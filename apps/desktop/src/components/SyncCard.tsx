import { useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  CheckCircle2,
  Laptop,
  Server,
  Undo2,
} from "lucide-react";
import { sync as syncText } from "@nautilus/copy";
import type { SyncDirection } from "@nautilus/types";
import { useApp } from "../context";
import {
  directionWords,
  sideSummary,
  syncAvailability,
  syncFacts,
  type SyncFacts,
} from "../lib/format";
import type { StateProject } from "../lib/state";

const DIRECTION_ICON = {
  push: <ArrowUpFromLine className="size-3.5" aria-hidden />,
  pull: <ArrowDownToLine className="size-3.5" aria-hidden />,
};

const DIRECTION_LABEL = {
  push: syncText.action.reviewPush,
  pull: syncText.action.reviewPull,
};

export function SyncCard({ project }: { project: StateProject }) {
  const status = useApp((state) => state.status[project.id]);
  const review = useApp((state) => state.review);
  const connected = useApp((state) => state.connection.phase === "connected");
  const agentRunning = useApp((state) => state.agent.phase === "running");
  const registered = useApp((state) => state.projects.some((entry) => entry.id === project.id));
  const startReview = useApp((state) => state.startReview);
  const undoPull = useApp((state) => state.undoPull);
  const undoing = useApp((state) => state.undoingPull === project.id);
  const [confirmUndo, setConfirmUndo] = useState(false);

  const facts = syncFacts(status);
  const busy = review !== null && review.projectId === project.id;
  const availability = syncAvailability({
    connected,
    agentRunning,
    registered,
    busy,
    known: facts.known,
    neverSynced: facts.neverSynced,
  });
  const checked = status?.checkedAt !== null && status?.checkedAt !== undefined;
  const local = status?.local ?? null;
  const runner = status?.runner ?? null;

  return (
    <Card padding={5}>
      <div className="@container">
        <div className="grid grid-cols-1 gap-4 @xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] @xl:gap-6">
          <Side
            icon={<Laptop className="size-4" aria-hidden />}
            title="This PC"
            detail={
              <Text type="code" size="xsm" wordBreak="break-all" className="select-text">
                {project.localPath}
              </Text>
            }
            summary={sideSummary({ facts, side: "local", hasSide: local !== null, checked })}
            highlight={facts.local > 0}
            action={
              <SyncButton
                direction="push"
                primary={facts.neverSynced || facts.local > 0}
                isDisabled={!availability.canPush}
                tooltip={availability.reason}
                onClick={() => {
                  void startReview("push", project.id);
                }}
              />
            }
          />
          <SyncBridge facts={facts} lastSyncAt={runner?.lastSyncAt ?? null} />
          <Side
            icon={<Server className="size-4" aria-hidden />}
            title="Runner"
            detail={<RunnerCheckpoint at={runner?.lastCheckpointAt ?? null} />}
            summary={sideSummary({ facts, side: "runner", hasSide: runner !== null, checked })}
            highlight={facts.runner > 0}
            action={
              <SyncButton
                direction="pull"
                primary={!facts.neverSynced && facts.runner > 0}
                isDisabled={!availability.canPull}
                tooltip={availability.pullReason}
                onClick={() => {
                  void startReview("pull", project.id);
                }}
              />
            }
          />
        </div>

        {local?.undoablePull && !busy ? (
          <UndoPullRow
            pulledAt={local.undoablePull.pulledAt}
            isDisabled={!availability.canPush}
            isLoading={undoing}
            tooltip={availability.reason}
            isConfirming={confirmUndo}
            onConfirmChange={setConfirmUndo}
            onUndo={() => void undoPull(project.id)}
          />
        ) : null}

        {busy && review.background ? <SyncProgress direction={review.direction} /> : null}
      </div>
    </Card>
  );
}

function SyncButton({
  direction,
  primary,
  isDisabled,
  tooltip,
  onClick,
}: {
  direction: SyncDirection;
  primary: boolean;
  isDisabled: boolean;
  tooltip: string | undefined;
  onClick: () => void;
}) {
  return (
    <Button
      label={DIRECTION_LABEL[direction]}
      variant={primary ? "primary" : "secondary"}
      icon={DIRECTION_ICON[direction]}
      isDisabled={isDisabled}
      tooltip={tooltip}
      onClick={onClick}
    />
  );
}

function SyncBridge({ facts, lastSyncAt }: { facts: SyncFacts; lastSyncAt: string | null }) {
  return (
    <div className="flex items-center gap-2 text-secondary @xl:w-40 @xl:flex-col @xl:gap-1.5 @xl:pt-6 @xl:text-center">
      {facts.inSync ? (
        <CheckCircle2 className="size-6 shrink-0 text-success" aria-hidden />
      ) : (
        <ArrowLeftRight className="size-6 shrink-0 rotate-90 @xl:rotate-0" aria-hidden />
      )}
      {facts.inSync ? (
        <span className="text-xs leading-4">
          {syncText.state.inSync}
          {lastSyncAt ? (
            <>
              <span className="@xl:hidden"> · </span>
              <br className="hidden @xl:block" />
              <Timestamp value={lastSyncAt} format="relative" />
            </>
          ) : null}
        </span>
      ) : facts.neverSynced ? (
        <span className="text-xs leading-4">{syncText.state.pushOnceForCopy}</span>
      ) : null}
    </div>
  );
}

function RunnerCheckpoint({ at }: { at: string | null }) {
  return at ? (
    <Text type="supporting">
      Agent checkpoint <Timestamp value={at} format="relative" />
    </Text>
  ) : (
    <Text type="supporting">{syncText.state.noAgentCheckpoints}</Text>
  );
}

function UndoPullRow({
  pulledAt,
  isDisabled,
  isLoading,
  tooltip,
  isConfirming,
  onConfirmChange,
  onUndo,
}: {
  pulledAt: string;
  isDisabled: boolean;
  isLoading: boolean;
  tooltip: string | undefined;
  isConfirming: boolean;
  onConfirmChange: (isOpen: boolean) => void;
  onUndo: () => void;
}) {
  return (
    <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
      <Text type="supporting" className="grow">
        Pulled <Timestamp value={pulledAt} format="relative" />. {syncText.undo.unchanged}
      </Text>
      <Button
        label={syncText.undo.title}
        size="sm"
        variant="ghost"
        icon={<Undo2 className="size-3.5" aria-hidden />}
        isDisabled={isDisabled}
        isLoading={isLoading}
        tooltip={tooltip}
        onClick={() => {
          onConfirmChange(true);
        }}
      />
      <AlertDialog
        isOpen={isConfirming}
        onOpenChange={onConfirmChange}
        title={syncText.undo.confirmTitle}
        description={syncText.undo.description}
        actionLabel={syncText.undo.title}
        onAction={onUndo}
      />
    </div>
  );
}

function SyncProgress({ direction }: { direction: SyncDirection }) {
  return (
    <div className="mt-4">
      <ProgressBar label={`${directionWords(direction).progress}…`} isIndeterminate />
    </div>
  );
}

function Side({
  icon,
  title,
  detail,
  summary,
  highlight,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  detail: React.ReactNode;
  summary: string;
  highlight: boolean;
  action: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1.5 text-secondary">
        {icon}
        <Text type="supporting" weight="semibold">
          {title}
        </Text>
      </div>
      <Heading level={3} accessibilityLevel={3}>
        <span className={highlight ? "text-accent" : undefined}>{summary}</span>
      </Heading>
      {detail}
      <div className="mt-auto pt-4">{action}</div>
    </div>
  );
}
