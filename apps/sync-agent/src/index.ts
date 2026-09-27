import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadAgentConfig, type AgentConfig } from "./config";
import type { GrantAuthority } from "./grants";
import { maxGrantLifetimeMs } from "./grants";
import { SyncAgent, SyncAgentError } from "./operations";

export { SyncAgent } from "./operations";
export { GrantAuthority } from "./grants";

type AgentServer = {
  server: Server;
  agent: SyncAgent;
  grants: GrantAuthority;
  close: () => Promise<void>;
};

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

const desktopOrigins = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  ...(process.env.NAUTILUS_AGENT_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
]);

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

function isDesktopRequest(request: IncomingMessage, grants: GrantAuthority): boolean {
  const host = request.headers.host ?? "";
  const hostname = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : (host.split(":")[0] ?? "");
  const origin = request.headers.origin;
  const authorization = request.headers.authorization ?? "";
  return (
    loopbackHosts.has(hostname) &&
    (origin === undefined || desktopOrigins.has(origin)) &&
    authorization.startsWith("Bearer ") &&
    grants.matchesLaunchKey(authorization.slice("Bearer ".length))
  );
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request, 16_384);
  if (body.length === 0) return {};
  const value: unknown = JSON.parse(body.toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  return value as Record<string, unknown>;
}

export async function createSyncAgentServer(
  config: AgentConfig,
  grants: GrantAuthority,
  agent = new SyncAgent(config, grants.authenticate),
): Promise<AgentServer> {
  await agent.recover();
  const server = createServer((request, response) => {
    void handle(request, response, config, agent, grants);
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

async function handleDesktop(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  agent: SyncAgent,
  grants: GrantAuthority,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "POST" && pathname === "/v1/grants") {
    const body = await readJsonObject(request);
    const direction = body.direction;
    if (
      typeof body.projectId !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(body.projectId) ||
      (direction !== "pull" && direction !== "push")
    ) {
      sendJson(response, 400, { error: "invalid_request" });
      return true;
    }
    const lifetimeMs =
      typeof body.ttlSeconds === "number" ? body.ttlSeconds * 1000 : maxGrantLifetimeMs;
    sendJson(response, 201, grants.mint(body.projectId, direction, lifetimeMs));
    return true;
  }
  if (request.method === "POST" && pathname === "/v1/grants/revoke") {
    const body = await readJsonObject(request);
    if (typeof body.grantId !== "string" || body.grantId.length > 128) {
      sendJson(response, 400, { error: "invalid_request" });
      return true;
    }
    grants.revoke(body.grantId);
    sendJson(response, 200, { revoked: true });
    return true;
  }
  try {
    if (request.method === "GET" && pathname === "/v1/status") {
      sendJson(response, 200, await agent.localStatus(url.searchParams.get("projectId") ?? ""));
      return true;
    }
    if (request.method === "GET" && pathname === "/v1/compare") {
      const file = await agent.compare(
        url.searchParams.get("projectId") ?? "",
        url.searchParams.get("remoteHead") ?? "",
        url.searchParams.get("path") ?? "",
      );
      sendJson(response, 200, file);
      return true;
    }
    if (request.method === "POST" && pathname === "/v1/pull/undo") {
      const body = await readJsonObject(request);
      if (typeof body.projectId !== "string" || typeof body.requestId !== "string") {
        sendJson(response, 400, { error: "invalid_request" });
        return true;
      }
      sendJson(response, 200, await agent.undoPull(body.projectId, body.requestId));
      return true;
    }
  } catch (error) {
    if (!(error instanceof SyncAgentError)) throw error;
    const status =
      error.code === "project_not_configured" ? 404 : error.status === "invalid" ? 400 : 409;
    sendJson(response, status, { error: error.code, message: error.message });
    return true;
  }
  return false;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  config: AgentConfig,
  agent: SyncAgent,
  grants: GrantAuthority,
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
    if (
      pathname === "/v1/grants" ||
      pathname === "/v1/grants/revoke" ||
      pathname === "/v1/status" ||
      pathname === "/v1/compare" ||
      pathname === "/v1/pull/undo"
    ) {
      if (!isDesktopRequest(request, grants)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (await handleDesktop(request, response, pathname, agent, grants)) return;
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
