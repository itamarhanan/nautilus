import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./errors";
import { sendJson } from "./http/respond";
import type { Route } from "./routes/router";
import { verifyRelayToken } from "./runner-access";

// The runner cannot reach the PC, so while a sync is open the PC's agent
// long-polls the runner for the requests the runner wants to make, replays each
// against its own loopback port and posts the answer back. RelayHub.fetch looks
// like fetch to the sync client, so the sync protocol does not change.

type Outgoing = {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
};

const pollHoldMs = 25_000;
const connectedWindowMs = 30_000;

function encodeHeaders(headers: Record<string, string>): string {
  return Buffer.from(JSON.stringify(headers)).toString("base64url");
}

function decodeHeaders(value: string | string[] | undefined): Record<string, string> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function bodyBytes(body: RequestInit["body"]): Buffer {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new Error("relay_body_unsupported");
}

async function readRaw(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, "request_too_large", "Relay body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export class RelayHub {
  private readonly queue: Outgoing[] = [];
  private readonly waiting = new Set<(item: Outgoing | undefined) => void>();
  private readonly inFlight = new Map<string, Outgoing>();
  private lastPollAt = 0;

  constructor(
    private readonly runnerKey: string,
    private readonly maxBodyBytes: number,
    private readonly holdMs = pollHoldMs,
  ) {}

  connected(now = Date.now()): boolean {
    return this.waiting.size > 0 || now - this.lastPollAt < connectedWindowMs;
  }

  readonly fetch: typeof fetch = (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!this.connected()) return Promise.reject(new Error("relay_offline"));
    return new Promise<Response>((resolve, reject) => {
      const item: Outgoing = {
        id: randomUUID(),
        method: init.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        headers: headerRecord(init.headers),
        body: bodyBytes(init.body),
        resolve,
        reject,
      };
      const signal = init.signal;
      if (signal) {
        const abort = () => {
          this.drop(item.id);
          reject(new Error("relay_aborted"));
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
      }
      const waiter = this.waiting.values().next().value;
      if (waiter) {
        this.waiting.delete(waiter);
        waiter(item);
      } else {
        this.queue.push(item);
      }
    });
  };

  routes(): Route[] {
    return [
      {
        method: "GET",
        path: "/relay/next",
        access: "relay",
        handle: async ({ request, response }) => {
          verifyRelayToken(request, this.runnerKey);
          this.lastPollAt = Date.now();
          const item = this.queue.shift() ?? (await this.wait(response));
          this.lastPollAt = Date.now();
          if (!item || response.destroyed) {
            if (item) this.queue.unshift(item);
            sendJson(response, 204, null);
            return 204;
          }
          this.inFlight.set(item.id, item);
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "cache-control": "no-store",
            "x-relay-id": item.id,
            "x-relay-method": item.method,
            "x-relay-path": item.path,
            "x-relay-headers": encodeHeaders(item.headers),
          });
          response.end(item.body);
          return 200;
        },
      },
      {
        method: "POST",
        path: "/relay/responses/:id",
        access: "relay",
        handle: async ({ request, response, params }) => {
          verifyRelayToken(request, this.runnerKey);
          this.lastPollAt = Date.now();
          const item = this.inFlight.get(params.id ?? "");
          const body = await readRaw(request, this.maxBodyBytes + 1_000_000);
          if (!item) throw new HttpError(404, "relay_request_not_found", "Request is not waiting");
          this.inFlight.delete(item.id);
          const status = Number(request.headers["x-relay-status"]);
          item.resolve(
            new Response(status === 204 || status === 304 ? null : new Uint8Array(body), {
              status: Number.isInteger(status) && status >= 200 && status <= 599 ? status : 502,
              headers: decodeHeaders(request.headers["x-relay-headers"]),
            }),
          );
          sendJson(response, 204, null);
          return 204;
        },
      },
    ];
  }

  // The response, not the request: a request without a body reports close as
  // soon as it has been read, while the response closes with the connection.
  private wait(response: ServerResponse): Promise<Outgoing | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (item: Outgoing | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiting.delete(finish);
        response.off("close", closed);
        resolve(item);
      };
      const closed = () => {
        finish(undefined);
      };
      const timer = setTimeout(closed, this.holdMs);
      this.waiting.add(finish);
      response.once("close", closed);
    });
  }

  private drop(id: string): void {
    this.inFlight.delete(id);
    const index = this.queue.findIndex((item) => item.id === id);
    if (index >= 0) this.queue.splice(index, 1);
  }

  close(): void {
    for (const finish of [...this.waiting]) finish(undefined);
    for (const item of [...this.queue, ...this.inFlight.values()]) {
      item.reject(new Error("relay_closed"));
    }
    this.queue.length = 0;
    this.inFlight.clear();
  }
}
