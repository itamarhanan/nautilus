import type { SessionEvent, SessionSnapshot } from "@nautilus/types";
import { ApiError, isUnauthorized, responseError } from "../api/client";
import { getSession, sessionEventsUrl } from "../api/endpoints";
import { parseFrames } from "./frames";

export type StreamState = {
  phase: "idle" | "connecting" | "connected" | "reconnecting" | "offline" | "stopped";
  attempt: number;
  nextRetryAt: number | null;
  error: string | null;
};

export const idleStream: StreamState = {
  phase: "idle",
  attempt: 0,
  nextRetryAt: null,
  error: null,
};

export type SessionStreamOptions = {
  sessionId: string;
  onSnapshot: (snapshot: SessionSnapshot) => void;
  onEvent: (event: SessionEvent) => void;
  onState: (state: StreamState) => void;
  onUnauthorized: () => void;

  fetch?: typeof fetch;
  loadSnapshot?: (sessionId: string, signal: AbortSignal) => Promise<SessionSnapshot>;
  isOnline?: () => boolean;
};

export type SessionStream = {
  wake: () => void;

  dropConnection: () => void;

  disconnect: () => void;
};

const STABLE_AFTER_MS = 10_000;

const OFFLINE_RECHECK_MS = 30_000;

export function reconnectDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 30_000);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function shouldRetry(error: unknown): boolean {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

function streamError(error: unknown): string {
  return error instanceof Error ? error.message : "Event stream disconnected";
}

export function connectSessionStream(options: SessionStreamOptions): SessionStream {
  const { sessionId } = options;
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  const loadSnapshot = options.loadSnapshot ?? getSession;
  const isOnline = options.isOnline ?? (() => navigator.onLine);

  const lifetime = new AbortController();

  const isStopped = () => lifetime.signal.aborted;
  let connection: AbortController | null = null;
  let attempt = 0;
  let lastSequence = 0;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  const sleepers = new Set<() => void>();

  let latestState: StreamState = idleStream;
  const setState = (state: StreamState) => {
    latestState = state;
    if (!isStopped()) options.onState(state);
  };

  const wake = () => {
    for (const resolve of sleepers) resolve();
    sleepers.clear();
  };

  const sleep = (milliseconds: number) =>
    new Promise<void>((resolve) => {
      if (isStopped()) {
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        sleepers.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      sleepers.add(finish);
    });

  const deliver = (data: string) => {
    let event: SessionEvent;
    try {
      event = JSON.parse(data) as SessionEvent;
    } catch {
      return;
    }

    if (event.type === "session.delta") {
      if (!isStopped()) options.onEvent(event);
      return;
    }
    if (!Number.isInteger(event.sequence) || event.sequence <= lastSequence) return;
    lastSequence = event.sequence;
    if (!isStopped()) options.onEvent(event);
  };

  const receive = async (response: Response) => {
    if (!response.ok || !response.body) throw await responseError(response, "Event stream failed");
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      attempt = 0;
    }, STABLE_AFTER_MS);
    setState({ phase: "connected", attempt, nextRetryAt: null, error: null });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = parseFrames(buffer + decoder.decode(value, { stream: true }), deliver);
    }
    parseFrames(buffer + decoder.decode(), deliver);
  };

  const run = async () => {
    while (!isStopped()) {
      if (!isOnline()) {
        setState({ phase: "offline", attempt, nextRetryAt: null, error: null });
        await sleep(OFFLINE_RECHECK_MS);
        continue;
      }
      setState({
        phase: attempt === 0 ? "connecting" : "reconnecting",
        attempt,
        nextRetryAt: null,

        error: latestState.error,
      });
      const attemptController = new AbortController();
      connection = attemptController;
      try {
        const snapshot = await loadSnapshot(sessionId, attemptController.signal);

        if (Number.isInteger(snapshot.session.lastSequence)) {
          lastSequence = Math.max(lastSequence, snapshot.session.lastSequence);
        }
        if (!isStopped()) options.onSnapshot(snapshot);
        const response = await request(sessionEventsUrl(sessionId, Math.max(0, lastSequence)), {
          cache: "no-store",
          credentials: "include",
          headers: { accept: "text/event-stream" },
          signal: attemptController.signal,
        });
        await receive(response);
        throw new Error("Event stream closed");
      } catch (error) {
        clearTimeout(stableTimer);
        if (isStopped()) return;
        if (isAbortError(error)) {
          setState({
            phase: "offline",
            attempt,
            nextRetryAt: null,
            error: null,
          });
          await sleep(OFFLINE_RECHECK_MS);
          continue;
        }
        if (isUnauthorized(error)) {
          setState({
            phase: "stopped",
            attempt,
            nextRetryAt: null,
            error: null,
          });
          options.onUnauthorized();
          return;
        }
        if (!shouldRetry(error)) {
          setState({
            phase: "stopped",
            attempt,
            nextRetryAt: null,
            error: streamError(error),
          });
          return;
        }
        attempt += 1;
        const delay = reconnectDelay(attempt);
        setState({
          phase: "reconnecting",
          attempt,
          nextRetryAt: Date.now() + delay,
          error: streamError(error),
        });
        await sleep(delay);
      } finally {
        if (connection === attemptController) connection = null;
      }
    }
  };

  void run();

  return {
    wake,
    dropConnection: () => {
      connection?.abort();
    },
    disconnect: () => {
      lifetime.abort();
      connection?.abort();
      clearTimeout(stableTimer);
      wake();
    },
  };
}
