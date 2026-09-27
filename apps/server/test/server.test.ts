import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ProjectConfig, ProjectRecord } from "@nautilus/types";
import { parseProjectConfig, parseProjects } from "../src/config";
import { createNautilusApp } from "../src/index";
import { Logger } from "../src/logger";
import { Registry } from "../src/registry";
import { loadOrCreateSecret } from "../src/secrets";
import { ShadowGit } from "@nautilus/shadow-git";
import {
  SyncCoordinator as RunnerSyncCoordinator,
  SyncCoordinatorError,
  TunnelSyncClient,
  type SyncCoordinator,
} from "../src/sync";
import { listen, pairDevice, request, testSecret, type Ports } from "./helpers";

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

test("legacy registries drop project-scoped devices and PC identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilus-migrate-"));
  const registryPath = join(root, "registry.sqlite");
  try {
    const legacy = new DatabaseSync(registryPath);
    legacy.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, remote_path TEXT NOT NULL,
        dev_command TEXT NOT NULL, dev_port INTEGER NOT NULL, preview_path TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'inactive', last_error TEXT, started_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE pairing_codes (id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL UNIQUE, device_name TEXT NOT NULL, expires_at TEXT NOT NULL,
        used_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE devices (id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
        last_seen_at TEXT, revoked_at TEXT);
      CREATE TABLE pc_identities (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        public_key TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
      CREATE INDEX devices_project ON devices(project_id);
      INSERT INTO projects VALUES ('demo', 'Demo', '/tmp/demo', 'pnpm dev', 3100, '/preview/demo/',
        'inactive', NULL, NULL, '2026-01-01', '2026-01-01');
      INSERT INTO devices VALUES ('phone-1', 'demo', 'Old phone', 'hash', '2026-01-01', NULL, NULL);
      INSERT INTO pc_identities VALUES ('pc-1', 'demo', 'ssh-ed25519 AAAA', '2026-01-01', NULL);
    `);
    legacy.close();

    const registry = new Registry(registryPath);
    expect(registry.listDevices()).toEqual([
      {
        id: "phone-1",
        name: "Old phone",
        createdAt: "2026-01-01",
        lastSeenAt: null,
        revokedAt: null,
      },
    ]);
    const pairing = registry.createPairingCode(
      "New phone",
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(registry.redeemPairingCode(pairing.code, "New phone").device.name).toBe("New phone");
    registry.close();

    const check = new DatabaseSync(registryPath);
    const tables = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).not.toContain("pc_identities");
    const deviceColumns = check
      .prepare("PRAGMA table_info(devices)")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(deviceColumns).not.toContain("project_id");
    check.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project start waits for the dev server and stop terminates it", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilus-test-"));
  const serverScript = join(root, "server.js");
  await writeFile(
    serverScript,
    "require('http').createServer((_, response) => response.end('ok')).listen(3211)\n",
  );
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [
      project({
        remotePath: root,
        devCommand: `node ${serverScript}`,
        devPort: 3211,
      }),
    ],
    logger: new Logger(() => undefined),
    devReadyTimeoutMs: 2000,
  });
  const ports = await listen(app);

  try {
    const started = await request(ports, "POST", "/api/projects/demo/start", {
      control: true,
    });
    expect(started.status).toBe(200);
    expect((started.body.project as { state: string }).state).toBe("running");

    const stopped = await request(ports, "POST", "/api/projects/demo/stop", {
      control: true,
    });
    expect(stopped.status).toBe(200);
    expect((stopped.body.project as { state: string }).state).toBe("stopped");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function recoveryFixture(port: number) {
  const root = await mkdtemp(join(tmpdir(), "nautilus-recovery-"));
  const serverScript = join(root, "server.js");
  await writeFile(
    serverScript,
    `require('http').createServer((_, response) => response.end('ok')).listen(${String(port)})\n`,
  );
  const runtime = await mkdtemp(join(tmpdir(), "nautilus-recovery-state-"));
  const registryPath = join(runtime, "registry.sqlite");
  const shadowRoot = join(runtime, "shadow");
  const statePath = join(runtime, "sync-state");
  const shadow = new ShadowGit({
    gitDir: join(shadowRoot, "demo.git"),
    workTree: root,
  });
  const head = await shadow.snapshot("Validated recovery checkpoint");
  await mkdir(join(statePath, "demo"), { recursive: true });
  await writeFile(join(statePath, "demo", "base.json"), JSON.stringify(head));
  const configured = project({
    remotePath: root,
    devCommand: `node ${serverScript}`,
    devPort: port,
  });
  const registry = new Registry(registryPath);
  registry.upsertProject(configured);
  registry.updateProjectState(configured.id, "running", null);
  registry.setActiveProjectId(configured.id);
  registry.close();
  const boot = () =>
    createNautilusApp({
      registryPath,
      authSecret: testSecret,
      projects: [configured],
      logger: new Logger(() => undefined),
      devReadyTimeoutMs: 2000,
      sync: new RunnerSyncCoordinator({
        projects: [configured],
        shadowRoot,
        statePath,

        client: new TunnelSyncClient({
          endpoint: "http://127.0.0.1:9/v1/sync",
        }),
      }),
    });
  const cleanup = async () => {
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  };
  return { root, statePath, boot, cleanup };
}

test("startup validates the shadow and restores the active dev server", async () => {
  const fixture = await recoveryFixture(3215);
  const app = await fixture.boot();
  const ports = await listen(app);
  try {
    const health = await request(ports, "GET", "/health/ready");
    expect(health.status).toBe(200);
    expect((health.body.activeProject as ProjectRecord).state).toBe("running");
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("startup refuses to serve a worktree that no longer matches its checkpoint", async () => {
  const fixture = await recoveryFixture(3216);

  await writeFile(join(fixture.root, "rolled-back.txt"), "restored from an older disk\n");
  const app = await fixture.boot();
  try {
    const record = app.registry.getProject("demo");
    expect(record).toMatchObject({
      state: "unhealthy",
      lastError: "shadow_worktree_changed",
    });
    expect(app.lifecycle.snapshot().degradedProjects).toContain("demo");
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("startup refuses a project whose last checkpoint was cut off", async () => {
  const fixture = await recoveryFixture(3217);
  await writeFile(
    join(fixture.statePath, "demo", "checkpoint.pending.json"),
    JSON.stringify({
      sessionId: "s",
      previousHead: null,
      createdAt: new Date().toISOString(),
    }),
  );
  const app = await fixture.boot();
  try {
    expect(app.registry.getProject("demo")).toMatchObject({
      state: "unhealthy",
      lastError: "checkpoint_incomplete",
    });
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("starting a second project stops the previously active project", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilus-switch-"));
  const firstScript = join(root, "first.js");
  const secondScript = join(root, "second.js");
  await writeFile(
    firstScript,
    "require('http').createServer((_, response) => response.end('ok')).listen(3213)\n",
  );
  await writeFile(
    secondScript,
    "require('http').createServer((_, response) => response.end('ok')).listen(3214)\n",
  );
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [
      project({
        id: "first",
        remotePath: root,
        devCommand: `node ${firstScript}`,
        devPort: 3213,
      }),
      project({
        id: "second",
        remotePath: root,
        devCommand: `node ${secondScript}`,
        devPort: 3214,
      }),
    ],
    logger: new Logger(() => undefined),
    devReadyTimeoutMs: 2000,
  });
  const ports = await listen(app);

  try {
    expect(
      (
        await request(ports, "POST", "/api/projects/first/start", {
          control: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(ports, "POST", "/api/projects/second/start", {
          control: true,
        })
      ).status,
    ).toBe(200);
    const projects = (await request(ports, "GET", "/api/projects", { control: true })).body
      .projects as ProjectRecord[];
    expect(projects.find((entry) => entry.id === "first")?.state).toBe("stopped");
    expect(projects.find((entry) => entry.id === "second")?.state).toBe("running");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("project start fails safely when the remote path is not a directory", async () => {
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [project({ remotePath: "/path/that/does/not/exist" })],
    logger: new Logger(() => undefined),
    devReadyTimeoutMs: 100,
  });
  const ports = await listen(app);

  try {
    const response = await request(ports, "POST", "/api/projects/demo/start", {
      control: true,
    });
    expect(response.status).toBe(409);
    expect(
      (await request(ports, "GET", "/api/projects/demo", { control: true })).body.project,
    ).toBeDefined();
  } finally {
    await app.close();
  }
});

test("the dev command is told its port through PORT", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilus-port-"));
  await writeFile(
    join(root, "server.js"),
    "require('http').createServer((_, response) => response.end('ok')).listen(Number(process.env.PORT))\n",
  );
  const previousPort = process.env.PORT;
  process.env.PORT = "4000";
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [
      project({
        remotePath: root,
        devCommand: "node server.js",
        devPort: 3219,
      }),
    ],
    logger: new Logger(() => undefined),
    devReadyTimeoutMs: 2000,
  });
  const ports = await listen(app);

  try {
    const started = await request(ports, "POST", "/api/projects/demo/start", {
      control: true,
    });
    expect(started.status).toBe(200);
  } finally {
    if (previousPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = previousPort;
    }
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a configured preview origin turns a preview token into a full link", async () => {
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [project()],
    logger: new Logger(() => undefined),
    previewOrigin: "https://8081-studio.cloudspaces.litng.ai",
  });
  const ports = await listen(app);

  try {
    const issued = await request(ports, "POST", "/api/projects/demo/preview-token", {
      control: true,
      body: { ttlSeconds: 60 },
    });
    expect(issued.status).toBe(201);
    const body = issued.body as { token: string; previewUrl: string };
    expect(body.previewUrl).toBe(
      `https://8081-studio.cloudspaces.litng.ai/?token=${encodeURIComponent(body.token)}`,
    );
  } finally {
    await app.close();
  }
});

test("a dev command that dies on start has its output logged", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilus-crash-"));
  await writeFile(
    join(root, "crash.js"),
    "console.error('boom: missing module'); process.exit(1);\n",
  );
  const lines: string[] = [];
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [project({ remotePath: root, devCommand: "node crash.js", devPort: 3216 })],
    logger: new Logger((line) => lines.push(line)),
    devReadyTimeoutMs: 2000,
  });
  const ports = await listen(app);

  try {
    const response = await request(ports, "POST", "/api/projects/demo/start", {
      control: true,
    });
    expect(response.status).toBe(409);
    const output = lines.find((line) => line.includes("project_process_output"));
    expect(output).toContain("boom: missing module");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed dependency install reports pnpm's reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilus-install-fail-"));
  const bin = await mkdtemp(join(tmpdir(), "nautilus-bin-"));
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(
    join(bin, "pnpm"),
    "#!/bin/sh\necho ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [
      project({
        remotePath: root,
        devCommand: "node server.js",
        devPort: 3218,
      }),
    ],
    logger: new Logger(() => undefined),
    devReadyTimeoutMs: 2000,
  });
  const ports = await listen(app);

  try {
    const started = await request(ports, "POST", "/api/projects/demo/start", {
      control: true,
    });
    expect(started.status).toBe(409);
    const record = (await request(ports, "GET", "/api/projects/demo", { control: true })).body
      .project as ProjectRecord;
    expect(record.lastError).toBe("dependency_install_failed:ERR_PNPM_OUTDATED_LOCKFILE");
  } finally {
    process.env.PATH = previousPath;
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  }
});

test("a pnpm project is installed before its dev command runs when its lockfile changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilus-install-"));
  const bin = await mkdtemp(join(tmpdir(), "nautilus-bin-"));
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(
    join(root, "server.js"),
    "require('node:fs').statSync('node_modules');\n" +
      "require('http').createServer((_, response) => response.end('ok')).listen(3217)\n",
  );
  await writeFile(
    join(bin, "pnpm"),
    "#!/bin/sh\nmkdir -p node_modules/.pnpm\ncp pnpm-lock.yaml node_modules/.pnpm/lock.yaml\necho run >> installs\n",
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [
      project({
        remotePath: root,
        devCommand: "node server.js",
        devPort: 3217,
      }),
    ],
    logger: new Logger(() => undefined),
    devReadyTimeoutMs: 2000,
  });
  const ports = await listen(app);

  try {
    const started = await request(ports, "POST", "/api/projects/demo/start", {
      control: true,
    });
    expect(started.status).toBe(200);
    expect(existsSync(join(root, "node_modules"))).toBe(true);

    await request(ports, "POST", "/api/projects/demo/stop", { control: true });
    await request(ports, "POST", "/api/projects/demo/start", { control: true });
    expect(await readFile(join(root, "installs"), "utf8")).toBe("run\n");
    await request(ports, "POST", "/api/projects/demo/stop", { control: true });
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# changed\n");
    const restarted = await request(ports, "POST", "/api/projects/demo/start", {
      control: true,
    });
    expect(restarted.status).toBe(200);
    expect(await readFile(join(root, "installs"), "utf8")).toBe("run\nrun\n");
  } finally {
    process.env.PATH = previousPath;
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  }
});

test("control sync routes forward a matching grant and reject mismatched ones", async () => {
  const received: Array<{ direction: string; grant: string }> = [];
  const ok = (requestId: string) => ({ version: 1, requestId, status: "ok" });
  const fakeSync = {
    connect: () => undefined,
    recoverAll: () => Promise.resolve(),
    validateAll: () => Promise.resolve(new Map()),
    pendingCheckpoints: () => Promise.resolve([]),
    addProject: () => undefined,
    hasCode: () => Promise.resolve(true),
    preview: (_projectId: string, direction: string, grant: string) => {
      received.push({ direction, grant });
      return Promise.resolve(ok("preview-request"));
    },
    pull: (_projectId: string, grant: string) => {
      received.push({ direction: "pull", grant });
      return Promise.resolve(ok("pull-request"));
    },
    push: () => Promise.resolve(ok("push-request")),
  } as unknown as SyncCoordinator;
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [project()],
    sync: fakeSync,
    logger: new Logger(() => undefined),
  });
  const ports = await listen(app);
  const grantFor = (claims: Record<string, unknown>) =>
    `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const valid = grantFor({
    version: 1,
    grantId: "g1",
    projectId: "demo",
    direction: "pull",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  try {
    const missing = await request(ports, "POST", "/api/projects/demo/sync-requests", {
      control: true,
      body: { direction: "pull" },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("invalid_grant");

    for (const claims of [
      { projectId: "other", direction: "pull" },
      { projectId: "demo", direction: "push" },
      {
        projectId: "demo",
        direction: "pull",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    ]) {
      const mismatched = grantFor({
        version: 1,
        grantId: "g2",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...claims,
      });
      const response = await request(ports, "POST", "/api/projects/demo/sync-requests", {
        control: true,
        body: { direction: "pull", grant: mismatched },
      });
      expect(response.status, JSON.stringify(claims)).toBe(400);
    }
    expect(received).toEqual([]);

    for (const path of [
      "/api/projects/demo/sync-requests/preview",
      "/api/projects/demo/sync-requests",
    ]) {
      const response = await request(ports, "POST", path, {
        control: true,
        body: { direction: "pull", grant: valid },
      });
      expect(response.status, path).toBe(200);
    }
    expect(received).toEqual([
      { direction: "pull", grant: valid },
      { direction: "pull", grant: valid },
    ]);
  } finally {
    await app.close();
  }
});

test("sync read routes report an unconfigured project as a refusal, not an internal error", async () => {
  const refusing = (code: string) => () =>
    Promise.reject(new SyncCoordinatorError("invalid", code, "Project is not configured"));
  const fakeSync = {
    connect: () => undefined,
    recoverAll: () => Promise.resolve(),
    validateAll: () => Promise.resolve(new Map()),
    pendingCheckpoints: () => Promise.resolve([]),
    addProject: () => undefined,
    hasCode: () => Promise.resolve(true),
    status: refusing("project_not_configured"),
    history: refusing("project_not_configured"),
  } as unknown as SyncCoordinator;
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [project()],
    sync: fakeSync,
    logger: new Logger(() => undefined),
  });
  const ports = await listen(app);
  try {
    for (const path of ["/api/projects/demo/sync-status", "/api/projects/demo/sync-history"]) {
      const response = await request(ports, "GET", path, { control: true });
      expect(response.status, path).toBe(400);
      expect(response.body.error, path).toBe("project_not_configured");
    }
  } finally {
    await app.close();
  }
});

test("a project with no code is refused before the dev server is spawned", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilus-not-synced-"));
  const remotePath = join(root, "remote");
  const fakeSync = {
    connect: () => undefined,
    recoverAll: () => Promise.resolve(),
    validateAll: () => Promise.resolve(new Map()),
    pendingCheckpoints: () => Promise.resolve([]),
    addProject: () => undefined,

    hasCode: () => Promise.resolve(false),
  } as unknown as SyncCoordinator;
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [project({ remotePath })],
    sync: fakeSync,
    logger: new Logger(() => undefined),
  });
  const ports = await listen(app);
  try {
    const response = await request(ports, "POST", "/api/projects/demo/start", {
      control: true,
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("project_not_synced");

    const listed = await request(ports, "GET", "/api/projects", {
      control: true,
    });
    const [record] = listed.body.projects as ProjectRecord[];
    if (!record) throw new Error("the project was not listed");
    expect(record.state).toBe("inactive");
    expect(record.lastError).toBeNull();
    expect(record.firstSyncAt).toBeNull();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("first sync is recorded once and survives a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilus-first-sync-"));
  const registryPath = join(root, "registry.db");
  const remotePath = join(root, "remote");
  await mkdir(remotePath, { recursive: true });
  let syncs = 0;
  let onFirstSync: ((projectId: string) => void | Promise<void>) | undefined;
  const fakeSync = {
    connect: (hooks: { onFirstSync?: (projectId: string) => void | Promise<void> }) => {
      onFirstSync = hooks.onFirstSync;
    },
    recoverAll: () => Promise.resolve(),
    validateAll: () => Promise.resolve(new Map()),
    pendingCheckpoints: () => Promise.resolve([]),
    addProject: () => undefined,
    hasCode: () => Promise.resolve(true),
    push: async (projectId: string) => {
      syncs += 1;
      await onFirstSync?.(projectId);
      return { version: 1, requestId: `r${String(syncs)}`, status: "ok" };
    },
  } as unknown as SyncCoordinator;
  const build = () =>
    createNautilusApp({
      registryPath,
      authSecret: testSecret,
      projects: [project({ remotePath })],
      sync: fakeSync,
      logger: new Logger(() => undefined),
    });
  const firstSyncAtOf = async (ports: Ports) => {
    const listed = await request(ports, "GET", "/api/projects", {
      control: true,
    });
    return (listed.body.projects as ProjectRecord[]).at(0)?.firstSyncAt ?? null;
  };
  const grant = `${Buffer.from(
    JSON.stringify({
      version: 1,
      grantId: "g1",
      projectId: "demo",
      direction: "push",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  ).toString("base64url")}.signature`;

  let app = await build();
  try {
    const ports = await listen(app);
    expect(await firstSyncAtOf(ports)).toBeNull();

    const pushed = await request(ports, "POST", "/api/projects/demo/sync-requests", {
      control: true,
      body: { direction: "push", grant },
    });
    expect(pushed.status).toBe(200);
    const recorded = await firstSyncAtOf(ports);
    expect(recorded).not.toBeNull();
    await app.close();

    app = await build();
    const restarted = await listen(app);
    expect(await firstSyncAtOf(restarted)).toBe(recorded);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("adding a project the runner already knows still creates its directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilus-known-project-"));
  const remotePath = join(root, "projects", "demo");
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [project({ remotePath })],
    logger: new Logger(() => undefined),
  });
  const ports = await listen(app);
  try {
    expect(existsSync(remotePath)).toBe(false);
    const response = await request(ports, "POST", "/api/projects", {
      control: true,
      body: { projectId: "demo", name: "Demo" },
    });
    expect(response.status).toBe(201);
    expect((await stat(remotePath)).isDirectory()).toBe(true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
