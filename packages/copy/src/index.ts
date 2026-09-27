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

export function readableStatus(value: string): string {
  const normalized = value.replaceAll("-", " ").replaceAll("_", " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
