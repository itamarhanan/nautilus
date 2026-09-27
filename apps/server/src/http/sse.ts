import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionEvent } from "@nautilus/types";
import { HttpError } from "../errors";
import type { SessionService } from "../sessions";

function sendSseEvent(response: ServerResponse, event: SessionEvent): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  response.write(
    `id: ${String(event.sequence)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

export async function streamSessionEvents(
  request: IncomingMessage,
  response: ServerResponse,
  sessions: SessionService,
  sessionId: string,
  afterSequence: number,
  action?: () => Promise<void>,
): Promise<void> {
  if (!sessions.getSession(sessionId)) {
    throw new HttpError(404, "session_not_found", "Session is not found");
  }
  let unsubscribe: () => void = () => {};
  let finish: () => void = () => {};
  let heartbeat: NodeJS.Timeout | undefined;
  let lastSent = afterSequence;
  let replaying = true;
  const pending: Array<{ event: SessionEvent; live: boolean }> = [];
  const send = (event: SessionEvent): void => {
    if (event.sequence <= lastSent) {
      return;
    }
    lastSent = event.sequence;
    sendSseEvent(response, event);
  };

  unsubscribe = sessions.subscribe(sessionId, (event) => {
    if (event.type === "session.delta") {
      if (!replaying) {
        sendSseEvent(response, event);
      }
      return;
    }
    if (!event.durable) {
      return;
    }
    if (replaying) {
      pending.push({ event, live: true });
      return;
    }
    send(event);
    if (action && (event.type === "session.completed" || event.type === "session.interrupted")) {
      finish();
    }
  });

  const snapshot = sessions.snapshot(sessionId, afterSequence);
  if (!snapshot) {
    unsubscribe();
    throw new HttpError(404, "session_not_found", "Session is not found");
  }
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",

    "cache-control": "no-cache, no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  response.socket?.setNoDelay(true);

  await new Promise<void>((resolve) => {
    let finished = false;
    const finishStream = () => {
      if (finished) {
        return;
      }
      finished = true;
      unsubscribe();
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      if (!response.writableEnded && !response.destroyed) {
        response.end();
      }
      resolve();
    };
    finish = finishStream;
    for (const event of snapshot.events) {
      if (event.durable) {
        send(event);
      }
    }
    replaying = false;
    for (const item of pending) {
      send(item.event);
      if (
        item.live &&
        action &&
        (item.event.type === "session.completed" || item.event.type === "session.interrupted")
      ) {
        finishStream();
      }
    }
    heartbeat = setInterval(() => {
      if (!response.writableEnded && !response.destroyed) {
        response.write(`: heartbeat ${String(Date.now())}\n\n`);
      }
    }, 25_000);
    heartbeat.unref();
    request.once("close", finishStream);
    if (action) {
      void action().catch(() => {
        finishStream();
      });
    }
  });
}
