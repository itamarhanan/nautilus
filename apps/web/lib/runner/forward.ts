import { after, NextResponse } from "next/server";
import { type Authenticated, finish, principalHeader } from "../server/auth";
import { runnerKey } from "../server/config";
import { clientAddress, errorResponse } from "../server/http";
import { ensureRunner, forgetRunner } from "./sandbox";

// Event streams are closed a little before the function's own limit; the
// phone reconnects with ?after=<last sequence> and misses nothing.
const STREAM_LIMIT_MS = 270_000;

const WAKE_WAIT_MS = 60_000;

const requestHeaders = ["accept", "content-type", "last-event-id", "user-agent"];
const responseHeaders = ["content-type", "cache-control", "content-disposition", "etag"];

function limitStream(
  body: ReadableStream<Uint8Array>,
  limitMs: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        void reader.cancel().catch(() => undefined);
        controller.close();
      }, limitMs);
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          clearTimeout(timer);
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch {
        clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the time limit.
        }
      }
    },
    cancel() {
      clearTimeout(timer);
      return reader.cancel().catch(() => undefined);
    },
  });
}

export async function forward(
  request: Request,
  auth: Authenticated,
  pathname: string,
): Promise<Response> {
  const waking = ensureRunner();
  const base = await Promise.race([
    waking,
    new Promise<undefined>((resolve) => setTimeout(resolve, WAKE_WAIT_MS, undefined)),
  ]).catch(() => undefined);
  if (base === undefined) {
    // The runner keeps starting after this answer, and the caller retries.
    after(() => waking.catch(() => undefined));
    return errorResponse(503, "runner_starting", "The runner is starting. Try again shortly.");
  }
  const incoming = new URL(request.url);
  const headers = new Headers({
    "x-nautilus-runner-key": runnerKey(),
    "x-nautilus-principal": principalHeader(auth.principal),
    "x-forwarded-for": clientAddress(request),
  });
  for (const name of requestHeaders) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(`${base}${pathname}${incoming.search}`, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : null,
      signal: request.signal,
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    forgetRunner();
    return errorResponse(503, "runner_starting", "The runner is starting. Try again shortly.");
  }
  const outgoing = new Headers();
  for (const name of responseHeaders) {
    const value = upstream.headers.get(name);
    if (value !== null) outgoing.set(name, value);
  }
  const streaming = upstream.headers.get("content-type")?.startsWith("text/event-stream") ?? false;
  if (streaming) {
    outgoing.set("cache-control", "no-store, no-transform");
    outgoing.set("x-accel-buffering", "no");
  }
  const body =
    upstream.body && streaming ? limitStream(upstream.body, STREAM_LIMIT_MS) : upstream.body;
  return finish(
    new NextResponse(upstream.status === 204 || upstream.status === 304 ? null : body, {
      status: upstream.status,
      headers: outgoing,
    }),
    auth,
  );
}
