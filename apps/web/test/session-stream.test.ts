import { afterEach, describe, expect, test, vi } from "vitest";
import type { SessionEvent, SessionRecord, SessionSnapshot } from "@nautilus/types";
import { parseFrames } from "@/lib/stream/frames";
import { connectSessionStream, reconnectDelay } from "@/lib/stream/session-stream";
import type { SessionStream, StreamState } from "@/lib/stream/session-stream";

test("parses CRLF frames, multiple data lines, and partial frames", () => {
  const messages: string[] = [];
  const remainder = parseFrames(
    'id: 4\r\nevent: session.message\r\ndata: {"sequence":4,\r\ndata: "text":"hello"}\r\n\r\ndata: {"sequence":5}',
    (data) => messages.push(data),
  );
  expect(messages).toEqual(['{"sequence":4,\n"text":"hello"}']);
  expect(remainder).toBe('data: {"sequence":5}');
});

test("caps reconnect backoff at thirty seconds", () => {
  expect(reconnectDelay(0)).toBe(1_000);
  expect(reconnectDelay(1)).toBe(1_000);
  expect(reconnectDelay(5)).toBe(16_000);
  expect(reconnectDelay(20)).toBe(30_000);
});

function record(lastSequence: number): SessionRecord {
  return {
    id: "s1",
    projectId: "p1",
    openCodeSessionId: "oc",
    title: "Session",
    status: "idle",
    lastSequence,
    createdAt: "2026-09-26T10:00:00Z",
    updatedAt: "2026-09-26T10:00:00Z",
  };
}

function frame(sequence: number, type: SessionEvent["type"] = "session.message"): string {
  const event: SessionEvent = {
    sessionId: "s1",
    projectId: "p1",
    sequence,
    timestamp: "2026-09-26T10:00:00Z",
    type,
    durable: type !== "session.delta",
    payload: {},
  };
  return `data: ${JSON.stringify(event)}\n\n`;
}

function openStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return {
    response: new Response(body, { status: 200 }),
    write: (text: string) => {
      controller.enqueue(encoder.encode(text));
    },
    close: () => {
      controller.close();
    },
  };
}

function abortable(response: Response, signal: AbortSignal | null | undefined): Response {
  if (!signal || !response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener(
        "abort",
        () => {
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        },
        { once: true },
      );
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
  return new Response(body, { status: response.status });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

type Harness = {
  stream: SessionStream;
  events: number[];
  states: StreamState[];
  urls: string[];
  onUnauthorized: ReturnType<typeof vi.fn>;
  phase: () => StreamState["phase"] | undefined;
};

let active: SessionStream | null = null;

afterEach(() => {
  active?.disconnect();
  active = null;
});

function start(responses: (() => Response | Promise<Response>)[], snapshotSequence = 2): Harness {
  const events: number[] = [];
  const states: StreamState[] = [];
  const urls: string[] = [];
  const onUnauthorized = vi.fn();
  let call = 0;
  const stream = connectSessionStream({
    sessionId: "s1",
    isOnline: () => true,
    loadSnapshot: () =>
      Promise.resolve<SessionSnapshot>({
        session: record(snapshotSequence),
        events: [],
      }),
    fetch: async (input, init) => {
      urls.push(input as string);
      const next = responses.at(Math.min(call, responses.length - 1));
      call += 1;
      if (!next) throw new Error("no response configured");
      return abortable(await next(), init?.signal);
    },
    onSnapshot: () => undefined,
    onEvent: (event) => events.push(event.sequence),
    onState: (state) => states.push(state),
    onUnauthorized,
  });
  active = stream;
  return {
    stream,
    events,
    states,
    urls,
    onUnauthorized,
    phase: () => states.at(-1)?.phase,
  };
}

describe("connectSessionStream", () => {
  test("follows from the snapshot, drops stale and duplicate events, and skips a bad frame", async () => {
    const live = openStream();
    const harness = start([() => live.response]);
    await vi.waitFor(() => {
      expect(harness.phase()).toBe("connected");
    });
    expect(harness.urls).toEqual(["/api/sessions/s1/events?after=2"]);

    live.write(frame(2) + frame(3) + "data: {not json\n\n" + frame(3) + frame(4));
    await vi.waitFor(() => {
      expect(harness.events).toEqual([3, 4]);
    });

    expect(harness.phase()).toBe("connected");
  });

  test("passes deltas on even though they repeat the last stored sequence", async () => {
    const live = openStream();
    const harness = start([() => live.response]);
    await vi.waitFor(() => {
      expect(harness.phase()).toBe("connected");
    });
    live.write(frame(3) + frame(3, "session.delta") + frame(3, "session.delta") + frame(4));
    await vi.waitFor(() => {
      expect(harness.events).toEqual([3, 3, 3, 4]);
    });
  });

  test("reconnects after a server error and resumes from the last delivered event", async () => {
    const first = openStream();
    const second = openStream();
    const harness = start([
      () => first.response,
      () => jsonResponse(500, {}),
      () => second.response,
    ]);
    await vi.waitFor(() => {
      expect(harness.phase()).toBe("connected");
    });
    first.write(frame(3));
    await vi.waitFor(() => {
      expect(harness.events).toEqual([3]);
    });
    first.close();
    await vi.waitFor(() => {
      expect(harness.phase()).toBe("reconnecting");
    });

    harness.stream.wake();
    await vi.waitFor(() => {
      expect(harness.urls.length).toBe(2);
    });
    const failed = harness.states.at(-1);
    expect(failed?.attempt).toBe(2);
    expect(failed?.nextRetryAt).not.toBeNull();
    harness.stream.wake();
    await vi.waitFor(() => {
      expect(harness.phase()).toBe("connected");
    });

    expect(harness.urls.at(-1)).toBe("/api/sessions/s1/events?after=3");
    second.write(frame(3) + frame(4));
    await vi.waitFor(() => {
      expect(harness.events).toEqual([3, 4]);
    });
  });

  test("stops without retrying on a client error", async () => {
    const harness = start([() => jsonResponse(404, { error: "not_found", message: "No session" })]);
    await vi.waitFor(() => {
      expect(harness.phase()).toBe("stopped");
    });
    expect(harness.states.at(-1)?.error).toBe("No session");
    expect(harness.urls.length).toBe(1);
  });

  test("hands a 401 to the sign-out path", async () => {
    const harness = start([() => jsonResponse(401, { error: "unauthorized" })]);
    await vi.waitFor(() => {
      expect(harness.onUnauthorized).toHaveBeenCalledOnce();
    });
    expect(harness.phase()).toBe("stopped");
  });

  test("goes offline when the connection is dropped, and comes back on wake", async () => {
    const first = openStream();
    const second = openStream();
    const harness = start([() => first.response, () => second.response]);
    await vi.waitFor(() => {
      expect(harness.phase()).toBe("connected");
    });
    harness.stream.dropConnection();
    await vi.waitFor(() => {
      expect(harness.phase()).toBe("offline");
    });
    harness.stream.wake();
    await vi.waitFor(() => {
      expect(harness.urls.length).toBe(2);
      expect(harness.phase()).toBe("connected");
    });
  });

  test("reports nothing after disconnect", async () => {
    const live = openStream();
    const harness = start([() => live.response]);
    await vi.waitFor(() => {
      expect(harness.phase()).toBe("connected");
    });
    const seen = harness.states.length;
    harness.stream.disconnect();
    live.write(frame(9));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.events).toEqual([]);
    expect(harness.states.length).toBe(seen);
  });
});
