import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ProjectRecord, SyncEvent } from "@nautilus/types";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  CheckCircle2,
  Copy,
  MoreHorizontal,
  Plus,
  Settings,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import { projects as projectsText, sync as syncText } from "@nautilus/copy";
import { ActivityList } from "../components/ActivityList";
import { useApp } from "../context";
import {
  byRecency,
  copyPath,
  isUnconfigured,
  latest,
  plural,
  projectAttention,
  projectsSubtitle,
  syncAvailability,
  syncFacts,
  type SyncFacts,
} from "../lib/format";
import type { StateProject } from "../lib/state";
import { RemoveProjectDialog } from "../overlays/RemoveProjectDialog";
import type { ProjectStatus } from "../store";
import { GetStarted } from "./GetStarted";

type CardModel = {
  project: StateProject;
  record: ProjectRecord | undefined;
  facts: SyncFacts;
  missing: boolean;
  lastActivity: string | null;
  rank: number;
};

type CardActions = {
  canPush: boolean;
  canPull: boolean;
  onOpen: () => void;
  onOpenSettings: () => void;
  onStartReview: (direction: "push" | "pull") => void;
  onCopyPath: () => void;
  onRemove: () => void;
  onReregister: () => void;
};

function cardModel(
  project: StateProject,
  record: ProjectRecord | undefined,
  status: ProjectStatus | undefined,
  events: SyncEvent[] | undefined,
  connected: boolean,
): CardModel {
  const facts = syncFacts(status);
  const missing = connected && (!record || isUnconfigured(status?.errorCode));
  const last = events?.at(-1);
  const lastActivity = latest(
    last ? (last.committedAt ?? last.createdAt) : null,
    status?.runner?.lastSyncAt,
    status?.runner?.lastCheckpointAt,
  );
  const attention = projectAttention(record);
  const rank =
    missing || attention?.variant === "error" || record?.lastError
      ? 0
      : facts.neverSynced || facts.local > 0 || facts.runner > 0
        ? 1
        : 2;
  return { project, record, facts, missing, lastActivity, rank };
}

function cardMenu(actions: CardActions) {
  return [
    {
      label: projectsText.open,
      icon: <SquareArrowOutUpRight className="size-4" aria-hidden />,
      onClick: actions.onOpen,
    },
    {
      label: projectsText.settings,
      icon: <Settings className="size-4" aria-hidden />,
      onClick: actions.onOpenSettings,
    },
    { type: "divider" as const },
    {
      label: syncText.action.reviewPush,
      icon: <ArrowUpFromLine className="size-4" aria-hidden />,
      isDisabled: !actions.canPush,
      onClick: () => {
        actions.onStartReview("push");
      },
    },
    {
      label: syncText.action.reviewPull,
      icon: <ArrowDownToLine className="size-4" aria-hidden />,
      isDisabled: !actions.canPull,
      onClick: () => {
        actions.onStartReview("pull");
      },
    },
    {
      label: projectsText.copyPath,
      icon: <Copy className="size-4" aria-hidden />,
      onClick: actions.onCopyPath,
    },
    { type: "divider" as const },
    {
      label: projectsText.remove,
      icon: <Trash2 className="size-4" aria-hidden />,
      variant: "destructive" as const,
      onClick: actions.onRemove,
    },
  ];
}

export function HomeView() {
  const projects = useApp((state) => state.appState.projects);
  const lastProjectId = useApp((state) => state.appState.lastProjectId);
  const records = useApp((state) => state.projects);
  const status = useApp((state) => state.status);
  const history = useApp((state) => state.history);
  const connected = useApp((state) => state.connection.phase === "connected");
  const selectProject = useApp((state) => state.selectProject);
  const setPaletteOpen = useApp((state) => state.setPaletteOpen);
  const [removing, setRemoving] = useState<StateProject | null>(null);

  const cards = useMemo(
    () =>
      projects
        .map((project) =>
          cardModel(
            project,
            records.find((record) => record.id === project.id),
            status[project.id],
            history[project.id],
            connected,
          ),
        )
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            byRecency(a.lastActivity, b.lastActivity) ||
            a.project.name.localeCompare(b.project.name),
        ),
    [projects, records, status, history, connected],
  );

  const activity = useMemo(
    () =>
      projects
        .flatMap((project) => history[project.id] ?? [])
        .sort(
          (a, b) =>
            Date.parse(a.committedAt ?? a.createdAt) - Date.parse(b.committedAt ?? b.createdAt),
        ),
    [projects, history],
  );
  const names = useMemo(
    () => Object.fromEntries(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  if (projects.length === 0) return <GetStarted />;

  const attention = cards.filter((card) => card.rank === 0).length;
  const moving = cards.filter((card) => card.rank === 1).length;
  const resume =
    projects.length > 1 ? projects.find((project) => project.id === lastProjectId) : undefined;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <HomeHeader
        count={projects.length}
        attention={attention}
        moving={moving}
        resumeName={resume?.name ?? null}
        connected={connected}
        onResume={() => {
          if (resume) selectProject(resume.id);
        }}
        onAdd={() => {
          setPaletteOpen(true);
        }}
      />

      <Grid columns={{ minWidth: 300 }} gap={4}>
        {cards.map((card) => (
          <ProjectCard
            key={card.project.id}
            card={card}
            onRemove={() => {
              setRemoving(card.project);
            }}
          />
        ))}
      </Grid>

      <section className="flex flex-col gap-2">
        <Heading level={4} accessibilityLevel={2}>
          Sync history
        </Heading>
        <ActivityList events={activity} projectNames={names} />
      </section>

      <RemoveProjectDialog
        project={removing}
        onClose={() => {
          setRemoving(null);
        }}
      />
    </div>
  );
}

function HomeHeader({
  count,
  attention,
  moving,
  resumeName,
  connected,
  onResume,
  onAdd,
}: {
  count: number;
  attention: number;
  moving: number;
  resumeName: string | null;
  connected: boolean;
  onResume: () => void;
  onAdd: () => void;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <Heading level={2} accessibilityLevel={1}>
          Projects
        </Heading>
        <Text type="supporting">{projectsSubtitle(count, attention, moving)}</Text>
      </div>
      <div className="flex items-center gap-2">
        {resumeName ? (
          <Button
            label={projectsText.continueIn(resumeName)}
            variant="ghost"
            size="sm"
            endContent={<ArrowRight className="size-3.5" aria-hidden />}
            onClick={onResume}
          />
        ) : null}
        <Button
          label={projectsText.add}
          variant="secondary"
          size="sm"
          icon={<Plus className="size-3.5" aria-hidden />}
          isDisabled={!connected}
          tooltip={connected ? undefined : syncText.blocked.notConnected}
          onClick={onAdd}
        />
      </div>
    </header>
  );
}

function ProjectCard({ card, onRemove }: { card: CardModel; onRemove: () => void }) {
  const { project, record, facts, missing, lastActivity } = card;
  const connected = useApp((state) => state.connection.phase === "connected");
  const agentRunning = useApp((state) => state.agent.phase === "running");
  const busy = useApp((state) => state.review?.projectId === project.id);
  const selectProject = useApp((state) => state.selectProject);
  const startReview = useApp((state) => state.startReview);
  const reregister = useApp((state) => state.reregisterProject);
  const notify = useApp((state) => state.notify);

  const availability = syncAvailability({
    connected,
    agentRunning,
    registered: record !== undefined && !missing,
    busy,
    known: facts.known,
    neverSynced: facts.neverSynced,
  });
  const suggested: "push" | "pull" | null =
    facts.neverSynced || facts.local > 0 ? "push" : facts.runner > 0 ? "pull" : null;
  const problem = record?.lastError?.split("\n")[0];

  const actions: CardActions = {
    canPush: availability.canPush,
    canPull: availability.canPull,
    onOpen: () => {
      selectProject(project.id);
    },
    onOpenSettings: () => {
      selectProject(project.id, "settings");
    },
    onStartReview: (direction) => void startReview(direction, project.id),
    onCopyPath: () => {
      copyPath(project.localPath, notify);
    },
    onRemove,
    onReregister: () => void reregister(project.id),
  };

  return (
    <ClickableCard
      label={projectsText.openLabel(project.name)}
      padding={4}
      onClick={actions.onOpen}
    >
      <div className="flex h-full flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-w-0 items-center gap-2">
              <Text weight="semibold" maxLines={1}>
                {project.name}
              </Text>
              <CardBadge record={record} missing={missing} />
            </div>
            <Text type="code" size="xsm" color="secondary" maxLines={1} className="mt-2">
              {project.localPath}
            </Text>
          </div>
          <DropdownMenu
            hasChevron={false}
            alignment="end"
            button={{
              label: projectsText.moreActions(project.name),
              isIconOnly: true,
              variant: "ghost",
              size: "sm",
              icon: <MoreHorizontal className="size-4" aria-hidden />,
            }}
            items={cardMenu(actions)}
          />
        </div>

        {problem ? (
          <Text type="supporting" color="secondary" maxLines={2} className="select-text">
            {problem}
          </Text>
        ) : null}

        {missing ? (
          <Text type="supporting">{projectsText.registerHint}</Text>
        ) : (
          <CardStatus facts={facts} />
        )}

        <div className="mt-auto flex min-h-8 items-center justify-between gap-2">
          <Text type="supporting">
            {lastActivity && !missing ? (
              <>
                Active <Timestamp value={lastActivity} format="relative" />
              </>
            ) : null}
          </Text>
          <CardFooter
            missing={missing}
            suggested={suggested}
            isDisabled={!connected}
            canPush={availability.canPush}
            canPull={availability.canPull}
            onReregister={actions.onReregister}
            onStartReview={actions.onStartReview}
          />
        </div>
      </div>
    </ClickableCard>
  );
}

function CardBadge({ record, missing }: { record: ProjectRecord | undefined; missing: boolean }) {
  const attention = projectAttention(record);
  if (missing) return <Badge variant="warning" label={projectsText.notOnRunner} />;
  if (!attention) return null;
  return <Badge variant={attention.variant} label={attention.label} />;
}

function CardStatus({ facts }: { facts: SyncFacts }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      {!facts.known ? (
        <Text type="supporting">{syncText.state.checking}</Text>
      ) : facts.neverSynced ? (
        <Text type="supporting">{syncText.state.notSynced}</Text>
      ) : facts.inSync ? (
        <span className="flex items-center gap-1 text-success">
          <CheckCircle2 className="size-4" aria-hidden />
          {syncText.state.inSync}
        </span>
      ) : (
        <>
          <Count
            icon={<ArrowUpFromLine className="size-4" aria-hidden />}
            count={facts.local}
            label={projectsText.toPush}
          />
          <Count
            icon={<ArrowDownToLine className="size-4" aria-hidden />}
            count={facts.runner}
            label={projectsText.toPull}
          />
        </>
      )}
    </div>
  );
}

function CardFooter({
  missing,
  suggested,
  isDisabled,
  canPush,
  canPull,
  onReregister,
  onStartReview,
}: {
  missing: boolean;
  suggested: "push" | "pull" | null;
  isDisabled: boolean;
  canPush: boolean;
  canPull: boolean;
  onReregister: () => void;
  onStartReview: (direction: "push" | "pull") => void;
}) {
  if (missing) {
    return (
      <Button
        label={projectsText.registerAgain}
        size="sm"
        variant="primary"
        isDisabled={isDisabled}
        onClick={onReregister}
      />
    );
  }
  if (!suggested) return null;
  return (
    <Button
      label={suggested === "push" ? syncText.action.reviewPush : syncText.action.reviewPull}
      size="sm"
      variant="primary"
      icon={
        suggested === "push" ? (
          <ArrowUpFromLine className="size-3.5" aria-hidden />
        ) : (
          <ArrowDownToLine className="size-3.5" aria-hidden />
        )
      }
      isDisabled={suggested === "push" ? !canPush : !canPull}
      onClick={() => {
        onStartReview(suggested);
      }}
    />
  );
}

function Count({ icon, count, label }: { icon: ReactNode; count: number; label: string }) {
  return (
    <span
      className={`flex items-center gap-1 ${count > 0 ? "text-accent" : "text-secondary"}`}
      title={`${plural(count, "file")} ${label}`}
    >
      {icon}
      {String(count)}
      <span className="sr-only">{`files ${label}`}</span>
    </span>
  );
}
