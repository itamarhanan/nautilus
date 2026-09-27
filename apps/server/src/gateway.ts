import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { Transform, type Duplex } from "node:stream";
import httpProxy from "http-proxy";
import type { ProjectId } from "@nautilus/types";
import type { Auth } from "./auth";
import type { Logger } from "./logger";
import type { PreviewTokens, RedeemedPreview } from "./preview-tokens";
import type { Registry } from "./registry";
import { sendError, sendJson } from "./http/respond";

export type GatewayOptions = {
  webTarget: string;
  apiTarget: string;
  registry: Registry;
  auth: Auth;
  previewTokens: PreviewTokens;
  logger: Logger;
  heartbeatMs?: number;
  secureCookies?: boolean;
};

export type NautilusGateway = {
  server: Server;
  previewServer: Server;
  listen: (port: number, host?: string) => Promise<void>;
  listenPreview: (port: number, host?: string) => Promise<void>;
  close: () => Promise<void>;
};

type PreviewScope = {
  projectId: ProjectId;

  cookiePath: string;
};

type Target = {
  target: string;
  url: string;
};

const redeemPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Nautilus preview</title>
  </head>
  <body>
    <form method="post" action="">
      <button type="submit">Open preview</button>
    </form>
    <script>document.forms[0].submit();</script>
  </body>
</html>
`;

function withoutPreviewToken(url: URL): string {
  url.searchParams.delete("token");
  return `${url.pathname}${url.search}`;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const item of header?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator > 0) {
      cookies.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
    }
  }
  return cookies;
}

function previewCookieName(projectId: ProjectId): string {
  return `nautilus_preview_${projectId.replaceAll("-", "_")}`;
}

function findPreviewProject(
  pathname: string,
  registry: Registry,
): { projectId: ProjectId; prefix: string } | undefined {
  for (const project of registry.listProjects()) {
    if (pathname === project.previewPath || pathname.startsWith(project.previewPath)) {
      return { projectId: project.id, prefix: project.previewPath };
    }
  }
  return undefined;
}

function isSameOrigin(request: IncomingMessage): boolean {
  try {
    if (!request.headers.origin || !request.headers.host) return false;
    const origin = new URL(request.headers.origin);
    const forwardedProto = request.headers["x-forwarded-proto"];
    const protocol =
      typeof forwardedProto === "string"
        ? (forwardedProto.split(",", 1)[0] ?? "").trim()
        : (request.socket as { encrypted?: boolean }).encrypted
          ? "https"
          : "http";
    return origin.protocol === `${protocol}:` && origin.host === request.headers.host;
  } catch {
    return false;
  }
}

function rejectUpgrade(socket: Duplex, statusCode: number, code: string, message: string): void {
  const body = JSON.stringify({ error: code, message });
  socket.write(
    `HTTP/1.1 ${String(statusCode)} ${statusCode === 401 ? "Unauthorized" : "Forbidden"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n` +
      body,
  );
  socket.destroy();
}

function checkTargetHealth(target: string, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL(path, target);
    const req = httpRequest(
      {
        headers: { connection: "close" },
        hostname: url.hostname,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        port: url.port,
        protocol: url.protocol,
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve((response.statusCode ?? 500) < 500);
        });
      },
    );
    req.once("error", () => {
      resolve(false);
    });
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export function createNautilusGateway(options: GatewayOptions): NautilusGateway {
  const proxy = httpProxy.createProxyServer();
  const responses = new WeakMap<IncomingMessage, ServerResponse>();
  const serverSockets = new Set<Duplex>();
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  const secureCookies = options.secureCookies ?? true;

  function authenticatePreview(request: IncomingMessage, projectId: ProjectId): boolean {
    try {
      options.auth.authenticate(request);
      return true;
    } catch {
      const projectCookie = previewCookieName(projectId);
      const sessionToken = parseCookies(request.headers.cookie).get(projectCookie);
      return sessionToken ? options.previewTokens.findSession(sessionToken) === projectId : false;
    }
  }

  function redeemPreviewToken(request: IncomingMessage): RedeemedPreview | undefined {
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token");
    return token ? options.previewTokens.redeem(token) : undefined;
  }

  function preparePreviewRequest(request: IncomingMessage, target: string): void {
    const sameOrigin = isSameOrigin(request);
    delete request.headers.authorization;
    delete request.headers.cookie;
    if (sameOrigin) request.headers.origin = target;
  }

  function proxyRequest(request: IncomingMessage, response: ServerResponse, target: Target): void {
    request.url = target.url;
    delete request.headers["x-forwarded-for"];
    request.headers["x-forwarded-for"] = request.socket.remoteAddress ?? "unknown";
    responses.set(request, response);
    proxy.web(
      request,
      response,
      {
        changeOrigin: true,
        selfHandleResponse: true,
        target: target.target,
      },
      (error: Error) => {
        options.logger.warn("gateway_proxy_failed", { error: error.message });
        if (!response.destroyed) {
          sendError(response, 502, "upstream_unavailable", "Upstream service is unavailable");
        }
      },
    );
  }

  function proxyWebSocket(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: Target,
  ): void {
    request.url = target.url;
    proxy.ws(
      request,
      socket,
      head,
      {
        changeOrigin: true,
        target: target.target,
      },
      (error: Error) => {
        options.logger.warn("gateway_websocket_failed", {
          error: error.message,
        });
        socket.destroy();
      },
    );
  }

  proxy.on("proxyRes", (proxyResponse, request) => {
    delete proxyResponse.headers["access-control-allow-origin"];
    delete proxyResponse.headers["access-control-allow-credentials"];
    const contentType = proxyResponse.headers["content-type"];
    const isSse =
      typeof contentType === "string" && contentType.toLowerCase().includes("text/event-stream");
    const output = isSse
      ? new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            callback(null, chunk);
          },
        })
      : undefined;
    let timer: NodeJS.Timeout | undefined;
    if (output) {
      timer = setInterval(() => {
        output.write(`: nautilus-heartbeat ${String(Date.now())}\n\n`);
      }, heartbeatMs);
      timer.unref();
      output.once("end", () => {
        if (timer) {
          clearInterval(timer);
        }
      });
      options.logger.debug("gateway_sse_heartbeat_enabled", {
        method: request.method,
        path: request.url?.split("?")[0],
      });
    }
    const response = responses.get(request);
    if (!response) {
      proxyResponse.resume();
      return;
    }
    const destination = output ?? response;
    response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
    output?.pipe(response);
    proxyResponse.once("end", () => {
      if (timer) {
        clearInterval(timer);
      }
    });
    proxyResponse.pipe(destination);
  });

  function servePreview(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    scope: PreviewScope,
  ): void {
    if (!authenticatePreview(request, scope.projectId)) {
      const token = url.searchParams.get("token");

      if (
        (request.method === "GET" || request.method === "HEAD") &&
        token &&
        options.previewTokens.verify(token) === scope.projectId
      ) {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
          "referrer-policy": "same-origin",
          "x-robots-tag": "noindex",
        });
        response.end(redeemPage);
        return;
      }
      const redeemed =
        request.method === "POST" && isSameOrigin(request)
          ? redeemPreviewToken(request)
          : undefined;
      if (!redeemed || redeemed.projectId !== scope.projectId) {
        sendError(response, 401, "preview_unauthorized", "Preview authentication is required");
        return;
      }
      const cleanUrl = withoutPreviewToken(url);
      const maxAge = Math.max(0, Math.floor((Date.parse(redeemed.expiresAt) - Date.now()) / 1000));
      response.writeHead(303, {
        "cache-control": "no-store",
        location: cleanUrl,
        "set-cookie": `${previewCookieName(scope.projectId)}=${redeemed.sessionToken}; Path=${scope.cookiePath}; HttpOnly; SameSite=Lax${secureCookies ? "; Secure" : ""}; Max-Age=${String(maxAge)}`,
      });
      response.end();
      return;
    }

    const target = options.registry.activeDevTarget(scope.projectId) ?? "http://127.0.0.1:0";
    preparePreviewRequest(request, target);
    proxyRequest(request, response, {
      target,
      url: `${url.pathname}${url.search}`,
    });
  }

  function servePreviewUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    projectId: ProjectId,
    target: string,
  ): void {
    let redeemedToken = false;
    if (!authenticatePreview(request, projectId)) {
      const redeemed = redeemPreviewToken(request);
      if (!redeemed || redeemed.projectId !== projectId) {
        rejectUpgrade(socket, 401, "preview_unauthorized", "Preview authentication is required");
        return;
      }
      redeemedToken = true;
    }
    preparePreviewRequest(request, target);

    proxyWebSocket(request, socket, head, {
      target,
      url: redeemedToken ? withoutPreviewToken(url) : `${url.pathname}${url.search}`,
    });
  }

  function trackSockets(target: Server): void {
    target.on("connection", (socket) => {
      serverSockets.add(socket);
      socket.once("close", () => serverSockets.delete(socket));
    });
  }

  const server = createServer((request, response) => {
    void handle(request, response);
  });
  trackSockets(server);

  const previewServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", service: "nautilus-preview" });
      return;
    }
    const projectId = options.registry.getActiveProjectId();
    if (!projectId || options.registry.activeDevTarget(projectId) === null) {
      sendError(response, 503, "preview_not_running", "No project is running");
      return;
    }

    servePreview(request, response, url, { projectId, cookiePath: "/" });
  });
  trackSockets(previewServer);
  previewServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const projectId = options.registry.getActiveProjectId();
    const target = projectId ? options.registry.activeDevTarget(projectId) : null;
    if (!projectId || target === null) {
      rejectUpgrade(socket, 403, "preview_not_running", "No project is running");
      return;
    }
    servePreviewUpgrade(request, socket, head, url, projectId, target);
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", service: "nautilus-gateway" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/health/ready") {
      const healthy = await Promise.all([
        checkTargetHealth(options.apiTarget, "/health/ready"),
        checkTargetHealth(options.webTarget, "/"),
      ]);
      if (healthy.every(Boolean)) {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ status: "ok", service: "nautilus-gateway" }));
      } else {
        sendError(response, 503, "not_ready", "Gateway dependencies are not ready");
      }
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "GET")) {
        if (!isSameOrigin(request) || request.headers["x-nautilus-request"] !== "1") {
          sendError(response, 403, "csrf_rejected", "Origin or request header validation failed");
          return;
        }
      }

      request.headers["x-forwarded-host"] = request.headers.host;
      proxyRequest(request, response, {
        target: options.apiTarget,
        url: `${url.pathname}${url.search}`,
      });
      return;
    }

    const preview = findPreviewProject(url.pathname, options.registry);
    if (preview) {
      servePreview(request, response, url, {
        projectId: preview.projectId,
        cookiePath: preview.prefix,
      });
      return;
    }

    proxyRequest(request, response, {
      target: options.webTarget,
      url: `${url.pathname}${url.search}`,
    });
  }

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const preview = findPreviewProject(url.pathname, options.registry);
    if (!preview) {
      rejectUpgrade(socket, 403, "preview_required", "WebSocket access is limited to previews");
      return;
    }
    const target = options.registry.activeDevTarget(preview.projectId);
    if (target === null) {
      rejectUpgrade(socket, 404, "project_not_found", "Project is not found");
      return;
    }
    servePreviewUpgrade(request, socket, head, url, preview.projectId, target);
  });

  proxy.on("error", (error: Error) => {
    options.logger.error("gateway_proxy_error", { error: error.message });
  });

  function listenOn(target: Server, port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      target.once("error", reject);
      target.listen(port, host, () => {
        target.off("error", reject);
        resolve();
      });
    });
  }

  function closeServer(target: Server): Promise<void> {
    if (!target.listening) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      target.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  return {
    server,
    previewServer,
    listen: (port, host = "127.0.0.1") => listenOn(server, port, host),
    listenPreview: (port, host = "127.0.0.1") => listenOn(previewServer, port, host),
    close: async () => {
      for (const socket of serverSockets) {
        socket.destroy();
      }
      await Promise.all([closeServer(server), closeServer(previewServer)]);
    },
  };
}
