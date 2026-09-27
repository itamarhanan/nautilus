import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ProjectConfig, ProjectRecord } from "@nautilus/types";
import { parseProjectConfig, parseProjects } from "../src/config";
import { createNautilusApp } from "../src/index";
import { Logger } from "../src/logger";
import { loadOrCreateSecret } from "../src/secrets";
import { listen, pairDevice, request, testSecret } from "./helpers";

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "demo",
    name: "Demo",
    remotePath: "/tmp/demo",
    devCommand: "node server.js",
    devPort: 3210,
    previewPath: "/preview/demo/",
    ...overrides,
  };
}

test("project configuration validates ids, paths, and shell-free commands", () => {
  const parsed = parseProjectConfig({
    id: "demo",
    name: "Demo",
    remote_path: "~/projects/demo",
    dev_command: "pnpm dev",
    dev_port: 3100,
    preview_path: "/preview/demo/",
  });
  expect(parsed.remotePath).toMatch(/\/projects\/demo$/);
  expect(() => parseProjects([project({ id: "../demo" })])).toThrow(/Project id/);
  expect(() => parseProjects([project({ devCommand: "pnpm dev && rm -rf /" })])).toThrow(
    /shell operators/,
  );
});

test("health, pairing, runner-wide devices, and revocation", async () => {
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [project(), project({ id: "other", name: "Other", previewPath: "/preview/other/" })],
    logger: new Logger(() => undefined),
  });
  const ports = await listen(app);

  try {
    expect((await request(ports, "GET", "/health")).status).toBe(200);
    expect((await request(ports, "GET", "/health/ready")).status).toBe(200);
    expect((await request(ports, "GET", "/api/projects")).status).toBe(401);

    const pairing = await request(ports, "POST", "/api/pairing-codes", {
      control: true,
      body: { deviceName: "Test phone", ttlSeconds: 600 },
    });
    expect(pairing.status).toBe(201);
    expect(pairing.body).not.toHaveProperty("projectId");
    const pairingCode = pairing.body.code as string;

    const redeemed = await request(ports, "POST", "/api/pairing-codes/redeem", {
      body: { code: pairingCode, deviceName: "Test phone" },
    });
    expect(redeemed.status).toBe(201);
    expect(redeemed.body).not.toHaveProperty("token");
    expect(redeemed.setCookie).toContain("nautilus_session=");
    expect(redeemed.setCookie).toContain("HttpOnly");
    expect(redeemed.setCookie).toContain("Secure");
    expect(redeemed.setCookie).toContain("SameSite=Lax");
    if (!redeemed.setCookie) throw new Error("Pairing did not issue a session cookie");
    const deviceCookie = redeemed.setCookie.split(";", 1)[0] ?? "";
    const deviceId = (redeemed.body.device as { id: string }).id;

    expect(
      (
        await request(ports, "POST", "/api/pairing-codes/redeem", {
          body: { code: pairingCode, deviceName: "Replay phone" },
        })
      ).status,
    ).toBe(400);

    const bootstrap = await request(ports, "GET", "/api/bootstrap", {
      cookie: deviceCookie,
    });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.device).toMatchObject({ id: deviceId });

    expect(bootstrap.body.projects).toHaveLength(2);
    for (const id of ["demo", "other"]) {
      expect(
        (
          await request(ports, "GET", `/api/projects/${id}`, {
            cookie: deviceCookie,
          })
        ).status,
      ).toBe(200);
    }

    const previewToken = await request(ports, "POST", "/api/projects/other/preview-token", {
      cookie: deviceCookie,
      body: { ttlSeconds: 120 },
    });
    expect(previewToken.status).toBe(201);
    expect(previewToken.body.previewPath).toBe("/preview/other/");
    expect(typeof previewToken.body.token).toBe("string");

    const devices = await request(ports, "GET", "/api/devices", {
      control: true,
    });
    expect(devices.body.devices).toMatchObject([{ id: deviceId, name: "Test phone" }]);

    expect(
      (
        await request(ports, "POST", `/api/devices/${deviceId}/revoke`, {
          control: true,
        })
      ).status,
    ).toBe(200);
    expect((await request(ports, "GET", "/api/projects", { cookie: deviceCookie })).status).toBe(
      401,
    );
  } finally {
    await app.close();
  }
});

test("administrative routes exist only on the control listener", async () => {
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [project()],
    logger: new Logger(() => undefined),
  });
  const ports = await listen(app);
  try {
    const { cookie } = await pairDevice(ports);
    const adminRoutes: Array<[string, string, unknown?]> = [
      ["POST", "/api/projects", { projectId: "sneaky", name: "Sneaky" }],
      ["POST", "/api/pairing-codes", {}],
      ["GET", "/api/devices"],
      ["POST", "/api/devices/any/revoke"],
      ["PUT", "/api/projects/demo", { name: "Renamed" }],
      ["DELETE", "/api/projects/demo"],
      ["GET", "/api/projects/demo/sync-status"],
      ["POST", "/api/projects/demo/sync-requests", { direction: "pull" }],
      ["POST", "/api/projects/demo/sync-requests/preview", { direction: "pull" }],
      ["GET", "/api/tunnel-health"],
      ["GET", "/api/control/info"],
    ];
    for (const [method, path, body] of adminRoutes) {
      const response = await request(ports, method, path, { cookie, body });
      expect(response.status, `${method} ${path}`).toBe(404);
    }

    expect((await request(ports, "GET", "/api/pc-identities", { control: true })).status).toBe(404);

    const info = await request(ports, "GET", "/api/control/info", {
      control: true,
    });
    expect(info.status).toBe(200);
    expect(info.body.service).toBe("nautilus-server");
    expect(typeof info.body.version).toBe("string");
  } finally {
    await app.close();
  }
});

test("the control listener rejects requests a web page could send", async () => {
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [project()],
    logger: new Logger(() => undefined),
  });
  const ports = await listen(app);
  try {
    expect(
      (
        await request(ports, "GET", "/api/devices", {
          control: true,
          headers: { "x-nautilus-control": "0" },
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await request(ports, "GET", "/api/devices", {
          control: true,
          headers: { origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(403);

    const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: "127.0.0.1",
          port: ports.controlPort,
          path: "/api/devices",
          headers: {
            host: `attacker.example:${String(ports.controlPort)}`,
            "x-nautilus-control": "1",
          },
        },
        (incoming) => {
          incoming.resume();
          resolve(incoming.statusCode);
        },
      );
      outgoing.once("error", reject);
      outgoing.end();
    });
    expect(reboundStatus).toBe(403);

    expect(
      (
        await request(ports, "GET", "/api/devices", {
          control: true,
          headers: { origin: "tauri://localhost" },
        })
      ).status,
    ).toBe(200);
  } finally {
    await app.close();
  }
});

test("project registration assigns the remote path, preview path, and a free port", async () => {
  const projectsRoot = await mkdtemp(join(tmpdir(), "nautilus-projects-"));
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [project({ devPort: 3300 })],
    projectsRoot,
    devPortRange: [3300, 3302],
    logger: new Logger(() => undefined),
  });
  const ports = await listen(app);
  try {
    const first = await request(ports, "POST", "/api/projects", {
      control: true,
      body: { projectId: "shop", name: "Shop", devCommand: "npm run dev" },
    });
    expect(first.status).toBe(201);
    expect(first.body.project).toMatchObject({
      id: "shop",
      remotePath: join(projectsRoot, "shop"),
      previewPath: "/preview/shop/",
      devCommand: "npm run dev",
      devPort: 3301,
    });
    expect((await stat(join(projectsRoot, "shop"))).isDirectory()).toBe(true);

    const second = await request(ports, "POST", "/api/projects", {
      control: true,
      body: { projectId: "blog", name: "Blog" },
    });
    expect((second.body.project as ProjectRecord).devPort).toBe(3302);
    expect((second.body.project as ProjectRecord).devCommand).toBe("pnpm dev");

    const exhausted = await request(ports, "POST", "/api/projects", {
      control: true,
      body: { projectId: "docs", name: "Docs" },
    });
    expect(exhausted.status).toBe(409);
    expect(exhausted.body.error).toBe("dev_ports_exhausted");
  } finally {
    await app.close();
    await rm(projectsRoot, { recursive: true, force: true });
  }
});

test("a project's name and dev command can be edited, with registration's validation", async () => {
  const projectsRoot = await mkdtemp(join(tmpdir(), "nautilus-projects-"));
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [],
    projectsRoot,
    logger: new Logger(() => undefined),
  });
  const ports = await listen(app);
  try {
    await request(ports, "POST", "/api/projects", {
      control: true,
      body: { projectId: "shop", name: "Shop", devCommand: "npm run dev" },
    });

    const renamed = await request(ports, "PUT", "/api/projects/shop", {
      control: true,
      body: { name: "Storefront" },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.project).toMatchObject({
      name: "Storefront",
      devCommand: "npm run dev",
    });

    const edited = await request(ports, "PUT", "/api/projects/shop", {
      control: true,
      body: { devCommand: "pnpm dev --port 4000" },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.project).toMatchObject({
      name: "Storefront",
      devCommand: "pnpm dev --port 4000",
      remotePath: join(projectsRoot, "shop"),
    });

    const refused = await request(ports, "PUT", "/api/projects/shop", {
      control: true,
      body: { devCommand: "npm run dev && rm -rf /" },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("invalid_project");
    const listed = await request(ports, "GET", "/api/projects", {
      control: true,
    });
    expect(listed.body.projects).toMatchObject([
      { id: "shop", devCommand: "pnpm dev --port 4000" },
    ]);
  } finally {
    await app.close();
    await rm(projectsRoot, { recursive: true, force: true });
  }
});

test("the runner creates its auth secret once and keeps it private", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilus-secrets-"));
  try {
    const path = join(root, "secrets", "auth-secret");
    const first = await loadOrCreateSecret(path);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(await loadOrCreateSecret(path)).toBe(first);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readFile(path, "utf8")).trim()).toBe(first);

    const app = await createNautilusApp({
      registryPath: ":memory:",
      secretsPath: join(root, "secrets"),
      projects: [project()],
      logger: new Logger(() => undefined),
    });
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
