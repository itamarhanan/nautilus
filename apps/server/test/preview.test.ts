import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { expect, test } from "vitest";
import type { ProjectConfig } from "@nautilus/types";
import { derivePreviewOrigin } from "../src/config";
import { createNautilusGateway } from "../src/gateway";
import { createNautilusApp } from "../src/index";
import { decodeAddress, pickListener } from "../src/listeners";
import { Logger } from "../src/logger";
import { listen, pairDevice, request, testSecret } from "./helpers";

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "demo",
    name: "Demo",
    remotePath: "/tmp/demo",
    devCommand: "node server.js",
    devPort: 3230,
    previewPath: "/preview/demo/",
    ...overrides,
  };
}

async function bind(server: Server, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
}

async function ipv6LoopbackAvailable(): Promise<boolean> {
  const probe = createServer();
  try {
    await bind(probe, "::1");
    await close(probe);
    return true;
  } catch {
    return false;
  }
}

test("listener addresses decode from the kernel's socket tables", () => {
  expect(decodeAddress("0100007F")).toBe("127.0.0.1");
  expect(decodeAddress("00000000")).toBe("0.0.0.0");
  expect(decodeAddress("00000000000000000000000001000000")).toBe("::1");
  expect(decodeAddress("00000000000000000000000000000000")).toBe("::");
  expect(decodeAddress("0000000000000000FFFF00000100007F")).toBe("127.0.0.1");
});

test("the assigned port wins, and otherwise the shallowest process's port", () => {
  const listeners = [
    { host: "127.0.0.1", port: 40123, depth: 3 },
    { host: "127.0.0.1", port: 5173, depth: 2 },
  ];
  expect(pickListener(listeners, 3100)?.port).toBe(5173);
  expect(pickListener([...listeners, { host: "[::1]", port: 3100, depth: 4 }], 3100)).toEqual({
    host: "[::1]",
    port: 3100,
    depth: 4,
  });
  expect(pickListener([], 3100)).toBeUndefined();
});

test("the preview origin is derived from the host the phone used", () => {
  expect(derivePreviewOrigin("8080-01abc.cloudspaces.litng.ai", "https", 8081)).toBe(
    "https://8081-01abc.cloudspaces.litng.ai",
  );
  expect(derivePreviewOrigin("192.168.1.20:3000", undefined, 8081)).toBe(
    "http://192.168.1.20:8081",
  );
  expect(derivePreviewOrigin("nautilus.example.com", "https", 8081)).toBeUndefined();
  expect(derivePreviewOrigin(undefined, "https", 8081)).toBeUndefined();
});

test("a public preview token links to the preview listener; the control API's does not", async () => {
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [project()],
    logger: new Logger(() => undefined),
    previewPort: 8081,
  });
  const ports = await listen(app);

  try {
    const { cookie } = await pairDevice(ports);
    const issued = await request(ports, "POST", "/api/projects/demo/preview-token", {
      cookie,
      body: { ttlSeconds: 60 },
      headers: {
        "x-forwarded-host": "8080-01abc.cloudspaces.litng.ai",
        "x-forwarded-proto": "https",
      },
    });
    expect(issued.status).toBe(201);
    const body = issued.body as { token: string; previewUrl: string };
    expect(body.previewUrl).toBe(
      `https://8081-01abc.cloudspaces.litng.ai/?token=${encodeURIComponent(body.token)}`,
    );
    expect(app.previewTokens.issuedFor(body.token)).toBeUndefined();

    // The app page that asks for a token is the one allowed to post it.
    for (const [origin, expected] of [
      ["https://8080-01abc.cloudspaces.litng.ai", "https://8080-01abc.cloudspaces.litng.ai"],
      ["https://8080-01abc.cloudspaces.litng.ai/path", undefined],
      ["null", undefined],
    ] as const) {
      const bound = await request(ports, "POST", "/api/projects/demo/preview-token", {
        cookie,
        body: { ttlSeconds: 60 },
        headers: { origin, "x-forwarded-host": "8080-01abc.cloudspaces.litng.ai" },
      });
      expect(bound.status).toBe(201);
      expect(app.previewTokens.issuedFor((bound.body as { token: string }).token)).toBe(expected);
    }

    const control = await request(ports, "POST", "/api/projects/demo/preview-token", {
      control: true,
      body: { ttlSeconds: 60 },
    });
    expect(control.status).toBe(201);
    expect(control.body.previewUrl).toBeUndefined();
  } finally {
    await app.close();
  }
});

for (const host of ["127.0.0.1", "::1"]) {
  test(`a dev command that ignores PORT is previewed where it listens (${host})`, async ({
    skip,
  }) => {
    if (process.platform !== "linux") skip();
    if (host === "::1" && !(await ipv6LoopbackAvailable())) skip();
    const root = await mkdtemp(join(tmpdir(), "nautilus-anyport-"));

    await writeFile(
      join(root, "server.js"),
      `require("node:http").createServer((req, res) => res.end("served:" + req.headers.origin)).listen(0, ${JSON.stringify(host)});\n`,
    );
    const config = project({ remotePath: root });
    const app = await createNautilusApp({
      registryPath: ":memory:",
      authSecret: testSecret,
      projects: [config],
      logger: new Logger(() => undefined),
      devReadyTimeoutMs: 10_000,
    });
    const ports = await listen(app);
    const gateway = createNautilusGateway({
      apiTarget: "http://127.0.0.1:1",
      auth: app.auth,
      logger: new Logger(() => undefined),
      previewTokens: app.previewTokens,
      registry: app.registry,
      secureCookies: false,
      webTarget: "http://127.0.0.1:1",
    });
    const previewPort = await bind(gateway.previewServer);
    const previewUrl = `http://127.0.0.1:${String(previewPort)}`;

    try {
      const started = await request(ports, "POST", "/api/projects/demo/start", {
        control: true,
      });
      expect(started.status).toBe(200);
      const target = app.registry.activeDevTarget("demo") as string;
      expect(target).not.toBe(`http://127.0.0.1:${String(config.devPort)}`);
      expect(target.startsWith(host === "::1" ? "http://[::1]:" : "http://127.0.0.1:")).toBe(true);

      const { cookie } = await pairDevice(ports);

      const page = await fetch(`${previewUrl}/`, {
        method: "POST",
        headers: { cookie, origin: previewUrl },
      });
      expect(page.status).toBe(200);
      expect(await page.text()).toBe(`served:${target}`);

      await request(ports, "POST", "/api/projects/demo/stop", {
        control: true,
      });
      expect(app.registry.activeDevTarget("demo")).toBe(
        `http://127.0.0.1:${String(config.devPort)}`,
      );
    } finally {
      await gateway.close();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("HMR on the public gateway follows the line being served", async () => {
  const reached: string[] = [];
  const sockets: Duplex[] = [];
  function devServer(name: string): Server {
    const server = createServer();
    server.on("upgrade", (incoming, socket) => {
      reached.push(name);
      sockets.push(socket);
      const accept = createHash("sha1")
        .update(
          `${incoming.headers["sec-websocket-key"] ?? ""}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
        )
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    return server;
  }
  const first = devServer("first");
  const line = devServer("line");
  const config = project({ devPort: await bind(first) });
  const linePort = await bind(line);
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [config],
    logger: new Logger(() => undefined),
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
  const gatewayPort = await bind(gateway.server);
  app.registry.setActiveProjectId("demo");
  app.registry.setActiveDevTarget("demo", `http://127.0.0.1:${String(linePort)}`);
  let socket: WebSocket | undefined;

  try {
    const token = app.previewTokens.issue(config, 60);
    socket = new WebSocket(
      `ws://127.0.0.1:${String(gatewayPort)}/preview/demo/?token=${encodeURIComponent(token.token)}`,
    );
    await new Promise<void>((resolve, reject) => {
      socket?.addEventListener("open", () => {
        resolve();
      });
      socket?.addEventListener("error", () => {
        reject(new Error("HMR WebSocket failed"));
      });
    });
    expect(reached).toEqual(["line"]);
  } finally {
    socket?.close();
    sockets.forEach((entry) => entry.destroy());
    await gateway.close();
    await app.close();
    await close(first);
    await close(line);
  }
});
