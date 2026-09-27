import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { ShadowGit, shadowIndexPath } from "@nautilus/shadow-git";

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
