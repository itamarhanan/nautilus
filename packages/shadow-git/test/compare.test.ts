import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ShadowGit } from "../src/index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<{ git: ShadowGit; workTree: string }> {
  const root = await mkdtemp(join(tmpdir(), "nautilus-compare-"));
  roots.push(root);
  const workTree = join(root, "work");
  await mkdir(workTree);
  const git = new ShadowGit({ gitDir: join(root, "shadow.git"), workTree });
  await git.initialize();
  return { git, workTree };
}

describe("compareWorktreeFile", () => {
  test("reads from the worktree file to the commit's version", async () => {
    const { git, workTree } = await repository();
    await writeFile(join(workTree, "app.ts"), "one\ntwo\n");
    const commit = await git.snapshot("runner");
    await writeFile(join(workTree, "app.ts"), "one\nlocal\n");
    const file = await git.compareWorktreeFile(commit, "app.ts");
    expect(file).toMatchObject({ path: "app.ts", status: "modified", additions: 1, deletions: 1 });
    const lines = file.hunks.flatMap((hunk) => hunk.lines);
    expect(lines).toContainEqual(expect.objectContaining({ type: "deletion", content: "local" }));
    expect(lines).toContainEqual(expect.objectContaining({ type: "addition", content: "two" }));
  });

  test("treats a side without the file as empty", async () => {
    const { git, workTree } = await repository();
    await writeFile(join(workTree, "keep.ts"), "keep\n");
    const commit = await git.snapshot("runner");
    await writeFile(join(workTree, "local-only.ts"), "mine\n");
    expect(await git.compareWorktreeFile(commit, "local-only.ts")).toMatchObject({
      status: "deleted",
      deletions: 1,
      additions: 0,
    });
    await rm(join(workTree, "keep.ts"));
    expect(await git.compareWorktreeFile(commit, "keep.ts")).toMatchObject({
      status: "added",
      additions: 1,
      deletions: 0,
    });
  });

  test("refuses paths outside the worktree and links", async () => {
    const { git, workTree } = await repository();
    await writeFile(join(workTree, "a.ts"), "a\n");
    const commit = await git.snapshot("runner");
    await symlink("/etc/passwd", join(workTree, "link"));
    await expect(git.compareWorktreeFile(commit, "../a.ts")).rejects.toThrow("not valid");
    await expect(git.compareWorktreeFile(commit, "/etc/passwd")).rejects.toThrow("not valid");
    await expect(git.compareWorktreeFile(commit, ".git/config")).rejects.toThrow("not valid");
    await expect(git.compareWorktreeFile(commit, "link")).rejects.toThrow("regular files");
  });
});
