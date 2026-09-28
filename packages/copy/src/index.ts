import type { ProjectState } from "@nautilus/types";

export type Tone = "success" | "warning" | "error" | "accent" | "neutral";

export type ProjectAttention = {
  label: string;
  variant: "info" | "warning" | "error";
};

export const connection = {
  label: {
    offline: "Offline",
    live: "Live",
    connected: "Connected",
    connecting: "Connecting",
    reconnecting: "Reconnecting",
    stopped: "Stream stopped",
    waiting: "Waiting",
    none: "No session",
    notSetUp: "Not set up",
    agentStopped: "Agent stopped",
  },
  detail: {
    offline: "Nautilus will reconnect when this device is online.",
    connecting: "Checking the durable event stream.",
    connected: "Durable events are up to date.",
    reconnectingNow: "Connection lost. Reconnecting now.",
    noSession: "Select a session to open its event stream.",
  },
  nextAttemptIn: (seconds: number) => `Connection lost. Next attempt in ${String(seconds)}s.`,
  attempt: (count: number) => `Reconnect attempt ${String(count)}`,
};

export const device = {
  defaultName: "Runner administrator",
  notAvailable: "Not available",
};

export const runner = {
  offline: "Offline",
  needsAttention: "Needs attention",
  detail: "Detail",
  signOutDescription: "Ends the secure browser session on this device.",
};

export const project: {
  tone: Record<ProjectState, Tone>;
  attention: Partial<Record<ProjectState, ProjectAttention>>;
  notReady: (name: string) => string;
} = {
  tone: {
    inactive: "neutral",
    starting: "accent",
    running: "success",
    editing: "accent",
    checkpointing: "accent",
    idle: "success",
    unhealthy: "warning",
    stopped: "neutral",
    error: "error",
  },

  attention: {
    starting: { label: "Starting", variant: "info" },
    unhealthy: { label: "Needs attention", variant: "warning" },
    error: { label: "Error", variant: "error" },
  },
  notReady: (name: string) =>
    `${name} has no code on the runner yet. Push it once from Nautilus on your PC, then start it.`,
};

export const activity = {
  waitingForApproval: "Waiting for your approval",
  sending: "Sending",
  thinking: "Thinking",
  working: "Working",
  editingFiles: "Editing files",
  subagentsWorking: (count: number) => `${String(count)} subagents working`,
  waitingOn: (target: string) => `Waiting on ${target}`,
  anonymousSubagent: "a subagent",
  runningTool: (name: string, target: string | undefined) =>
    target ? `Running ${name}: ${target}` : `Running ${name}`,
};

export const subagent = {
  title: "Subagent",
  starting: "Starting",
  failed: "Failed",
  done: "Done",
  stoppedEarly: "Stopped before it finished",
  toolCalls: (count: number) => (count === 1 ? "1 tool call" : `${String(count)} tool calls`),
  byAgent: (agentType: string) => `${agentType} subagent`,
  stoppedTitle: "Subagent stopped",
  stoppedDetail: "It stopped before it finished.",
  fromMainAgent: "From the main agent",
};

export const transcript = {
  retrying: "Retrying the last turn",
  turnInterrupted: "Turn interrupted",
  turnFailed: "The agent turn failed",
  changesCheckpointed: "Changes checkpointed",
  checkpoint: (commit: string) => `Checkpoint ${commit.slice(0, 7)}`,
  readyForInstruction: "Ready for an instruction",
  mainThread: "Main",
  defaultPermission: "tool",
};

export const agent = {
  phase: {
    stopped: "Stopped",
    starting: "Starting",
    running: "Running on this PC",
    error: "Failed to start",
  },
  exit: {
    portInUse: (port: number) =>
      `Port ${String(port)} is already in use. Stop any other Nautilus sync agent and try again.`,
    stopped: "The sync agent stopped",
    stoppedWithCode: (code: number) => `The sync agent stopped with code ${String(code)}.`,
    stoppedWithDetail: (detail: string) => `The sync agent stopped: ${detail}`,
  },
};

export const sync = {
  blocked: {
    notConnected: "Connect to the runner first",
    agentNotRunning: "The sync agent is not running",
    unknownProject: "The runner does not know this project",
    inProgress: "A sync is in progress",
    pushFirst: "Push first so both sides share a base",
    waitingForStatus: "Waiting for the sync status",
  },
  state: {
    unavailable: "Status unavailable",
    checking: "Checking…",
    notSynced: "Not synced yet",
    waitingFirstPush: "Waiting for a first push",
    noLocalChanges: "No local changes",
    noAgentChanges: "No agent changes",
    noAgentCheckpoints: "No agent checkpoints yet",
    inSync: "In sync",
    pushOnceForCopy: "Push once to give the agent a copy.",
  },
  action: {
    reviewPush: "Review & push",
    reviewPull: "Review & pull",
  },
  undo: {
    title: "Undo pull",
    confirmTitle: "Undo the last pull?",
    description:
      "This PC's files go back to how they were before the pull. The runner keeps its changes and offers them again on the next pull.",
    unchanged: "Nothing has changed on this PC since.",
  },
  side: {
    thisPc: "this PC",
    theRunner: "the runner",
  },
  progress: {
    pulling: "Pulling",
    pushing: "Pushing",
  },
  verb: {
    pull: "Pull",
    push: "Push",
  },
  doneVerb: {
    pull: "Pulled",
    push: "Pushed",
  },
  count: {
    localChanges: (count: number) => `${String(count)} local change${count === 1 ? "" : "s"}`,
    fromAgent: (count: number) => `${String(count)} file${count === 1 ? "" : "s"} from the agent`,
    conflicting: (count: number) => `${String(count)} conflicting file${count === 1 ? "" : "s"}`,
  },
};

export const review = {
  step: {
    authorizing: "Authorizing this sync on the PC",
    tunnel: "Opening the reverse SSH tunnel",
    reviewing: "Comparing both sides",
    applying: "Applying changes",
    closing: "Closing the tunnel",
  },
  subtitle: {
    pull: "Agent changes from the runner, merged into your files on this PC",
    push: "Your changes on this PC, merged into the runner's copy",
  },
  preparingNote: "Nothing changes on either side until you apply.",
  unknownError: "Unknown error",
  conflictsTitle: (count: number) =>
    `${String(count)} file${count === 1 ? "" : "s"} changed on both sides`,
  resolvingDescription:
    "Nothing was applied yet. Choose which version of each file to keep, then apply the rest of the changes with it. To combine both versions instead, cancel and edit the file on the PC first.",
  blockedConflictDescription:
    "Nothing was applied. Resolve these files on the PC (or ask the agent to), then review again.",
  blockedStaleDescription: "The other side changed since this review started. Review again.",
  alreadyMatch: "Nothing to move: both sides already match.",
  nothingToApply: "Nothing to apply",
  withTheseChoices: (verb: string) => `${verb} with these choices`,
  chooseFiles: (count: number) => `Choose ${String(count)} file${count === 1 ? "" : "s"}`,
  willChange: (count: number, side: string, summary: string) =>
    `${String(count)} file${count === 1 ? "" : "s"} will change on ${side}${summary}.`,
  firstSync: {
    push: (count: number) =>
      `First push to this runner. It sends the whole project (${String(count)} file${count === 1 ? "" : "s"}).`,
    pull: (count: number) =>
      `First pull from this runner. It brings the whole project (${String(count)} file${count === 1 ? "" : "s"}).`,
  },
  firstSyncNote:
    "This runner has no earlier sync of this project to compare with, so every file shows as added.",
  failed: (verb: string) => `${verb} failed`,
  blocked: (verb: string) => `${verb} blocked`,
  done: (verb: string, count: number, side: string) =>
    `${verb} ${String(count)} file${count === 1 ? "" : "s"} to ${side}.`,
  tryAgain: "Try again",
  reviewAgain: "Review again",
  close: "Close",
  cancel: "Cancel",
  continueInBackground: "Continue in background",
};

export const projects = {
  add: "Add project",
  needsAttention: (count: number) => `${String(count)} ${count === 1 ? "needs" : "need"} attention`,
  withChanges: (count: number) => `${String(count)} with changes to move`,
  notOnRunner: "Not on runner",
  registerAgain: "Register again",
  registerHint: "Register it again, then push to restore its files.",
  moreActions: (name: string) => `More actions for ${name}`,
  open: "Open",
  settings: "Project settings",
  copyPath: "Copy path",
  remove: "Remove…",
  pathCopied: "Path copied",
  openLabel: (name: string) => `Open ${name}`,
  continueIn: (name: string) => `Continue in ${name}`,
  toPush: "to push",
  toPull: "to pull",
};

export const permission: {
  label: Record<string, string>;
  unknown: (name: string) => string;
} = {
  label: {
    bash: "Run a command",
    edit: "Edit files",
    read: "Read files",
    write: "Write files",
    webfetch: "Fetch a web page",
    websearch: "Search the web",
    external_directory: "Work outside the project folder",
    task: "Start a subagent",
    doom_loop: "Keep repeating the same step",
  },
  unknown: (name: string) => `Use ${name}`,
};

export function readableStatus(value: string): string {
  const normalized = value.replaceAll("-", " ").replaceAll("_", " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
