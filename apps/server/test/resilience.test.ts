import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ProjectConfig } from "@nautilus/types";
import { LifecycleJournal } from "../src/lifecycle-journal";
import { Registry } from "../src/registry";
import { ShadowGit } from "@nautilus/shadow-git";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function project(): ProjectConfig {
  return {
    id: "demo",
    name: "Demo",
    remotePath: "/tmp/demo",
    devCommand: "node server.js",
    devPort: 3210,
    previewPath: "/preview/demo/",
  };
}

test("lifecycle journal distinguishes a first start from recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilus-lifecycle-"));
  roots.push(root);
  const path = join(root, "journal.jsonl");
  const first = new LifecycleJournal(path);
  await first.initialize();
  expect(first.snapshot().recovered).toBe(false);
  await first.transition("ready");

  const second = new LifecycleJournal(path);
  await second.initialize();
  expect(second.snapshot().recovered).toBe(true);
  await second.transition("starting", "runner_restarted");
  await second.recordService("server", "start");
  await second.recordCheckpoint("demo", "abc123");
  expect(second.snapshot().state).toBe("starting");
  const journal = await readFile(path, "utf8");
  expect(journal).toContain("runner_restarted");
  expect(journal).toContain('"type":"service_start"');
  expect(journal).toContain('"type":"checkpoint"');
});

test("registry marks checkpointing projects as interrupted after a restart", () => {
  const registry = new Registry(":memory:");
  registry.upsertProject(project());
  registry.updateProjectState("demo", "checkpointing", null);
  registry.recoverInterruptedProjects();
  expect(registry.getProject("demo")).toMatchObject({
    state: "error",
    lastError: "runner_restarted",
  });
  registry.close();
});

test("shadow validation detects an uncheckpointed worktree change", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilus-shadow-"));
  roots.push(root);
  const workTree = join(root, "worktree");
  await mkdir(workTree);
  const git = new ShadowGit({ gitDir: join(root, "shadow.git"), workTree });
  await writeFile(join(workTree, "file.txt"), "initial\n");
  await git.snapshot("initial checkpoint");
  expect(await git.validate()).toMatchObject({ valid: true, dirty: false });

  await writeFile(join(workTree, "file.txt"), "uncheckpointed\n");
  expect(await git.validate()).toMatchObject({ valid: true, dirty: true });
});

test("a registry written with sync lines drops them and keeps every session", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilus-line-removal-"));
  const registryPath = join(root, "registry.sqlite");
  const legacy = new DatabaseSync(registryPath);
  legacy.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      remote_path TEXT NOT NULL,
      dev_command TEXT NOT NULL,
      dev_port INTEGER NOT NULL,
      preview_path TEXT NOT NULL,
      state TEXT NOT NULL,
      last_error TEXT,
      started_at TEXT,
      first_sync_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      opencode_session_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      last_sequence INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      line_id TEXT
    );
    CREATE TABLE project_lines (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      remote_path TEXT NOT NULL,
      dev_port INTEGER NOT NULL,
      preview_path TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id)
    );
    CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO projects VALUES ('demo', 'Demo', '/tmp/demo', 'pnpm dev', 3100,
      '/preview/demo/', 'inactive', NULL, NULL, NULL, '2026-01-01', '2026-01-01');
    INSERT INTO agent_sessions VALUES ('session-1', 'demo', 'oc-1', 'Work', 'idle', 0,
      '2026-01-01', '2026-01-01', 'line-a');
    INSERT INTO project_lines VALUES ('line-a', 'demo', 'Feature', '/tmp/demo.lines/line-a',
      3101, '/preview/demo/line-a/', 0, '2026-01-01', '2026-01-01');
    INSERT INTO server_state VALUES ('active_line:demo', '"line-a"');
  `);
  legacy.close();

  const registry = new Registry(registryPath);
  expect(registry.getAgentSession("session-1")).toMatchObject({
    projectId: "demo",
    title: "Work",
  });
  expect(registry.getAgentSession("session-1")).not.toHaveProperty("lineId");

  expect(registry.activeDevPort("demo")).toBe(3100);
  registry.close();

  const reopened = new DatabaseSync(registryPath);
  const tables = reopened
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_lines'")
    .all();
  const leftovers = reopened
    .prepare("SELECT key FROM server_state WHERE key LIKE 'active_line:%'")
    .all();
  reopened.close();
  expect(tables).toEqual([]);
  expect(leftovers).toEqual([]);
  await rm(root, { recursive: true, force: true });
});
