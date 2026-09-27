import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadAgentConfig, type AgentConfig } from "./config";
import type { GrantAuthority } from "./grants";
import { SyncAgent } from "./operations";

export { SyncAgent } from "./operations";
export { GrantAuthority } from "./grants";

type AgentServer = {
  server: Server;
  agent: SyncAgent;
  grants: GrantAuthority;
  close: () => Promise<void>;
};

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function withDeadline<T extends { status: string }>(
  action: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  timer.unref();
  try {
    const result = await action(controller.signal);
    return controller.signal.aborted && result.status !== "ok" ? undefined : result;
  } finally {
    clearTimeout(timer);
  }
}

function sendSyncResponse(
  response: ServerResponse,
  result: Awaited<ReturnType<SyncAgent["handle"]>>,
): void {
  if (!result.bundle?.bytesBase64) {
    const statusCode =
      result.status === "invalid"
        ? 400
        : result.status === "offline"
          ? 503
          : result.status === "conflict" || result.status === "stale"
            ? 409
            : 200;
    sendJson(response, statusCode, result);
    return;
  }
  const metadata = {
    ...result,
    bundle: { head: result.bundle.head, sha256: result.bundle.sha256 },
  };
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "cache-control": "no-store",
    "x-nautilus-protocol": "1",
    "x-nautilus-response": Buffer.from(JSON.stringify(metadata)).toString("base64url"),
    "x-nautilus-digest": result.bundle.sha256,
    "x-nautilus-head": result.bundle.head,
  });
  response.end(Buffer.from(result.bundle.bytesBase64, "base64"));
}

export async function createSyncAgentServer(
  config: AgentConfig,
  grants: GrantAuthority,
  agent = new SyncAgent(config, grants.authenticate),
): Promise<AgentServer> {
  await agent.recover();
  const server = createServer((request, response) => {
    void handle(request, response, config, agent);
  });
  return {
    server,
    agent,
    grants,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolveClose();
          }
        });
      });
    },
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  config: AgentConfig,
  agent: SyncAgent,
): Promise<void> {
  try {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && pathname === "/health") {
      sendJson(response, 200, {
        version: 1,
        ok: true,
        service: "nautilus-sync-agent",
      });
      return;
    }
    if (request.method !== "POST" || pathname !== "/v1/sync") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const requestHeader = request.headers["x-nautilus-request"];
    const rawRequest = typeof requestHeader === "string";
    const body = await readBody(
      request,
      rawRequest ? config.maxBundleBytes : config.maxBundleBytes + 1_000_000,
    );
    if (body.length > config.maxBundleBytes) {
      sendJson(response, 413, { error: "request_too_large" });
      return;
    }
    let value: unknown;
    try {
      value = rawRequest
        ? JSON.parse(Buffer.from(requestHeader, "base64url").toString("utf8"))
        : JSON.parse(body.toString("utf8"));
    } catch {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    const result = await withDeadline(
      (signal) => agent.handle(value, rawRequest ? body : undefined, signal),
      config.requestTimeoutMs,
    );
    if (!result) {
      sendJson(response, 408, { error: "request_timeout" });
      return;
    }
    sendSyncResponse(response, result);
  } catch (error) {
    sendJson(response, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : "Internal error",
    });
  }
}

export async function startSyncAgent(
  grants: GrantAuthority,
  config: AgentConfig = loadAgentConfig(),
): Promise<AgentServer> {
  const instance = await createSyncAgentServer(config, grants);
  await new Promise<void>((resolveListen, reject) => {
    instance.server.once("error", reject);
    instance.server.listen(config.port, config.host, () => {
      resolveListen();
    });
  });
  return instance;
}
