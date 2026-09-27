import { project, readableStatus, type Tone } from "@nautilus/copy";
import type { ProjectRecord, ProjectState } from "@nautilus/types";

export function isProjectReady(record: Pick<ProjectRecord, "firstSyncAt">): boolean {
  return record.firstSyncAt !== null;
}

export function projectNotReadyReason(record: Pick<ProjectRecord, "name">): string {
  return project.notReady(record.name);
}

export function isProjectServing(state: ProjectState): boolean {
  return (
    state === "running" || state === "idle" || state === "editing" || state === "checkpointing"
  );
}

export type ProjectStatus = {
  isReady: boolean;

  isServing: boolean;
  isStarting: boolean;

  needsRecovery: boolean;

  isRunning: boolean;

  canToggle: boolean;
  tone: Tone;
  label: string;
};

export function projectStatus(record: Pick<ProjectRecord, "state" | "firstSyncAt">): ProjectStatus {
  const isReady = isProjectReady(record);
  const isStarting = record.state === "starting";
  const needsRecovery = record.state === "unhealthy";
  return {
    isReady,
    isServing: isReady && isProjectServing(record.state),
    isStarting,
    needsRecovery,
    isRunning: isProjectServing(record.state) || isStarting,
    canToggle: isReady && !needsRecovery,
    tone: project.tone[record.state],
    label: readableStatus(record.state),
  };
}

export function sessionTitle(startedAt: Date): string {
  const when = startedAt.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Session · ${when}`;
}
