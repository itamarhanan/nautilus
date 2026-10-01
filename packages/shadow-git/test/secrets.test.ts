import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { isSecretFile, ShadowGit, shadowIndexPath } from "../src/index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<{ git: ShadowGit; gitDir: string; workTree: string }> {
  const root = await mkdtemp(join(tmpdir(), "nautilus-secrets-"));
  roots.push(root);
  const workTree = join(root, "work");
  const gitDir = join(root, "shadow.git");
  await mkdir(workTree);
  const git = new ShadowGit({ gitDir, workTree });
  await git.initialize();
  return { git, gitDir, workTree };
}

// Builds a commit the way an older Nautilus would have, back when the listed
// files were still synchronized.
function legacyCommit(gitDir: string, files: Record<string, string>, parent?: string): string {
  const run = (args: string[], input?: string): string =>
    execFileSync("git", ["--git-dir", gitDir, ...args], {
      input,
      env: { ...process.env, GIT_INDEX_FILE: join(gitDir, "legacy-index") },
    })
      .toString("utf8")
      .trim();
  run(["read-tree", "--empty"]);
  for (const [path, contents] of Object.entries(files)) {
    const blob = run(["hash-object", "-w", "--stdin"], contents);
    run(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
  }
  const tree = run(["write-tree"]);
  return run(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "legacy"]);
}

describe("secret files", () => {
  test("recognizes common secret files and nothing else", () => {
    for (const path of [
      ".env",
      ".env.local",
      ".env.example",
      "apps/web/.env.production",
      ".envrc",
      ".dev.vars",
      "certs/server.pem",
      "tls.key",
      "store.p12",
      "store.pfx",
      "id_rsa",
      "id_ed25519.pub",
    ])
      expect(isSecretFile(path), path).toBe(true);
    for (const path of ["environment.ts", "src/env.ts", ".npmrc", "keys.ts", "foo.env.ts"])
      expect(isSecretFile(path), path).toBe(false);
  });

  test("snapshots leave secret files out", async () => {
    const { git, workTree } = await repository();
    await writeFile(join(workTree, "app.ts"), "app\n");
    await writeFile(join(workTree, ".envrc"), "export TOKEN=1\n");
    await writeFile(join(workTree, "server.pem"), "pem\n");
    const head = await git.snapshot("local");
    const diff = await git.diff(null, head);
    expect(diff.files.map((file) => file.path)).toEqual(["app.ts"]);
  });

  test("applying history that still carries a secret file keeps the copy on disk", async () => {
    const { git, gitDir, workTree } = await repository();
    await writeFile(join(workTree, "server.pem"), "mine\n");
    await git.baseline();
    const incoming = legacyCommit(gitDir, { "app.ts": "app\n", "server.pem": "theirs\n" });
    const head = await git.applyTree(`${incoming}^{tree}`, [incoming], "merge");
    expect(await readFile(join(workTree, "server.pem"), "utf8")).toBe("mine\n");
    expect(await readFile(join(workTree, "app.ts"), "utf8")).toBe("app\n");
    const listed = execFileSync("git", ["--git-dir", gitDir, "ls-tree", "-r", "--name-only", head])
      .toString("utf8")
      .trim();
    expect(listed).toBe("app.ts");
  });

  test("a secret file that drops out of history is not deleted from disk", async () => {
    const { git, gitDir, workTree } = await repository();
    const before = legacyCommit(gitDir, { "app.ts": "app\n", ".envrc": "export TOKEN=1\n" });
    await writeFile(join(workTree, "app.ts"), "app\n");
    await writeFile(join(workTree, ".envrc"), "export TOKEN=1\n");
    // The older version had the file in its index, which is what used to make
    // `read-tree -u` delete it once a newer tree no longer listed it.
    execFileSync("git", ["--git-dir", gitDir, "read-tree", before], {
      env: { ...process.env, GIT_INDEX_FILE: shadowIndexPath(gitDir) },
    });
    const after = legacyCommit(gitDir, { "app.ts": "app\nchanged\n" }, before);
    await git.applyTree(`${after}^{tree}`, [after], "merge");
    expect(await readFile(join(workTree, ".envrc"), "utf8")).toBe("export TOKEN=1\n");
    const diff = await git.diff(before, after);
    expect(diff.files.map((file) => file.path)).toEqual(["app.ts"]);
  });

  test("restoring an older head does not write its secret files", async () => {
    const { git, gitDir, workTree } = await repository();
    await writeFile(join(workTree, ".env"), "LOCAL=1\n");
    const older = legacyCommit(gitDir, { "app.ts": "app\n", ".env": "OLD=1\n" });
    await git.restoreHead(older);
    expect(await readFile(join(workTree, ".env"), "utf8")).toBe("LOCAL=1\n");
    expect(await git.head()).toBe(older);
  });

  test("merges ignore secret files that only one side still carries", async () => {
    const { git, gitDir } = await repository();
    const base = legacyCommit(gitDir, { "app.ts": "app\n", "tls.key": "base\n" });
    const ours = legacyCommit(gitDir, { "app.ts": "app\n" }, base);
    const theirs = legacyCommit(gitDir, { "app.ts": "app\n", "tls.key": "changed\n" }, base);
    const merge = await git.mergeTree(base, ours, theirs);
    expect(merge.clean).toBe(true);
    const listed = execFileSync("git", [
      "--git-dir",
      gitDir,
      "ls-tree",
      "-r",
      "--name-only",
      merge.tree ?? "",
    ])
      .toString("utf8")
      .trim();
    expect(listed).toBe("app.ts");
  });
});
