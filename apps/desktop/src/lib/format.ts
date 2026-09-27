import {
  agent as agentText,
  connection as connectionText,
  project as projectText,
  projects as projectsText,
  sync as syncText,
  type ProjectAttention,
  type Tone,
} from "@nautilus/copy";
import type { ProjectRecord, SyncDirection } from "@nautilus/types";
import type { AgentPhase } from "./agent";
import type { ConnectionPhase } from "./control";

export function projectAttention(
  record: Pick<ProjectRecord, "state"> | null | undefined,
): ProjectAttention | undefined {
  return record ? projectText.attention[record.state] : undefined;
}

export function connectionTone(phase: ConnectionPhase, agent: AgentPhase): Tone {
  if (phase === "connected" && agent === "running") return "success";
  if (phase === "connecting" || phase === "reconnecting" || agent === "starting") return "accent";
  if (phase === "connected") return "warning";
  return phase === "idle" ? "neutral" : "error";
}

export function connectionLabel(phase: ConnectionPhase, agent: AgentPhase): string {
  if (phase === "connected") {
    return agent === "error" ? connectionText.label.agentStopped : connectionText.label.connected;
  }
  switch (phase) {
    case "connecting":
      return connectionText.label.connecting;
    case "reconnecting":
      return connectionText.label.reconnecting;
    case "offline":
      return connectionText.label.offline;
    case "idle":
      return connectionText.label.notSetUp;
  }
}

type StatusLike = {
  runner: { changedFiles: number } | null;
  local: { changedFiles: number } | null;
};

export function pendingChanges(status: StatusLike | undefined): number {
  return (status?.runner?.changedFiles ?? 0) + (status?.local?.changedFiles ?? 0);
}

export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

export function isUnconfigured(errorCode: string | null | undefined): boolean {
  return errorCode === "project_not_configured" || errorCode === "line_not_configured";
}

type SyncStatusLike = {
  runner: { changedFiles: number; neverSynced: boolean } | null;
  local: { changedFiles: number; neverSynced: boolean } | null;
};

export type SyncFacts = {
  known: boolean;
  neverSynced: boolean;
  local: number;
  runner: number;
  inSync: boolean;
};

export function syncFacts(status: SyncStatusLike | undefined): SyncFacts {
  const local = status?.local ?? null;
  const runner = status?.runner ?? null;
  const known = local !== null || runner !== null;
  const neverSynced = known && (local?.neverSynced ?? true) && (runner?.neverSynced ?? true);
  const localChanges = local?.changedFiles ?? 0;
  const runnerChanges = runner?.changedFiles ?? 0;
  return {
    known,
    neverSynced,
    local: localChanges,
    runner: runnerChanges,
    inSync:
      local !== null &&
      runner !== null &&
      !neverSynced &&
      localChanges === 0 &&
      runnerChanges === 0,
  };
}

const AGENT_PHASE_LABEL: Record<AgentPhase, string> = agentText.phase;

export function agentLabel(phase: AgentPhase): string {
  return AGENT_PHASE_LABEL[phase];
}

export type DirectionWords = {
  verb: string;
  done: string;
  side: string;
  progress: string;
};

export function directionWords(direction: SyncDirection): DirectionWords {
  const side = direction === "pull" ? syncText.side.thisPc : syncText.side.theRunner;
  return {
    verb: direction === "pull" ? syncText.verb.pull : syncText.verb.push,
    done: direction === "pull" ? syncText.doneVerb.pull : syncText.doneVerb.push,
    side,
    progress: direction === "pull" ? syncText.progress.pulling : syncText.progress.pushing,
  };
}

export type SyncAvailability = {
  canPush: boolean;
  canPull: boolean;
  reason: string | undefined;
  pullReason: string | undefined;
};

function firstReason(reasons: readonly (string | undefined)[]): string | undefined {
  return reasons.find((reason) => reason !== undefined);
}

export function syncAvailability(input: {
  connected: boolean;
  agentRunning: boolean;
  registered: boolean;
  busy: boolean;
  known: boolean;
  neverSynced: boolean;
}): SyncAvailability {
  const { connected, agentRunning, registered, busy, known, neverSynced } = input;
  const canPush = connected && agentRunning && registered && !busy;
  const reason = firstReason([
    connected ? undefined : syncText.blocked.notConnected,
    agentRunning ? undefined : syncText.blocked.agentNotRunning,
    registered ? undefined : syncText.blocked.unknownProject,
    busy ? syncText.blocked.inProgress : undefined,
  ]);
  return {
    canPush,
    canPull: canPush && known && !neverSynced,
    reason,
    pullReason:
      reason ??
      firstReason([
        neverSynced ? syncText.blocked.pushFirst : undefined,
        known ? undefined : syncText.blocked.waitingForStatus,
      ]),
  };
}

export function sideSummary(input: {
  facts: SyncFacts;
  side: "local" | "runner";
  hasSide: boolean;
  checked: boolean;
}): string {
  const { facts, side, hasSide, checked } = input;
  const unknown = checked ? syncText.state.unavailable : syncText.state.checking;
  if (!facts.known) return unknown;
  if (facts.neverSynced) {
    return side === "local" ? syncText.state.notSynced : syncText.state.waitingFirstPush;
  }
  if (!hasSide) return unknown;
  const count = side === "local" ? facts.local : facts.runner;
  if (side === "local") {
    return count === 0 ? syncText.state.noLocalChanges : syncText.count.localChanges(count);
  }
  return count === 0 ? syncText.state.noAgentChanges : syncText.count.fromAgent(count);
}

export function latest(...values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (value && (!best || Date.parse(value) > Date.parse(best))) best = value;
  }
  return best;
}

export function byRecency(a: string | null, b: string | null): number {
  return (Date.parse(b ?? "") || 0) - (Date.parse(a ?? "") || 0);
}

export function projectsSubtitle(count: number, attention: number, moving: number): string {
  return [
    plural(count, "project"),
    count > 1 && attention > 0 ? projectsText.needsAttention(attention) : undefined,
    count > 1 && moving > 0 ? projectsText.withChanges(moving) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function copyPath(
  path: string,
  notify: (notice: { tone: "info"; title: string; body: string }) => void,
): void {
  void navigator.clipboard.writeText(path).then(() => {
    notify({ tone: "info", title: projectsText.pathCopied, body: path });
  });
}

export function activeDevices<T extends { revokedAt: string | null }>(devices: readonly T[]): T[] {
  return devices.filter((device) => !device.revokedAt);
}
