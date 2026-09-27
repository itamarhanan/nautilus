import { readableStatus, runner as text } from "@nautilus/copy";
import type { ProjectRecord, RecoverySummary } from "@nautilus/types";

export type RunnerView = {
  stateLabel: string;
  detail: string | null;
  degraded: readonly string[];
};

export function degradedProjectNames(
  ids: readonly string[],
  projects: readonly ProjectRecord[],
): string[] {
  return ids.map((id) => projects.find((entry) => entry.id === id)?.name ?? id);
}

export function runnerView(
  lifecycle: RecoverySummary | null,
  isReachable: boolean,
  projects: readonly ProjectRecord[],
  error: string | null,
): RunnerView {
  return {
    stateLabel: isReachable && lifecycle ? readableStatus(lifecycle.state) : text.offline,
    detail: error ?? lifecycle?.reason ?? null,
    degraded: degradedProjectNames(lifecycle?.degradedProjects ?? [], projects),
  };
}
