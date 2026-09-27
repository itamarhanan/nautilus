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
