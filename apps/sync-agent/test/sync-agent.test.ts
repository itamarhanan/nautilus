import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import type { SyncRequest } from "@nautilus/types";
import { loadStateProjects } from "../src/config";
import { ShadowGit, shadowIndexPath } from "@nautilus/shadow-git";
import { GrantAuthority } from "../src/grants";
import { createSyncAgentServer } from "../src/index";
import { SyncAgent } from "../src/operations";

const allowAll = () => undefined;

const execFileAsync = promisify(execFile);

const indexEnv = (shadowPath: string) => ({
  ...process.env,
  GIT_INDEX_FILE: shadowIndexPath(shadowPath),
});
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryProject(): Promise<{
  root: string;
  workTree: string;
  shadowPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "nautilus-sync-test-"));
  roots.push(root);
  const workTree = join(root, "project");
  await mkdir(workTree);
  return { root, workTree, shadowPath: join(root, "shadow", "demo.git") };
}

function request(
  operation: SyncRequest["operation"],
  values: Partial<SyncRequest> = {},
): SyncRequest {
  return {
    version: 1,
    requestId: `request-${operation}-${String(Math.random()).slice(2)}`,
    operation,
    projectId: "demo",
    grant: "test-grant-payload.test-grant-signature",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    nonce: `nonce-${String(Math.random()).slice(2)}`,
    baseHead: null,
    expectedLocalHead: null,
    expectedRemoteHead: null,
    payload: {},
    ...values,
  };
}

function agentConfig(project: { root: string; workTree: string; shadowPath: string }) {
  return {
    host: "127.0.0.1",
    port: 4100,
    home: project.root,
    transactionPath: join(project.root, "transactions"),
    backupPath: join(project.root, "backups"),
    projects: [
      {
        id: "demo",
        name: "Demo",
        localPath: project.workTree,
        shadowPath: project.shadowPath,
      },
    ],
    maxFileBytes: 10_000_000,
    maxTotalBytes: 100_000_000,
    maxFileCount: 10_000,
    maxBundleBytes: 100_000_000,
    requestTimeoutMs: 30_000,
  };
}

describe("shadow Git", () => {
  test("creates a baseline and leaves the worktree's normal Git directory alone", async () => {
    const project = await temporaryProject();
    await writeFile(join(project.workTree, "README.md"), "hello\n");
    const git = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.workTree,
    });
    const baseline = await git.baseline();
    const head = await git.snapshot("checkpoint");
    expect(baseline).toBe(head);
    expect(await git.isClean()).toBe(true);
    expect((await git.diff(baseline, head)).files).toEqual([]);
    await writeFile(join(project.workTree, "README.md"), "goodbye\nworld\n");
    const changed = await git.snapshot("changed");
    const diff = await git.diff(baseline, changed);
    expect(diff).toMatchObject({ additions: 2, deletions: 1 });
    expect(diff.files[0]).toMatchObject({
      path: "README.md",
      status: "modified",
      binary: false,
      additions: 2,
      deletions: 1,
    });
    expect(diff.files[0]?.hunks[0]?.lines).toEqual([
      { type: "deletion", oldLine: 1, newLine: null, content: "hello" },
      { type: "addition", oldLine: null, newLine: 1, content: "goodbye" },
      { type: "addition", oldLine: null, newLine: 2, content: "world" },
    ]);
    expect(await readFile(join(project.workTree, "README.md"), "utf8")).toBe("goodbye\nworld\n");
    expect(project.shadowPath).not.toContain(join(project.workTree, ".git"));
  });

  test("does not change an existing normal Git history", async () => {
    const project = await temporaryProject();
    await execFileAsync("git", ["init", project.workTree]);
    await execFileAsync("git", ["-C", project.workTree, "config", "user.name", "Test"]);
    await execFileAsync("git", [
      "-C",
      project.workTree,
      "config",
      "user.email",
      "test@example.com",
    ]);
    await writeFile(join(project.workTree, "README.md"), "normal git\n");
    await execFileAsync("git", ["-C", project.workTree, "add", "README.md"]);
    await execFileAsync("git", ["-C", project.workTree, "commit", "-m", "normal"]);
    const before = (
      await execFileAsync("git", ["-C", project.workTree, "rev-parse", "HEAD"])
    ).stdout.trim();
    const git = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.workTree,
    });
    await git.snapshot("shadow checkpoint");
    const after = (
      await execFileAsync("git", ["-C", project.workTree, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(after).toBe(before);
  });

  test("leaves out what the project's .gitignore ignores, without measuring it", async () => {
    const project = await temporaryProject();
    const git = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.workTree,
      limits: { maxFileBytes: 1_000 },
    });
    await writeFile(join(project.workTree, ".gitignore"), "target/\n*.local\n");
    await writeFile(join(project.workTree, "README.md"), "hello\n");
    await writeFile(join(project.workTree, "notes.txt"), "keep\n");

    await mkdir(join(project.workTree, "app", "target", "debug"), {
      recursive: true,
    });
    await writeFile(join(project.workTree, "app", "target", "debug", "build"), "x".repeat(5_000));
    const first = await git.snapshot("first");
    expect((await git.diff(null, first)).files.map((file) => file.path)).toEqual([
      ".gitignore",
      "README.md",
      "notes.txt",
    ]);
    expect(await git.isClean()).toBe(true);

    await writeFile(join(project.workTree, ".gitignore"), "target/\n*.local\nnotes.txt\n");
    const second = await git.snapshot("second");
    expect((await git.diff(first, second)).files.map((file) => [file.path, file.status])).toEqual([
      [".gitignore", "modified"],
      ["notes.txt", "deleted"],
    ]);
    expect(await readFile(join(project.workTree, "notes.txt"), "utf8")).toBe("keep\n");
    expect(await git.isClean()).toBe(true);
  });

  test("shows every file of a large review and leaves out only files too big by themselves", async () => {
    const project = await temporaryProject();
    const git = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.workTree,
    });
    await writeFile(join(project.workTree, "a-bundle.js"), "x\n".repeat(4_000));
    await writeFile(join(project.workTree, "pnpm-lock.yaml"), "lock: 1\n");

    for (let index = 0; index < 30; index += 1) {
      await writeFile(
        join(project.workTree, `small-${String(index)}.ts`),
        "export {};\n".repeat(400),
      );
    }
    const head = await git.snapshot("first");
    const files = new Map((await git.diff(null, head)).files.map((file) => [file.path, file]));
    expect(files.get("a-bundle.js")).toMatchObject({
      omitted: "large",
      hunks: [],
      additions: 4_000,
    });
    expect(files.get("pnpm-lock.yaml")).toMatchObject({
      omitted: "generated",
      hunks: [],
    });
    for (let index = 0; index < 30; index += 1) {
      const file = files.get(`small-${String(index)}.ts`);
      expect(file?.omitted).toBeUndefined();
      expect(file?.hunks[0]?.lines).toHaveLength(400);
    }
  });

  test("rejects symlinks and Git LFS pointers", async () => {
    const project = await temporaryProject();
    const git = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.workTree,
    });
    await symlink("/tmp/outside", join(project.workTree, "link"));
    await expect(git.snapshot("unsafe")).rejects.toMatchObject({
      code: "symlink_rejected",
    });
    await rm(join(project.workTree, "link"));
    await writeFile(
      join(project.workTree, "pointer.txt"),
      "version https://git-lfs.github.com/spec/v1\noid sha256:abc\n",
    );
    await expect(git.snapshot("unsafe")).rejects.toMatchObject({
      code: "lfs_pointer_rejected",
    });
  });

  test("rejects Git modules and indexed submodules", async () => {
    const project = await temporaryProject();
    const git = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.workTree,
    });
    await writeFile(join(project.workTree, ".gitmodules"), '[submodule "module"]\n');
    await expect(git.snapshot("unsafe")).rejects.toMatchObject({
      code: "gitmodules_rejected",
    });
    await rm(join(project.workTree, ".gitmodules"));
    const baseline = await git.baseline();
    await execFileAsync(
      "git",
      [
        "--git-dir",
        project.shadowPath,
        "--work-tree",
        project.workTree,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${baseline},module`,
      ],
      { env: indexEnv(project.shadowPath) },
    );
    await expect(git.snapshot("unsafe")).rejects.toMatchObject({
      code: "submodule_rejected",
    });
    await execFileAsync(
      "git",
      [
        "--git-dir",
        project.shadowPath,
        "--work-tree",
        project.workTree,
        "update-index",
        "--force-remove",
        "module",
      ],
      { env: indexEnv(project.shadowPath) },
    );
    await writeFile(join(project.root, "link-target"), "outside\n");
    const linkHash = (
      await execFileAsync("git", [
        "--git-dir",
        project.shadowPath,
        "hash-object",
        "-w",
        join(project.root, "link-target"),
      ])
    ).stdout.trim();
    await execFileAsync(
      "git",
      [
        "--git-dir",
        project.shadowPath,
        "--work-tree",
        project.workTree,
        "update-index",
        "--add",
        "--cacheinfo",
        `120000,${linkHash},linked`,
      ],
      { env: indexEnv(project.shadowPath) },
    );
    await expect(git.snapshot("unsafe")).rejects.toMatchObject({
      code: "unsupported_tree_mode",
    });
  });

  test("excludes a nested worktree instead of failing the project", async () => {
    const project = await temporaryProject();
    const git = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.workTree,
    });
    await writeFile(join(project.workTree, "README.md"), "line content\n");

    const worktree = join(project.workTree, ".claude", "worktrees", "feature");
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/feature\n");
    await writeFile(join(worktree, "README.md"), "a whole second checkout\n");

    const head = await git.snapshot("with nested worktree");
    const tree = (
      await execFileAsync("git", [
        "--git-dir",
        project.shadowPath,
        "ls-tree",
        "-r",
        "--name-only",
        head,
      ])
    ).stdout
      .trim()
      .split("\n");
    expect(tree).toEqual(["README.md"]);

    expect(await git.isClean()).toBe(true);
  });

  test("never records a nested repository as a gitlink", async () => {
    const project = await temporaryProject();
    const git = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.workTree,
    });
    await writeFile(join(project.workTree, "README.md"), "line content\n");

    const nested = join(project.root, "vendored");
    await mkdir(nested, { recursive: true });
    await execFileAsync("git", ["init", nested]);
    await writeFile(join(nested, "lib.txt"), "vendored\n");
    await execFileAsync("git", ["-C", nested, "add", "lib.txt"]);
    await execFileAsync("git", [
      "-C",
      nested,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "vendored",
    ]);
    await mkdir(join(project.workTree, "vendor"), { recursive: true });
    await execFileAsync("git", ["init", join(project.workTree, "vendor")]);
    await writeFile(join(project.workTree, "vendor", "lib.txt"), "vendored\n");
    await execFileAsync("git", ["-C", join(project.workTree, "vendor"), "add", "lib.txt"]);
    await execFileAsync("git", [
      "-C",
      join(project.workTree, "vendor"),
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "vendored",
    ]);

    await git.snapshot("with nested repository");

    const modes = (
      await execFileAsync("git", ["--git-dir", project.shadowPath, "ls-files", "-s"], {
        env: indexEnv(project.shadowPath),
      })
    ).stdout.trim();
    expect(modes).not.toContain("160000");
    expect(modes).toContain("README.md");

    expect(await readFile(join(project.workTree, "vendor", "lib.txt"), "utf8")).toBe("vendored\n");
  });

  test("reports the worktree as dirty from the shadow head", async () => {
    const project = await temporaryProject();
    const git = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.workTree,
    });
    await writeFile(join(project.workTree, "README.md"), "clean\n");
    await git.snapshot("clean");
    expect(await git.isClean()).toBe(true);

    await writeFile(join(project.workTree, "README.md"), "dirty\n");
    expect(await git.isClean()).toBe(false);
    await writeFile(join(project.workTree, "untracked.txt"), "new\n");
    expect(await git.isClean()).toBe(false);
    expect(await git.changedPaths(null)).toContain("untracked.txt");

    await git.snapshot("dirty again");
    expect(await git.isClean()).toBe(true);
  });

  test("sends only the commits after the base when the receiver already has it", async () => {
    const project = await temporaryProject();
    const git = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.workTree,
    });
    await writeFile(join(project.workTree, "seed.txt"), "seed\n".repeat(500));
    const base = await git.snapshot("base");

    await writeFile(join(project.workTree, "later.txt"), "later\n");
    const head = await git.snapshot("later");

    const directory = join(project.root, "bundles");
    const full = await git.createBundle(head, directory, null);
    const incremental = await git.createBundle(head, directory, base);
    expect(incremental.bytes.length).toBeLessThan(full.bytes.length);
    expect(incremental.head).toBe(head);
  });

  test("sends the full history when the base is not an ancestor of the head", async () => {
    const project = await temporaryProject();
    const git = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.workTree,
    });
    await writeFile(join(project.workTree, "seed.txt"), "seed\n".repeat(500));
    await git.snapshot("base");
    await writeFile(join(project.workTree, "later.txt"), "later\n");
    const head = await git.snapshot("later");

    const directory = join(project.root, "bundles");
    const bundle = await git.createBundle(head, directory, "0".repeat(40));
    const full = await git.createBundle(head, directory, null);
    expect(bundle.bytes.length).toBe(full.bytes.length);
  });

  test("adopts a shadow repository written under the original single ref", async () => {
    const project = await temporaryProject();
    await writeFile(join(project.workTree, "README.md"), "existing history\n");
    const legacy = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.workTree,
    });
    const previous = await legacy.snapshot("written by an older build");

    await execFileAsync("git", [
      "--git-dir",
      project.shadowPath,
      "update-ref",
      "refs/heads/nautilus",
      previous,
    ]);
    const adopted = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.workTree,
    });
    expect(await adopted.head()).toBe(previous);
    expect(await adopted.isClean()).toBe(true);
  });

  test("rebuilds a lost index instead of reporting everything untracked", async () => {
    const project = await temporaryProject();
    const git = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.workTree,
    });
    await writeFile(join(project.workTree, "README.md"), "content\n");
    await git.snapshot("checkpoint");
    expect(await git.isClean()).toBe(true);

    await rm(shadowIndexPath(project.shadowPath));

    const restarted = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.workTree,
    });
    expect(await restarted.isClean()).toBe(true);
    expect(await restarted.changedPaths(null)).toEqual([]);
  });

  test("handles empty repositories and reports binary changes", async () => {
    const empty = await temporaryProject();
    const emptyGit = new ShadowGit({
      gitDir: empty.shadowPath,
      workTree: empty.workTree,
    });
    const baseline = await emptyGit.baseline();
    const head = await emptyGit.snapshot("empty");
    expect(await emptyGit.diff(baseline, head)).toEqual({
      files: [],
      additions: 0,
      deletions: 0,
    });

    const binaryProject = await temporaryProject();
    const binaryGit = new ShadowGit({
      gitDir: binaryProject.shadowPath,
      workTree: binaryProject.workTree,
    });
    const binaryBaseline = await binaryGit.baseline();
    await writeFile(join(binaryProject.workTree, "image.bin"), Buffer.from([0, 255, 1, 254]));
    const binaryHead = await binaryGit.snapshot("binary");
    const binaryDiff = await binaryGit.diff(binaryBaseline, binaryHead);
    expect(binaryDiff).toMatchObject({ additions: 0, deletions: 0 });
    expect(binaryDiff.files[0]).toMatchObject({
      path: "image.bin",
      status: "added",
      binary: true,
      hunks: [],
    });
  });
});

describe("sync agent", () => {
  test("creates, imports, preflights, and applies a clean bundle", async () => {
    const localProject = await temporaryProject();
    const remoteProject = await temporaryProject();
    await writeFile(join(localProject.workTree, "README.md"), "same\n");
    await writeFile(join(remoteProject.workTree, "README.md"), "same\n");
    const agent = new SyncAgent(agentConfig(localProject), allowAll);
    const local = await agent.handle(request("create_bundle"));
    expect(local.status).toBe("ok");
    expect(local.bundle).toBeDefined();

    const localState = await agent.handle(
      request("state", { payload: { runnerBase: local.bundle?.head ?? null } }),
    );
    expect(localState.state?.head).toBe(local.bundle?.head);
    expect(localState.state?.baseHead).toBeTruthy();

    const remoteGit = new ShadowGit({
      gitDir: remoteProject.shadowPath,
      workTree: remoteProject.workTree,
    });
    const remoteHead = await remoteGit.snapshot("remote checkpoint");
    const remoteBundle = await remoteGit.createBundle(
      remoteHead,
      join(remoteProject.root, "bundles"),
      null,
    );
    const imported = await agent.handle(
      request("import_bundle", {
        baseHead: null,
        payload: {
          head: remoteBundle.head,
          sha256: remoteBundle.sha256,
          bytesBase64: Buffer.from(remoteBundle.bytes).toString("base64"),
        },
      }),
    );
    expect(imported.status).toBe("ok");
    const stalePreflight = await agent.handle(
      request("preflight", {
        baseHead: null,
        expectedLocalHead: "f".repeat(40),
        expectedRemoteHead: remoteHead,
        payload: { localHead: localState.state?.head, remoteHead },
      }),
    );
    expect(stalePreflight.status).toBe("stale");
    expect(stalePreflight.error?.code).toBe("stale_local_head");
    const preflight = await agent.handle(
      request("preflight", {
        baseHead: null,
        expectedLocalHead: localState.state?.head ?? null,
        expectedRemoteHead: remoteHead,
        payload: { localHead: "f".repeat(40), remoteHead: "e".repeat(40) },
      }),
    );
    expect(preflight.status).toBe("ok");
    expect(preflight.applyToken).toBeTruthy();
    const stale = await agent.handle(
      request("apply", {
        baseHead: null,
        expectedLocalHead: "f".repeat(40),
        expectedRemoteHead: remoteHead,
        payload: { applyToken: preflight.applyToken },
      }),
    );
    expect(stale.status).toBe("stale");
    expect(stale.error?.code).toBe("stale_expected_head");
    expect(await readFile(join(localProject.workTree, "README.md"), "utf8")).toBe("same\n");
    const applied = await agent.handle(
      request("apply", {
        baseHead: null,
        expectedLocalHead: localState.state?.head ?? null,
        expectedRemoteHead: remoteHead,
        payload: {
          applyToken: preflight.applyToken,
          localHead: "f".repeat(40),
          remoteHead: "e".repeat(40),
        },
      }),
    );
    expect(applied.status).toBe("ok");
    expect(await readFile(join(localProject.workTree, "README.md"), "utf8")).toBe("same\n");
  });

  test("an apply the runner gave up on changes nothing and can be retried", async () => {
    const localProject = await temporaryProject();
    const remoteProject = await temporaryProject();
    await writeFile(join(localProject.workTree, "README.md"), "base\n");
    const agent = new SyncAgent(agentConfig(localProject), allowAll);
    const local = await agent.handle(request("create_bundle"));
    const localState = await agent.handle(
      request("state", { payload: { runnerBase: local.bundle?.head ?? null } }),
    );

    const remoteGit = new ShadowGit({
      gitDir: remoteProject.shadowPath,
      workTree: remoteProject.workTree,
    });
    await remoteGit.initialize();
    await remoteGit.importBundle(
      {
        head: local.bundle?.head ?? "",
        sha256: local.bundle?.sha256 ?? "",
        bytes: Buffer.from(local.bundle?.bytesBase64 ?? "", "base64"),
      },
      null,
    );
    await remoteGit.restoreHead(local.bundle?.head ?? "");
    await writeFile(join(remoteProject.workTree, "README.md"), "from the runner\n");
    const remoteHead = await remoteGit.snapshot("runner edit");
    const bundle = await remoteGit.createBundle(
      remoteHead,
      join(remoteProject.root, "bundles"),
      localState.state?.baseHead ?? null,
    );
    const baseHead = localState.state?.baseHead ?? null;
    await agent.handle(
      request("import_bundle", {
        baseHead,
        payload: {
          head: bundle.head,
          sha256: bundle.sha256,
          bytesBase64: Buffer.from(bundle.bytes).toString("base64"),
        },
      }),
    );
    const preflight = await agent.handle(
      request("preflight", {
        baseHead,
        expectedLocalHead: localState.state?.head ?? null,
        expectedRemoteHead: remoteHead,
      }),
    );
    expect(preflight.applyToken).toBeTruthy();
    const apply = () =>
      request("apply", {
        baseHead,
        expectedLocalHead: localState.state?.head ?? null,
        expectedRemoteHead: remoteHead,
        payload: { applyToken: preflight.applyToken },
      });

    const abandoned = await agent.handle(apply(), undefined, AbortSignal.abort());
    expect(abandoned.error?.code).toBe("request_timeout");
    expect(await readFile(join(localProject.workTree, "README.md"), "utf8")).toBe("base\n");

    const applied = await agent.handle(apply());
    expect(applied.status).toBe("ok");
    expect(await readFile(join(localProject.workTree, "README.md"), "utf8")).toBe(
      "from the runner\n",
    );
  });

  test("returns a conflict without changing the local file", async () => {
    const localProject = await temporaryProject();
    const remoteProject = await temporaryProject();
    await writeFile(join(localProject.workTree, "README.md"), "local\n");
    await writeFile(join(remoteProject.workTree, "README.md"), "remote\n");
    const agent = new SyncAgent(agentConfig(localProject), allowAll);
    const local = await agent.handle(request("create_bundle"));
    expect(local.bundle).toBeDefined();
    const localState = await agent.handle(request("state"));
    const remoteGit = new ShadowGit({
      gitDir: remoteProject.shadowPath,
      workTree: remoteProject.workTree,
    });
    const remoteHead = await remoteGit.snapshot("remote checkpoint");
    const remoteBundle = await remoteGit.createBundle(
      remoteHead,
      join(remoteProject.root, "bundles"),
      null,
    );
    await agent.handle(
      request("import_bundle", {
        baseHead: null,
        payload: {
          head: remoteBundle.head,
          sha256: remoteBundle.sha256,
          bytesBase64: Buffer.from(remoteBundle.bytes).toString("base64"),
        },
      }),
    );
    const preflight = await agent.handle(
      request("preflight", {
        baseHead: null,
        expectedLocalHead: localState.state?.head ?? null,
        expectedRemoteHead: remoteHead,
        payload: { localHead: "f".repeat(40), remoteHead: "e".repeat(40) },
      }),
    );
    expect(preflight.status).toBe("conflict");
    expect(preflight.conflicts).toEqual([
      {
        path: "README.md",
        reason: "add_conflict",
        pc: "added",
        runner: "added",
      },
    ]);
    expect(await readFile(join(localProject.workTree, "README.md"), "utf8")).toBe("local\n");

    const resolved = await agent.handle(
      request("preflight", {
        baseHead: null,
        expectedLocalHead: localState.state?.head ?? null,
        expectedRemoteHead: remoteHead,
        payload: { resolutions: { "README.md": "runner" } },
      }),
    );
    expect(resolved.status).toBe("ok");
    const applied = await agent.handle(
      request("apply", {
        baseHead: null,
        expectedLocalHead: localState.state?.head ?? null,
        expectedRemoteHead: remoteHead,
        payload: { applyToken: resolved.applyToken },
      }),
    );
    expect(applied.status).toBe("ok");
    expect(await readFile(join(localProject.workTree, "README.md"), "utf8")).toBe("remote\n");
  });

  describe("mergeTree", () => {
    const lines = (...values: string[]) => values.map((value) => `${value}\n`).join("");

    async function sides(
      base: Record<string, string>,
      ours: Record<string, string | null>,
      theirs: Record<string, string | null>,
    ) {
      const project = await temporaryProject();
      const git = new ShadowGit({
        gitDir: project.shadowPath,
        workTree: project.workTree,
      });
      const write = async (files: Record<string, string | null>) => {
        for (const [path, content] of Object.entries(files)) {
          if (content === null) await rm(join(project.workTree, path), { force: true });
          else await writeFile(join(project.workTree, path), content);
        }
      };
      await write(base);
      const baseHead = await git.snapshot("base");
      await write(ours);
      const oursHead = await git.snapshot("ours");
      await git.restoreHead(baseHead);
      await write(theirs);
      const theirsHead = await git.snapshot("theirs");
      const read = async (tree: string, path: string) =>
        (await execFileAsync("git", ["--git-dir", project.shadowPath, "show", `${tree}:${path}`]))
          .stdout;
      return { git, baseHead, oursHead, theirsHead, read };
    }

    test("keeps a deletion when the other side left the file alone", async () => {
      const { git, baseHead, oursHead, theirsHead } = await sides(
        { "a.ts": "a\n", "b.ts": "b\n" },
        { "a.ts": null },
        { "b.ts": "changed\n" },
      );
      const merge = await git.mergeTree(baseHead, oursHead, theirsHead);
      expect(merge.clean).toBe(true);
    });

    test("merges edits to different lines of the same file", async () => {
      const { git, baseHead, oursHead, theirsHead, read } = await sides(
        { "a.ts": lines("1", "2", "3", "4", "5", "6", "7", "8") },
        { "a.ts": lines("one", "2", "3", "4", "5", "6", "7", "8") },
        { "a.ts": lines("1", "2", "3", "4", "5", "6", "7", "eight") },
      );
      const merge = await git.mergeTree(baseHead, oursHead, theirsHead);
      expect(merge.clean).toBe(true);
      expect(await read(merge.tree as string, "a.ts")).toBe(
        lines("one", "2", "3", "4", "5", "6", "7", "eight"),
      );
    });

    test("reports overlapping edits and edits against deletions, then takes the picked side", async () => {
      const { git, baseHead, oursHead, theirsHead, read } = await sides(
        { "a.ts": "base\n", "b.ts": "b\n" },
        { "a.ts": "ours\n", "b.ts": null },
        { "a.ts": "theirs\n", "b.ts": "edited\n" },
      );
      const merge = await git.mergeTree(baseHead, oursHead, theirsHead);
      expect(merge.clean).toBe(false);
      expect(merge.conflicts).toEqual([
        {
          path: "a.ts",
          reason: "content_conflict",
          ours: "modified",
          theirs: "modified",
        },
        {
          path: "b.ts",
          reason: "delete_conflict",
          ours: "deleted",
          theirs: "modified",
        },
      ]);
      const picked = await git.mergeTree(baseHead, oursHead, theirsHead, {
        "a.ts": "theirs",
        "b.ts": "ours",
      });
      expect(picked.clean).toBe(true);
      expect(await read(picked.tree as string, "a.ts")).toBe("theirs\n");
      await expect(read(picked.tree as string, "b.ts")).rejects.toThrow();
    });
  });

  test("accepts only grants minted by this PC for the project and direction", async () => {
    const project = await temporaryProject();
    await writeFile(join(project.workTree, "README.md"), "hello\n");
    let clock = Date.now();
    const grants = new GrantAuthority(Buffer.alloc(32, 7), () => clock);
    const agent = new SyncAgent(agentConfig(project), grants.authenticate);

    const pull = grants.mint("demo", "pull");
    expect((await agent.handle(request("preview", { grant: pull.grant }))).status).toBe("ok");

    const push = grants.mint("demo", "push");
    const wrongDirection = await agent.handle(request("apply", { grant: push.grant }));
    expect(wrongDirection.error?.code).toBe("grant_wrong_direction");

    const otherProject = grants.mint("other", "pull");
    expect((await agent.handle(request("state", { grant: otherProject.grant }))).error?.code).toBe(
      "grant_wrong_project",
    );

    const forged = new GrantAuthority(Buffer.alloc(32, 9)).mint("demo", "pull");
    expect((await agent.handle(request("state", { grant: forged.grant }))).error?.code).toBe(
      "grant_invalid",
    );

    grants.revoke(pull.claims.grantId);
    expect((await agent.handle(request("state", { grant: pull.grant }))).error?.code).toBe(
      "grant_revoked",
    );

    const expiring = grants.mint("demo", "pull", 60_000);
    clock += 61_000;
    expect((await agent.handle(request("state", { grant: expiring.grant }))).error?.code).toBe(
      "grant_expired",
    );

    const long = grants.mint("demo", "pull", 60 * 60 * 1000);
    expect(Date.parse(long.claims.expiresAt) - Date.parse(long.claims.issuedAt)).toBe(600_000);
  });

  test("local status counts changes since the base without writing a snapshot", async () => {
    const project = await temporaryProject();
    await writeFile(join(project.workTree, "README.md"), "hello\n");
    const agent = new SyncAgent(agentConfig(project), allowAll);
    expect(await agent.localStatus("demo")).toMatchObject({
      neverSynced: true,
      changedFiles: 0,
    });

    await agent.handle(request("preview"));
    const git = new ShadowGit({
      gitDir: project.shadowPath,
      workTree: project.workTree,
    });
    const headBefore = await git.head();

    expect(await agent.localStatus("demo")).toMatchObject({
      neverSynced: true,
    });
    await agent.handle(request("state", { payload: { runnerBase: headBefore } }));
    await writeFile(join(project.workTree, "README.md"), "changed\n");
    await writeFile(join(project.workTree, "new.txt"), "new\n");
    await writeFile(join(project.workTree, ".env"), "SECRET=1\n");

    const status = await agent.localStatus("demo");
    expect(status).toMatchObject({ neverSynced: false, changedFiles: 2 });
    expect(status.changedPaths).toEqual(["README.md", "new.txt"]);
    expect(await git.head()).toBe(headBefore);
  });

  test("desktop endpoints require the launch key and reject browser origins", async () => {
    const project = await temporaryProject();
    const config = agentConfig(project);
    const launchKey = "k".repeat(43);
    const grants = new GrantAuthority(Buffer.from(launchKey, "utf8"));
    const instance = await createSyncAgentServer(config, grants);
    await new Promise<void>((resolveListen) => {
      instance.server.listen(0, "127.0.0.1", () => {
        resolveListen();
      });
    });
    try {
      const address = instance.server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      const base = `http://127.0.0.1:${String(address.port)}`;
      const mint = (headers: Record<string, string>) =>
        fetch(`${base}/v1/grants`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ projectId: "demo", direction: "pull" }),
        });

      expect((await mint({})).status).toBe(401);
      expect((await mint({ authorization: "Bearer wrong" })).status).toBe(401);
      expect(
        (
          await mint({
            authorization: `Bearer ${launchKey}`,
            origin: "https://attacker.example",
          })
        ).status,
      ).toBe(401);

      const minted = await mint({ authorization: `Bearer ${launchKey}` });
      expect(minted.status).toBe(201);
      const { grant, claims } = (await minted.json()) as {
        grant: string;
        claims: { grantId: string };
      };

      const sync = (value: string) =>
        fetch(`${base}/v1/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request("state", { grant: value })),
        });
      expect((await sync(grant)).status).toBe(200);

      const revoked = await fetch(`${base}/v1/grants/revoke`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${launchKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ grantId: claims.grantId }),
      });
      expect(revoked.status).toBe(200);
      expect((await sync(grant)).status).toBe(400);

      const status = await fetch(`${base}/v1/status?projectId=demo`, {
        headers: { authorization: `Bearer ${launchKey}` },
      });
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({
        projectId: "demo",
        neverSynced: true,
      });
      expect(
        (
          await fetch(`${base}/v1/status?projectId=missing`, {
            headers: { authorization: `Bearer ${launchKey}` },
          })
        ).status,
      ).toBe(404);
    } finally {
      await instance.close();
    }
  });

  test("reads the project list from the desktop state file", async () => {
    const project = await temporaryProject();
    const statePath = join(project.root, "state.json");
    expect(await loadStateProjects(statePath, project.root)).toEqual([]);
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        projects: [
          { id: "shop", name: "Shop", localPath: "~/code/shop" },
          { id: "../escape", name: "Bad", localPath: "~/bad" },
          { id: "relative", name: "Relative", localPath: "code/relative" },
        ],
        recentFolders: [],
      }),
    );
    expect(await loadStateProjects(statePath, project.root)).toEqual([
      {
        id: "shop",
        name: "Shop",
        localPath: join(project.root, "code", "shop"),
        shadowPath: join(project.root, ".nautilus", "shadow", "shop.git"),
      },
    ]);
  });

  test("reads one entry per project, ignoring the removed per-line field", async () => {
    const project = await temporaryProject();
    const statePath = join(project.root, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: "shop",
            name: "Shop",
            localPath: "~/code/shop",
            lines: [
              { id: "default", name: "Shop", localPath: "~/code/shop" },
              {
                id: "line-a",
                name: "Feature",
                localPath: "~/code/shop-feature",
              },
            ],
          },
        ],
        recentFolders: [],
      }),
    );
    const projects = await loadStateProjects(statePath, project.root);
    expect(projects).toEqual([
      {
        id: "shop",
        name: "Shop",
        localPath: join(project.root, "code", "shop"),
        shadowPath: join(project.root, ".nautilus", "shadow", "shop.git"),
      },
    ]);
  });

  test("rejects a bundle whose digest does not match", async () => {
    const localProject = await temporaryProject();
    const remoteProject = await temporaryProject();
    const agent = new SyncAgent(agentConfig(localProject), allowAll);
    await agent.handle(request("create_bundle"));
    const state = await agent.handle(request("state"));
    const remoteGit = new ShadowGit({
      gitDir: remoteProject.shadowPath,
      workTree: remoteProject.workTree,
    });
    const remoteHead = await remoteGit.snapshot("remote checkpoint");
    const remoteBundle = await remoteGit.createBundle(
      remoteHead,
      join(remoteProject.root, "bundles"),
      null,
    );
    const corrupt = Buffer.from(remoteBundle.bytes);
    corrupt[0] = (corrupt[0] ?? 0) ^ 1;
    const result = await agent.handle(
      request("import_bundle", {
        baseHead: state.state?.baseHead ?? null,
        payload: {
          head: remoteBundle.head,
          sha256: remoteBundle.sha256,
          bytesBase64: corrupt.toString("base64"),
        },
      }),
    );
    expect(result.status).toBe("invalid");
    expect(result.error?.code).toBe("bundle_digest_mismatch");
  });

  test("streams bundles over the loopback endpoint and makes apply tokens single-use", async () => {
    const localProject = await temporaryProject();
    const remoteProject = await temporaryProject();
    await writeFile(join(localProject.workTree, "README.md"), "same\n");
    await writeFile(join(remoteProject.workTree, "README.md"), "same\n");
    const config = agentConfig(localProject);
    const instance = await createSyncAgentServer(
      config,
      GrantAuthority.random(),
      new SyncAgent(config, allowAll),
    );
    await new Promise<void>((resolveListen) => {
      instance.server.listen(0, "127.0.0.1", () => {
        resolveListen();
      });
    });

    try {
      const address = instance.server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      const endpoint = `http://127.0.0.1:${String(address.port)}/v1/sync`;
      const createResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request("create_bundle")),
      });
      expect(createResponse.headers.get("content-type")).toContain("application/octet-stream");
      const responseHeader = createResponse.headers.get("x-nautilus-response");
      expect(responseHeader).toBeTruthy();
      const metadata = JSON.parse(
        Buffer.from(responseHeader ?? "", "base64url").toString("utf8"),
      ) as {
        bundle: { sha256: string };
      };
      expect(metadata.bundle.sha256).toHaveLength(64);
      expect(Buffer.from(await createResponse.arrayBuffer()).length).toBeGreaterThan(0);
      const stateResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request("state")),
      });
      const state = (await stateResponse.json()) as {
        state: { head: string; baseHead: string };
      };
      const remoteGit = new ShadowGit({
        gitDir: remoteProject.shadowPath,
        workTree: remoteProject.workTree,
      });
      const remoteHead = await remoteGit.snapshot("remote checkpoint");
      const remoteBundle = await remoteGit.createBundle(
        remoteHead,
        join(remoteProject.root, "bundles"),
        null,
      );
      const importRequest = request("import_bundle", {
        baseHead: null,
        digest: remoteBundle.sha256,
        payload: { head: remoteBundle.head, sha256: remoteBundle.sha256 },
      });
      const importResponse = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-nautilus-request": Buffer.from(JSON.stringify(importRequest)).toString("base64url"),
        },
        body: new Uint8Array(remoteBundle.bytes),
      });
      expect(importResponse.status).toBe(200);
      const preflightResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          request("preflight", {
            baseHead: null,
            expectedLocalHead: state.state.head,
            expectedRemoteHead: remoteHead,
            payload: {},
          }),
        ),
      });
      const preflight = (await preflightResponse.json()) as {
        status: string;
        applyToken: string;
      };
      expect(preflight.status).toBe("ok");
      const applyRequest = request("apply", {
        baseHead: null,
        expectedLocalHead: state.state.head,
        expectedRemoteHead: remoteHead,
        payload: { applyToken: preflight.applyToken },
      });
      const applyResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(applyRequest),
      });
      expect(applyResponse.status).toBe(200);
      const retryResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          request("apply", {
            baseHead: null,
            expectedLocalHead: state.state.head,
            expectedRemoteHead: remoteHead,
            payload: { applyToken: preflight.applyToken },
          }),
        ),
      });
      expect(retryResponse.status).toBe(409);
      const retry = (await retryResponse.json()) as { error: { code: string } };
      expect(retry.error.code).toBe("expired_apply_token");
    } finally {
      await instance.close();
    }
  });

  test("restores the synchronization base after an interrupted apply", async () => {
    const project = await temporaryProject();
    await writeFile(join(project.workTree, "README.md"), "base\n");
    const config = agentConfig(project);
    const agent = new SyncAgent(config, allowAll);
    const created = await agent.handle(request("create_bundle"));
    const state = await agent.handle(
      request("state", {
        payload: { runnerBase: created.bundle?.head ?? null },
      }),
    );
    const baseHead = state.state?.baseHead;
    const localHead = state.state?.head;
    if (!baseHead || !localHead) throw new Error("Expected a synchronized baseline");

    const transactionDirectory = join(project.root, "transactions", "demo", "transactions");
    const recoveryDirectory = join(project.root, "transactions", "demo", "recovery");
    await mkdir(transactionDirectory, { recursive: true });
    await mkdir(recoveryDirectory, { recursive: true });
    const transactionPath = join(transactionDirectory, "interrupted.json");
    const recoveryPath = join(recoveryDirectory, "interrupted.json");
    const basePath = join(project.root, "transactions", "demo", "state", "base.json");
    await mkdir(join(project.root, "transactions", "demo", "state"), {
      recursive: true,
    });
    await writeFile(basePath, JSON.stringify("wrong-base"));
    await writeFile(recoveryPath, JSON.stringify({ head: localHead, baseHead }));
    await writeFile(
      transactionPath,
      JSON.stringify({
        requestId: "interrupted",
        projectId: "demo",
        direction: "pull",
        status: "prepared",
        baseHead,
        expectedLocalHead: localHead,
        expectedRemoteHead: "remote",
        preflight: "preflight",
        recoveryPath,
        previousBaseHead: baseHead,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    const recoveringAgent = new SyncAgent(config, allowAll);
    await recoveringAgent.recover();
    const recovered = await recoveringAgent.handle(request("state"));
    expect(recovered.state?.baseHead).toBe(baseHead);
    expect(JSON.parse(await readFile(basePath, "utf8"))).toBe(baseHead);
    expect(created.status).toBe("ok");
  });
});
