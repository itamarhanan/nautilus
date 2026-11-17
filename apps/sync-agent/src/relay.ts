// While a sync is open the runner cannot reach this PC, so the agent reaches
// out instead. It long-polls the runner for the next request, replays it
// against its own loopback port, and posts the answer back. Only the sync
// endpoint can be reached this way, and each sync request still has to carry
// a grant this agent minted.

export type RelayTarget = { url: string; token: string };

type RelayFetch = typeof fetch;

const relayedPaths = new Set(["/v1/sync"]);
const retryDelaysMs = [1_000, 2_000, 5_000];

function encodeHeaders(headers: Headers): string {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key === "content-type" || key.startsWith("x-nautilus-")) record[key] = value;
  });
  return Buffer.from(JSON.stringify(record)).toString("base64url");
}

function decodeHeaders(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && /^(content-type|x-nautilus-[a-z-]+)$/.test(entry[0]),
      ),
    );
  } catch {
    return {};
  }
}

export function relayUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("invalid_relay_url");
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid_relay_url");
  }
  return url.origin;
}

export class RelayPoller {
  private generation = 0;
  private target: RelayTarget | undefined;
  private controller: AbortController | undefined;

  constructor(
    private localOrigin: string,
    private readonly send: RelayFetch = fetch,
  ) {}

  setLocalPort(port: number): void {
    this.localOrigin = `http://127.0.0.1:${String(port)}`;
  }

  get active(): boolean {
    return this.target !== undefined;
  }

  start(target: RelayTarget): void {
    this.stop();
    this.target = target;
    const generation = this.generation;
    void this.loop(generation);
  }

  stop(): void {
    this.generation += 1;
    this.target = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }

  private async loop(generation: number): Promise<void> {
    let failures = 0;
    while (generation === this.generation && this.target) {
      const target = this.target;
      try {
        await this.pollOnce(target, generation);
        failures = 0;
      } catch {
        if (generation !== this.generation) return;
        const delay = retryDelaysMs[Math.min(failures, retryDelaysMs.length - 1)] ?? 5_000;
        failures += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async pollOnce(target: RelayTarget, generation: number): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => {
      controller.abort();
    }, 40_000);
    let next: Response;
    try {
      next = await this.send(`${target.url}/relay/next`, {
        headers: { authorization: `Bearer ${target.token}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (generation !== this.generation) return;
    if (next.status === 204) return;
    if (next.status !== 200) throw new Error(`relay_poll_failed_${String(next.status)}`);
    const id = next.headers.get("x-relay-id") ?? "";
    const method = next.headers.get("x-relay-method") ?? "GET";
    const path = next.headers.get("x-relay-path") ?? "";
    const body = Buffer.from(await next.arrayBuffer());
    // Answered without waiting, so the next poll is already open while a slow
    // request, such as building a bundle, runs.
    void this.answer(target, id, method, path, next.headers.get("x-relay-headers"), body);
  }

  private async answer(
    target: RelayTarget,
    id: string,
    method: string,
    path: string,
    headers: string | null,
    body: Buffer,
  ): Promise<void> {
    let status: number;
    let responseHeaders = new Headers();
    let responseBody: Buffer = Buffer.alloc(0);
    const pathname = path.startsWith("/") ? new URL(path, "http://relay.invalid").pathname : "";
    if (!/^[0-9a-f-]{36}$/.test(id)) return;
    if (method !== "POST" || !relayedPaths.has(pathname)) {
      status = 404;
      responseHeaders = new Headers({ "content-type": "application/json" });
      responseBody = Buffer.from(JSON.stringify({ error: "not_found" }));
    } else {
      try {
        const local = await this.send(`${this.localOrigin}${pathname}`, {
          method,
          headers: decodeHeaders(headers),
          body: new Uint8Array(body),
        });
        status = local.status;
        responseHeaders = local.headers;
        responseBody = Buffer.from(await local.arrayBuffer());
      } catch {
        status = 502;
      }
    }
    await this.send(`${target.url}/relay/responses/${id}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${target.token}`,
        "content-type": "application/octet-stream",
        "x-relay-status": String(status),
        "x-relay-headers": encodeHeaders(responseHeaders),
      },
      body: new Uint8Array(responseBody),
    }).catch(() => undefined);
  }
}
