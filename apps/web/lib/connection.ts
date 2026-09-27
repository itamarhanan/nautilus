import { connection, type Tone } from "@nautilus/copy";
import type { StreamState } from "./stream/session-stream";

type ConnectionPhase =
  | "offline"
  | "live"
  | "connecting"
  | "reconnecting"
  | "stopped"
  | "waiting"
  | "none";

export type ConnectionView = {
  label: string;
  tone: Tone;
  detail: string;
};

const TONES: Record<ConnectionPhase, Tone> = {
  offline: "error",
  live: "success",
  connecting: "warning",
  reconnecting: "warning",
  stopped: "neutral",
  waiting: "neutral",
  none: "neutral",
};

function phaseOf(state: StreamState, online: boolean): ConnectionPhase {
  if (!online || state.phase === "offline") return "offline";
  switch (state.phase) {
    case "connected":
      return "live";
    case "connecting":
      return "connecting";
    case "reconnecting":
      return "reconnecting";
    case "stopped":
      return state.error ? "stopped" : "waiting";
    case "idle":
      return "none";
  }
}

function detailOf(state: StreamState, phase: ConnectionPhase): string {
  if (phase === "offline") return connection.detail.offline;
  if (phase === "reconnecting") {
    if (!state.nextRetryAt) return connection.detail.reconnectingNow;
    const seconds = Math.max(1, Math.ceil((state.nextRetryAt - Date.now()) / 1000));
    return connection.nextAttemptIn(seconds);
  }
  if (phase === "connecting") return connection.detail.connecting;
  if (phase === "live") return connection.detail.connected;
  return state.error ?? connection.detail.noSession;
}

export function connectionView(state: StreamState, online: boolean): ConnectionView {
  const phase = phaseOf(state, online);
  return {
    label: connection.label[phase],
    tone: TONES[phase],
    detail: detailOf(state, phase),
  };
}

export function connectionLabel(state: StreamState, online: boolean): string {
  return connectionView(state, online).label;
}

export function connectionTone(state: StreamState, online: boolean): Tone {
  return connectionView(state, online).tone;
}

export function connectionDetail(state: StreamState, online: boolean): string {
  return connectionView(state, online).detail;
}
