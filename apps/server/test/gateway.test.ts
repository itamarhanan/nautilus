import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { expect, test } from "vitest";
import type { ProjectConfig } from "@nautilus/types";
import { createNautilusGateway } from "../src/gateway";
import { createNautilusApp, type NautilusApp } from "../src/index";
import { Logger } from "../src/logger";

const authSecret = "a".repeat(32);

function deviceCookie(app: NautilusApp): string {
  const pairing = app.registry.createPairingCode(
    "Phone",
    new Date(Date.now() + 60_000).toISOString(),
  );
  const { device } = app.registry.redeemPairingCode(pairing.code, "Phone");
  let header = "";
  app.auth.issueSessionCookie(device.id, {
    setHeader: (_name: string, value: string) => {
      header = value;
    },
  } as unknown as ServerResponse);
  return header.split(";", 1)[0] ?? "";
}

type RunningServer = {
  server: Server;
  port: number;
};

async function listen(server: Server): Promise<RunningServer> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }
  return { server, port: address.port };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

test("gateway routes the PWA and API and secures one-time previews", async () => {
  let previewPath = "";
  let previewAuthorization: string | undefined;
  let previewCookie: string | undefined;
  const web = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    if (request.url === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: ready\n\n");
      setTimeout(() => response.end(), 80);
      return;
    }
    response.end("pwa");
  });
  const webRunning = await listen(web);

  const dev = createServer((request, response) => {
    previewPath = request.url ?? "";
    previewAuthorization = request.headers.authorization;
    previewCookie = request.headers.cookie;
    response.setHeader("access-control-allow-origin", "*");
    response.end("preview");
  });
  const devRunning = await listen(dev);
  const project: ProjectConfig = {
    id: "demo",
    name: "Demo",
    remotePath: "/tmp/demo",
    devCommand: "node server.js",
    devPort: devRunning.port,
    previewPath: "/preview/demo/",
  };
  const app = await createNautilusApp({
    authSecret,
    logger: new Logger(() => undefined),
    projects: [project],
    registryPath: ":memory:",
  });
  const apiRunning = await listen(app.server);
  const gateway = createNautilusGateway({
    apiTarget: `http://127.0.0.1:${String(apiRunning.port)}`,
    auth: app.auth,
    heartbeatMs: 20,
    logger: new Logger(() => undefined),
    previewTokens: app.previewTokens,
    registry: app.registry,
    secureCookies: false,
    webTarget: `http://127.0.0.1:${String(webRunning.port)}`,
  });
  const gatewayRunning = await listen(gateway.server);
  const baseUrl = `http://127.0.0.1:${String(gatewayRunning.port)}`;
  const session = deviceCookie(app);

  try {
    const health = await fetch(`${baseUrl}/health/ready`);
    expect(health.status).toBe(200);

    const pwa = await fetch(baseUrl);
    expect(pwa.status).toBe(200);
    expect(await pwa.text()).toBe("pwa");
    expect(pwa.headers.get("access-control-allow-origin")).toBeNull();

    const api = await fetch(`${baseUrl}/api/projects`);
    expect(api.status).toBe(401);

    const unauthenticatedPreview = await fetch(`${baseUrl}/preview/demo/`);
    expect(unauthenticatedPreview.status).toBe(401);

    const token = app.previewTokens.issue(project, 60);
    const tokenUrl = `${baseUrl}/preview/demo/assets/app.js?token=${encodeURIComponent(token.token)}`;
    for (let crawl = 0; crawl < 2; crawl += 1) {
      const redeemPage = await fetch(tokenUrl, { redirect: "manual" });
      expect(redeemPage.status).toBe(200);
      expect(redeemPage.headers.get("set-cookie")).toBeNull();
      expect(await redeemPage.text()).toContain('<form method="post" action="">');
    }
    const crossSite = await fetch(tokenUrl, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      redirect: "manual",
    });
    expect(crossSite.status).toBe(401);
    const redemption = await fetch(tokenUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      redirect: "manual",
    });
    expect(redemption.status).toBe(303);
    expect(redemption.headers.get("location")).toBe("/preview/demo/assets/app.js");
    const cookie = redemption.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeDefined();
    expect(redemption.headers.get("set-cookie")).toContain("HttpOnly");
    expect(redemption.headers.get("set-cookie")).toContain("SameSite=Lax");
    const maxAge = Number(/Max-Age=(\d+)/.exec(redemption.headers.get("set-cookie") ?? "")?.[1]);
    expect(maxAge).toBeGreaterThan(3500);

    const replay = await fetch(tokenUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      redirect: "manual",
    });
    expect(replay.status).toBe(401);
    const forged = await fetch(`${baseUrl}/preview/demo/?token=abc.def`, {
      redirect: "manual",
    });
    expect(forged.status).toBe(401);

    const preview = await fetch(`${baseUrl}/preview/demo/assets/app.js?x=1`, {
      headers: {
        authorization: "Bearer should-be-stripped",
        cookie: cookie as string,
      },
    });
    expect(preview.status).toBe(200);
    expect(await preview.text()).toBe("preview");
    expect(previewPath).toBe("/preview/demo/assets/app.js?x=1");
    expect(previewAuthorization).toBeUndefined();
    expect(previewCookie).toBeUndefined();
    expect(preview.headers.get("access-control-allow-origin")).toBeNull();

    const stream = await fetch(`${baseUrl}/events`, {
      signal: AbortSignal.timeout(1000),
    });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(await stream.text()).toContain("nautilus-heartbeat");

    const crossOrigin = await fetch(`${baseUrl}/api/projects/demo/start`, {
      body: "{}",
      headers: {
        cookie: session,
        "content-type": "application/json",
        origin: "https://attacker.example",
        "x-nautilus-request": "1",
      },
      method: "POST",
    });
    expect(crossOrigin.status).toBe(403);

    const missingHeader = await fetch(`${baseUrl}/api/projects/demo/start`, {
      body: "{}",
      headers: {
        cookie: session,
        "content-type": "application/json",
        origin: baseUrl,
      },
      method: "POST",
    });
    expect(missingHeader.status).toBe(403);
  } finally {
    await gateway.close();
    await app.close();
    await close(devRunning.server);
    await close(webRunning.server);
  }
});

test("gateway forwards authenticated HMR WebSocket paths", async () => {
  let hmrPath = "";
  const hmrSockets: Duplex[] = [];
  const dev = createServer();
  dev.on("upgrade", (request, socket) => {
    hmrPath = request.url ?? "";
    hmrSockets.push(socket);
    const key = request.headers["sec-websocket-key"] ?? "";
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        "Sec-WebSocket-Protocol: vite-hmr\r\n\r\n",
    );
  });
  const devRunning = await listen(dev);
  const project: ProjectConfig = {
    id: "hmr",
    name: "HMR",
    remotePath: "/tmp/hmr",
    devCommand: "vite",
    devPort: devRunning.port,
    previewPath: "/preview/hmr/",
  };
  const app = await createNautilusApp({
    authSecret,
    logger: new Logger(() => undefined),
    projects: [project],
    registryPath: ":memory:",
  });
  const apiRunning = await listen(app.server);
  const webRunning = await listen(createServer((_, response) => response.end("pwa")));
  const gateway = createNautilusGateway({
    apiTarget: `http://127.0.0.1:${String(apiRunning.port)}`,
    auth: app.auth,
    logger: new Logger(() => undefined),
    previewTokens: app.previewTokens,
    registry: app.registry,
    secureCookies: false,
    webTarget: `http://127.0.0.1:${String(webRunning.port)}`,
  });
  const gatewayRunning = await listen(gateway.server);
  const token = app.previewTokens.issue(project, 60);
  let clientSocket: WebSocket | undefined;

  try {
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(gatewayRunning.port)}/preview/hmr/?token=${encodeURIComponent(token.token)}`,
      "vite-hmr",
    );
    clientSocket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("HMR WebSocket did not open"));
      }, 2000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("HMR WebSocket failed"));
      });
    });
    socket.close();
    expect(hmrPath).toBe("/preview/hmr/");

    const viteSocket = new WebSocket(
      `ws://127.0.0.1:${String(gatewayRunning.port)}/preview/hmr/?token=vite-ws-token`,
      {
        protocols: ["vite-hmr"],
        headers: { cookie: deviceCookie(app) },
      } as never,
    );
    clientSocket = viteSocket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("HMR WebSocket did not open"));
      }, 2000);
      viteSocket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      viteSocket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("HMR WebSocket failed"));
      });
    });
    viteSocket.close();
    expect(hmrPath).toBe("/preview/hmr/?token=vite-ws-token");
  } finally {
    clientSocket?.close();
    hmrSockets.forEach((socket) => socket.destroy());
    await gateway.close();
    await app.close();
    await close(devRunning.server);
    await close(webRunning.server);
  }
});

test("the preview listener serves the running project at the root of its own origin", async () => {
  let previewPath = "";
  let previewCookie: string | undefined;
  const dev = createServer((request, response) => {
    previewPath = request.url ?? "";
    previewCookie = request.headers.cookie;
    response.end("preview");
  });
  const devRunning = await listen(dev);
  const project: ProjectConfig = {
    id: "demo",
    name: "Demo",
    remotePath: "/tmp/demo",
    devCommand: "node server.js",
    devPort: devRunning.port,
    previewPath: "/preview/demo/",
  };
  const app = await createNautilusApp({
    authSecret,
    logger: new Logger(() => undefined),
    projects: [project],
    registryPath: ":memory:",
  });
  const gateway = createNautilusGateway({
    apiTarget: "http://127.0.0.1:1",
    auth: app.auth,
    logger: new Logger(() => undefined),
    previewTokens: app.previewTokens,
    registry: app.registry,
    secureCookies: false,
    webTarget: "http://127.0.0.1:1",
  });
  const previewRunning = await listen(gateway.previewServer);
  const previewUrl = `http://127.0.0.1:${String(previewRunning.port)}`;

  try {
    const idle = await fetch(`${previewUrl}/`);
    expect(idle.status).toBe(503);
    expect(((await idle.json()) as { error: string }).error).toBe("preview_not_running");

    app.registry.setActiveProjectId(project.id);
    const unauthenticated = await fetch(`${previewUrl}/`);
    expect(unauthenticated.status).toBe(401);

    const token = app.previewTokens.issue(project, 60);
    const tokenUrl = `${previewUrl}/?token=${encodeURIComponent(token.token)}`;
    const redeemPage = await fetch(tokenUrl, { redirect: "manual" });
    expect(await redeemPage.text()).toContain('<form method="post" action="">');
    const redemption = await fetch(tokenUrl, {
      method: "POST",
      headers: { origin: previewUrl },
      redirect: "manual",
    });
    expect(redemption.status).toBe(303);
    expect(redemption.headers.get("location")).toBe("/");
    expect(redemption.headers.get("set-cookie")).toContain("Path=/;");
    const cookie = redemption.headers.get("set-cookie")?.split(";", 1)[0] as string;

    const asset = await fetch(`${previewUrl}/_next/static/app.js`, {
      headers: { cookie },
    });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("preview");
    expect(previewPath).toBe("/_next/static/app.js");
    expect(previewCookie).toBeUndefined();

    const other: ProjectConfig = {
      ...project,
      id: "other",
      previewPath: "/preview/other/",
    };
    app.registry.upsertProject(other);
    app.registry.setActiveProjectId(other.id);
    expect((await fetch(`${previewUrl}/`, { headers: { cookie } })).status).toBe(401);
  } finally {
    await gateway.close();
    await app.close();
    await close(devRunning.server);
  }
});
