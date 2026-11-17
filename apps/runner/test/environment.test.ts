import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Event, Session } from "@opencode-ai/sdk";
import type { ModelRef, ProjectConfig } from "@nautilus/types";
import { EnvironmentStore } from "../src/environment";
import { createNautilusApp } from "../src/index";
import { Logger } from "../src/logger";
import type { OpenCodeEvent, OpenCodeService } from "../src/opencode";
import { Registry } from "../src/registry";
import { SessionService } from "../src/sessions";
import { listen, request, testSecret } from "./helpers";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "demo",
    name: "Demo",
    remotePath: "/tmp/demo",
    devCommand: "node server.js",
    devPort: 3231,
    previewPath: "/preview/demo/",
    ...overrides,
  };
}

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await Promise.resolve()
      .then(read)
      .catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting");
}

test("the store keeps values private, reports keys only, and skips unchanged sets", async () => {
  const directory = join(await temporary("nautilus-env-"), "projects");
  const store = new EnvironmentStore(directory);
  expect(await store.describe("demo")).toEqual({ keys: [], updatedAt: null });

  expect(await store.replace("demo", { B_KEY: "two", A_KEY: "secret-one" })).toBe(true);
  expect((await stat(join(directory, "demo.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  const described = await store.describe("demo");
  expect(described.keys).toEqual(["A_KEY", "B_KEY"]);
  expect(JSON.stringify(described)).not.toContain("secret-one");

  expect(await store.replace("demo", { A_KEY: "secret-one", B_KEY: "two" })).toBe(false);
  // A second store reads what the first wrote, as the runner does after a restart.
  expect(await new EnvironmentStore(directory).variables("demo")).toEqual({
    A_KEY: "secret-one",
    B_KEY: "two",
  });

  expect(await store.replace("demo", {})).toBe(true);
  expect(await store.describe("demo")).toEqual({ keys: [], updatedAt: null });
});

test("redaction hides values of four characters or more, longest first", async () => {
  const store = new EnvironmentStore(await temporary("nautilus-env-"));
  await store.replace("demo", {
    PORT: "300",
    TOKEN: "abcd",
    URL: "postgres://user:abcd@db",
  });
  const redact = await store.redactor("demo");
  expect(redact("PORT=300 TOKEN=abcd URL=postgres://user:abcd@db")).toBe(
    "PORT=300 TOKEN=[redacted:TOKEN] URL=[redacted:URL]",
  );
});

test("environment routes are admin-only and never return values", async () => {
  const secretsPath = await temporary("nautilus-secrets-");
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    secretsPath,
    projects: [project()],
    logger: new Logger(() => undefined),
  });
  const ports = await listen(app);
  try {
    expect((await request(ports, "GET", "/api/projects/demo/env")).status).not.toBe(200);
    expect(
      (await request(ports, "PUT", "/api/projects/demo/env", { body: { variables: {} } })).status,
    ).not.toBe(200);

    const saved = await request(ports, "PUT", "/api/projects/demo/env", {
      control: true,
      body: { variables: { DATABASE_URL: "postgres://preview-only" } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.keys).toEqual(["DATABASE_URL"]);
    expect(JSON.stringify(saved.body)).not.toContain("preview-only");

    const read = await request(ports, "GET", "/api/projects/demo/env", { control: true });
    expect(read.body.keys).toEqual(["DATABASE_URL"]);
    expect(JSON.stringify(read.body)).not.toContain("preview-only");

    for (const variables of [{ "BAD-KEY": "x" }, { GOOD: 1 }, ["x"], { NUL: "a\0b" }]) {
      const rejected = await request(ports, "PUT", "/api/projects/demo/env", {
        control: true,
        body: { variables },
      });
      expect(rejected.status).toBe(400);
    }
  } finally {
    await app.close();
  }
});

test("the dev server gets the project's values and none of the runner's own", async () => {
  const root = await temporary("nautilus-env-project-");
  const secretsPath = await temporary("nautilus-secrets-");
  const output = join(root, "seen.json");
  await writeFile(
    join(root, "server.js"),
    `require("fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify({
      api: process.env.API_URL ?? null,
      runner: process.env.NAUTILUS_TEST_RUNNER_SECRET ?? null,
      port: process.env.PORT,
    }));
    require("http").createServer((_, response) => response.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");\n`,
  );
  process.env.NAUTILUS_TEST_RUNNER_SECRET = "runner-only";
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    secretsPath,
    projects: [project({ remotePath: root, devPort: 3232 })],
    logger: new Logger(() => undefined),
    devReadyTimeoutMs: 5000,
  });
  const ports = await listen(app);
  try {
    await request(ports, "PUT", "/api/projects/demo/env", {
      control: true,
      body: { variables: { API_URL: "https://first.example", PORT: "1" } },
    });
    expect(
      (await request(ports, "POST", "/api/projects/demo/start", { control: true })).status,
    ).toBe(200);
    const first = JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>;
    expect(first).toEqual({ api: "https://first.example", runner: null, port: "3232" });

    // A change while the preview runs restarts it with the new values.
    await rm(output);
    await request(ports, "PUT", "/api/projects/demo/env", {
      control: true,
      body: { variables: { API_URL: "https://second.example" } },
    });
    const second = await until(async () => {
      const seen = JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>;
      return seen.api === "https://second.example" ? seen : undefined;
    });
    expect(second.runner).toBeNull();
    await until(() => (app.registry.getProject("demo")?.state === "running" ? true : undefined));
  } finally {
    delete process.env.NAUTILUS_TEST_RUNNER_SECRET;
    await app.close();
  }
});

class ScriptedOpenCode implements OpenCodeService {
  private readonly queue: OpenCodeEvent[] = [];
  private wake: (() => void) | undefined;
  readonly systems: (string | undefined)[] = [];

  start(): Promise<void> {
    return Promise.resolve();
  }

  createSession(directory: string, title: string): Promise<Session> {
    return Promise.resolve({
      id: "oc-1",
      projectID: "project-1",
      directory,
      title,
      version: "1.18.32",
      time: { created: Date.now(), updated: Date.now() },
    });
  }

  prompt(
    sessionId: string,
    _directory: string,
    _text: string,
    _model?: ModelRef,
    system?: string,
  ): Promise<void> {
    this.systems.push(system);
    this.emit({
      type: "message.part.updated",
      properties: {
        part: {
          id: "tool-1",
          sessionID: sessionId,
          type: "tool",
          tool: "bash",
          state: { status: "completed", output: "STRIPE_KEY=sk_test_preview_123\nDEBUG=on" },
        },
      },
    } as unknown as Event);
    this.emit({ type: "session.idle", properties: { sessionID: sessionId } });
    return Promise.resolve();
  }

  private emit(payload: Event): void {
    this.queue.push({ directory: "/tmp/demo", payload });
    this.wake?.();
  }

  listModels(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  respondToPermission(): Promise<void> {
    return Promise.resolve();
  }

  abort(): Promise<void> {
    return Promise.resolve();
  }

  parentSessionId(): Promise<string | null> {
    return Promise.resolve(null);
  }

  async *events(): AsyncGenerator<OpenCodeEvent> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

test("the agent learns key names only, and values never reach the transcript", async () => {
  const store = new EnvironmentStore(await temporary("nautilus-env-"));
  await store.replace("demo", { STRIPE_KEY: "sk_test_preview_123", DEBUG: "on" });
  const openCode = new ScriptedOpenCode();
  const registry = new Registry(":memory:");
  registry.upsertProject(project());
  const sessions = new SessionService(
    openCode,
    registry,
    new Map([["demo", project()]]),
    new Logger(() => undefined),
    undefined,
    store,
  );
  await sessions.start();
  try {
    const session = await sessions.createSession("demo", "Check keys");
    await sessions.prompt(session.id, "print the env");
    const events = await until(() => {
      const snapshot = sessions.snapshot(session.id);
      return snapshot?.events.some((event) => event.type === "session.tool")
        ? snapshot.events
        : undefined;
    });
    const stored = JSON.stringify(events);
    expect(stored).not.toContain("sk_test_preview_123");
    expect(stored).toContain("[redacted:STRIPE_KEY]");
    // Too short to hide without blanking ordinary words.
    expect(stored).toContain("DEBUG=on");

    expect(openCode.systems[0]).toContain("DEBUG, STRIPE_KEY");
    expect(openCode.systems[0]).not.toContain("sk_test_preview_123");
  } finally {
    await sessions.close();
    registry.close();
  }
});
