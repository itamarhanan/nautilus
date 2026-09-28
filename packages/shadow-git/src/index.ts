import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  type ConflictChange,
  isGeneratedFile,
  type SyncBundle,
  type SyncDiff,
  type SyncDiffHunk,
  type SyncDiffLine,
  type SyncFileChange,
} from "@nautilus/types";

export { LockBusyError, pruneFiles, readJson, withLock, writeJson } from "./durable";

const environment = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Nautilus",
  GIT_AUTHOR_EMAIL: "sync@nautilus.local",
  GIT_COMMITTER_NAME: "Nautilus",
  GIT_COMMITTER_EMAIL: "sync@nautilus.local",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};
const ignoredNames = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "coverage",
  ".turbo",
  ".vite",
  ".nautilus",
  "target",
  ".svelte-kit",
  ".nuxt",
  ".output",
  ".parcel-cache",
  ".cache",
  "__pycache__",
  ".venv",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  ".terraform",
]);
const ignoredFiles = /^\.env(?:\..*)?$|\.log$/;

const headRef = "refs/nautilus/head";
const baselineRef = "refs/nautilus/baseline";

const legacyRefs: readonly (readonly [legacy: string, current: string])[] = [
  ["refs/heads/lines/default/head", headRef],
  ["refs/heads/lines/default/baseline", baselineRef],
  ["refs/heads/nautilus", headRef],
  ["refs/heads/nautilus-baseline", baselineRef],
];

const maxFileDiffLines = 3_000;
const maxFileDiffBytes = 1_000_000;

export const commitPattern = /^[0-9a-f]{40,64}$/;

const maxMessageLength = 500;

export const shadowIndexPath = (gitDir: string): string =>
  join(resolve(gitDir), "nautilus", "index");

const shadowExcludePath = (gitDir: string): string => join(resolve(gitDir), "nautilus", "exclude");

const legacyStatePath = (gitDir: string, file: string): string =>
  join(resolve(gitDir), "nautilus", "lines", "default", file);

function isRepositoryPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git")
  );
}

export class ShadowGitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ShadowGitError";
  }
}

export type MergePick = "ours" | "theirs";

type MergeEntry = { mode: string; oid: string };
type MergeStages = {
  base?: MergeEntry;
  ours?: MergeEntry;
  theirs?: MergeEntry;
};

export type MergeConflict = {
  path: string;
  reason: "content_conflict" | "delete_conflict" | "add_conflict";
  ours: ConflictChange;
  theirs: ConflictChange;
};

export type MergeResult = {
  clean: boolean;
  tree?: string;
  conflicts?: MergeConflict[];
};

export type ShadowGitLimits = {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFileCount: number;

  maxBundleBytes: number;

  commandTimeoutMs: number;
};

export type ShadowGitValidation = {
  valid: boolean;
  dirty: boolean;
  head: string | null;
  error: string | null;
};

export class ShadowGit {
  private readonly gitDir: string;
  private readonly workTree: string;
  private readonly indexPath: string;
  private readonly excludePath: string;
  private readonly limits: ShadowGitLimits;

  constructor(options: {
    gitDir: string;
    workTree: string;
    limits?: Partial<ShadowGitLimits> | undefined;
  }) {
    this.gitDir = resolve(options.gitDir);
    this.workTree = resolve(options.workTree);
    this.indexPath = shadowIndexPath(this.gitDir);
    this.excludePath = shadowExcludePath(this.gitDir);
    this.limits = {
      maxFileBytes: options.limits?.maxFileBytes ?? 10_000_000,
      maxTotalBytes: options.limits?.maxTotalBytes ?? 100_000_000,
      maxFileCount: options.limits?.maxFileCount ?? 10_000,
      maxBundleBytes: options.limits?.maxBundleBytes ?? 100_000_000,
      commandTimeoutMs: options.limits?.commandTimeoutMs ?? 300_000,
    };
  }

  private async git(args: string[], extraEnvironment: NodeJS.ProcessEnv = {}): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        "git",
        [
          "-c",
          `core.excludesFile=${this.excludePath}`,
          "--git-dir",
          this.gitDir,
          "--work-tree",
          this.workTree,
          ...args,
        ],
        {
          cwd: this.workTree,
          env: {
            ...environment,
            GIT_INDEX_FILE: this.indexPath,
            ...extraEnvironment,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.limits.commandTimeoutMs);
      timer.unref();
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new ShadowGitError("git_timeout", `git ${args[0] ?? ""} timed out`));
          return;
        }

        if (code === 0) {
          resolve(Buffer.concat(chunks));
          return;
        }
        const message =
          Buffer.concat(errors).toString("utf8").trim() ||
          Buffer.concat(chunks).toString("utf8").trim();
        reject(
          new ShadowGitError(
            "git_command_failed",
            message || `git exited with code ${String(code)}`,
          ),
        );
      });
    });
  }

  async initialize(): Promise<void> {
    // git runs inside the work tree, and Node reports a missing cwd as the
    // misleading "spawn git ENOENT", so a missing project folder is named here.
    const workTree = await stat(this.workTree).catch(() => undefined);
    if (!workTree?.isDirectory()) {
      throw new ShadowGitError("worktree_missing", `project folder ${this.workTree} does not exist`);
    }
    await mkdir(dirname(this.indexPath), { recursive: true, mode: 0o700 });
    await mkdir(this.gitDir, { recursive: true, mode: 0o700 });
    try {
      await this.git(["rev-parse", "--git-dir"]);
    } catch {
      await new Promise<void>((resolveInit, reject) => {
        const child = spawn("git", ["init", "--bare", this.gitDir], {
          cwd: this.workTree,
          env: { ...environment, GIT_INDEX_FILE: this.indexPath },
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code === 0) {
            resolveInit();
          } else {
            reject(
              new ShadowGitError("git_command_failed", `git init exited with code ${String(code)}`),
            );
          }
        });
      });
    }
    await this.adoptLegacyLayout();
    await mkdir(join(this.gitDir, "info"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(this.gitDir, "info", "exclude"),
      [...ignoredNames].map((name) => `${name}/`).join("\n") + "\n.env\n.env.*\n*.log\n",
      { mode: 0o600 },
    );
    await this.ensureIndex();
  }

  private async adoptLegacyLayout(): Promise<void> {
    for (const [legacy, current] of legacyRefs) {
      if ((await this.ref(current)) !== null) continue;
      const adopted = await this.ref(legacy);
      if (adopted === null) continue;
      await this.git(["update-ref", current, adopted]);
    }
    for (const [legacy, current] of [
      [legacyStatePath(this.gitDir, "index"), this.indexPath],
      [legacyStatePath(this.gitDir, "exclude"), this.excludePath],
    ] as const) {
      if ((await stat(current).catch(() => null)) !== null) continue;
      await rename(legacy, current).catch(() => undefined);
    }
  }

  private async ensureIndex(): Promise<void> {
    if ((await stat(this.indexPath).catch(() => null)) !== null) return;
    const current = await this.head();
    if (current === null) return;
    await this.git(["read-tree", current]);

    await this.git(["update-index", "--really-refresh"]).catch(() => undefined);
  }

  async excludedRepositories(): Promise<string[]> {
    const contents = await readFile(this.excludePath, "utf8").catch(() => "");
    return contents
      .split("\n")
      .map((line) => line.trim().replace(/\/$/, ""))
      .filter(Boolean);
  }

  async validate(): Promise<ShadowGitValidation> {
    try {
      await this.initialize();
      await this.git(["fsck", "--full", "--no-progress"]);
      return {
        valid: true,
        dirty: !(await this.isClean()),
        head: await this.head(),
        error: null,
      };
    } catch (error) {
      return {
        valid: false,
        dirty: false,
        head: null,
        error: error instanceof Error ? error.message : "shadow_validation_failed",
      };
    }
  }

  async head(): Promise<string | null> {
    return this.ref(headRef);
  }

  private async stage(): Promise<void> {
    const ignored = await this.ignoredPaths();
    const excluded = await this.scan(new Set([...ignored.untracked, ...ignored.tracked]));

    await writeFile(this.excludePath, excluded.map((path) => `${path}/`).join("\n"), {
      mode: 0o600,
    });
    for (const path of excluded) {
      await this.git(["update-index", "--force-remove", "--", path]).catch(() => undefined);
    }

    for (let start = 0; start < ignored.tracked.length; start += 500) {
      await this.git([
        "update-index",
        "--force-remove",
        "--",
        ...ignored.tracked.slice(start, start + 500),
      ]);
    }

    await this.validateIndex();
    await this.git(["add", "--all", "--", "."]);
    await this.validateIndex();
  }

  async baseline(): Promise<string> {
    await this.initialize();
    const existing = await this.ref(baselineRef);
    if (existing !== null) return existing;
    await this.stage();
    await this.validateIndex();
    const tree = (await this.git(["write-tree"])).toString("utf8").trim();
    const commit = (
      await this.git(["commit-tree", tree, "-m", "Nautilus synchronization baseline"])
    )
      .toString("utf8")
      .trim();
    await this.git(["update-ref", baselineRef, commit]);
    if ((await this.head()) === null) await this.git(["update-ref", headRef, commit]);
    return commit;
  }

  async mergeBase(): Promise<string> {
    await this.initialize();
    const tree = (await this.git(["mktree"])).toString("utf8").trim();
    return (await this.git(["commit-tree", tree, "-m", "Nautilus synchronization merge base"]))
      .toString("utf8")
      .trim();
  }

  private async ref(reference: string): Promise<string | null> {
    try {
      const value = (await this.git(["rev-parse", reference])).toString("utf8").trim();
      return commitPattern.test(value) ? value : null;
    } catch {
      return null;
    }
  }

  async isClean(): Promise<boolean> {
    await this.initialize();
    const current = await this.head();
    if (current !== null) {
      try {
        await this.git(["diff", "--quiet", current, "--"]);
      } catch {
        return false;
      }
    }
    return (await this.git(["ls-files", "--others", "--exclude-standard"])).length === 0;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.git(["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  private async verifyBundle(path: string): Promise<void> {
    try {
      await this.git(["bundle", "verify", path]);
    } catch (error) {
      const message = error instanceof ShadowGitError ? error.message : String(error);
      if (message.includes("lacks these prerequisite commits"))
        throw new ShadowGitError(
          "bundle_prerequisites_missing",
          "Bundle requires commits this repository does not have",
        );
      throw error;
    }
  }

  async snapshot(message: string): Promise<string> {
    await this.baseline();
    await this.stage();
    await this.validateIndex();
    const tree = (await this.git(["write-tree"])).toString("utf8").trim();
    const current = await this.head();
    if (current !== null) {
      const currentTree = (await this.git(["rev-parse", `${current}^{tree}`]))
        .toString("utf8")
        .trim();
      if (currentTree === tree) return current;
    }
    const parents = current === null ? [] : ["-p", current];
    const commit = (
      await this.git(["commit-tree", tree, ...parents, "-m", message.slice(0, maxMessageLength)])
    )
      .toString("utf8")
      .trim();
    await this.git(["update-ref", headRef, commit]);
    return commit;
  }

  async createBundle(
    head: string,
    directory: string,
    baseHead: string | null,
  ): Promise<SyncBundle> {
    const path = join(directory, `${head}.bundle`);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    const incremental =
      baseHead !== null &&
      commitPattern.test(baseHead) &&
      baseHead !== head &&
      (await this.isAncestor(baseHead, head));
    const args = ["bundle", "create", path, headRef];
    if (incremental) args.push(`^${baseHead}`);
    await this.git(args);
    await this.git(["bundle", "verify", path]);
    const bytes = await readFile(path);
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      head,
    };
  }

  async importBundle(bundle: SyncBundle, baseHead: string | null): Promise<string> {
    if (bundle.bytes.length > this.limits.maxBundleBytes)
      throw new ShadowGitError("bundle_too_large", "Bundle exceeds the configured size limit");
    if (createHash("sha256").update(bundle.bytes).digest("hex") !== bundle.sha256)
      throw new ShadowGitError("bundle_digest_mismatch", "Bundle digest does not match");
    if (!commitPattern.test(bundle.head))
      throw new ShadowGitError("invalid_bundle_head", "Bundle head is invalid");
    const directory = await mkdtemp(join(tmpdir(), "nautilus-bundle-"));
    const path = join(directory, "incoming.bundle");
    try {
      await writeFile(path, bundle.bytes, { mode: 0o600 });
      await this.verifyBundle(path);
      await this.git(["fetch", "--no-tags", path, headRef]);
      const fetched = (await this.git(["rev-parse", "FETCH_HEAD"])).toString("utf8").trim();
      if (fetched !== bundle.head)
        throw new ShadowGitError(
          "bundle_head_mismatch",
          "Imported bundle did not produce the requested head",
        );
      await this.validateTree(bundle.head);
      if (baseHead !== null && !(await this.isAncestor(baseHead, bundle.head)))
        throw new ShadowGitError(
          "invalid_bundle_ancestry",
          "Bundle is not based on the synchronized base",
        );
      return bundle.head;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async changedPaths(baseHead: string | null): Promise<string[]> {
    await this.initialize();
    const paths = new Set<string>();
    const current = await this.head();
    if (baseHead && current && baseHead !== current) {
      const committed = (await this.git(["diff", "--name-only", "-z", baseHead, current])).toString(
        "utf8",
      );
      for (const path of committed.split("\0")) if (path) paths.add(path);
    }
    if (current === null) {
      const untracked = await this.git(["ls-files", "--others", "--exclude-standard", "-z"]);
      for (const path of untracked.toString("utf8").split("\0")) if (path) paths.add(path);
      return [...paths].sort();
    }

    const status = (
      await this.git(["diff", "--name-status", "-z", "--find-renames", current, "--"])
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean);

    for (let index = 0; index < status.length;) {
      const code = status[index] ?? "";
      const path = status[index + 1] ?? "";
      if (!path) break;
      paths.add(path);
      index += code.startsWith("R") || code.startsWith("C") ? 3 : 2;
    }
    const untracked = await this.git(["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const path of untracked.toString("utf8").split("\0")) if (path) paths.add(path);
    return [...paths].sort();
  }

  async diff(baseHead: string | null, head: string): Promise<SyncDiff> {
    const base = baseHead ?? (await this.emptyTree());
    const changes = parseNameStatus(
      (await this.git(["diff", "--name-status", "-z", "--find-renames", base, head])).toString(
        "utf8",
      ),
    );
    const statistics = parseNumstat(
      (await this.git(["diff", "--numstat", "-z", "--find-renames", base, head])).toString("utf8"),
    );
    let additions = 0;
    let deletions = 0;
    for (const statistic of statistics.values()) {
      additions += statistic.additions;
      deletions += statistic.deletions;
    }
    const files: SyncFileChange[] = changes.slice(0, 1_000).map((change) => {
      const statistic = statistics.get(change.path);
      return {
        ...change,
        binary: statistic?.binary ?? false,
        additions: statistic?.additions ?? 0,
        deletions: statistic?.deletions ?? 0,
        hunks: [],
      };
    });

    for (const file of files) {
      if (file.binary || file.additions + file.deletions === 0) continue;
      if (isGeneratedFile(file.path)) {
        file.omitted = "generated";
        continue;
      }
      if (file.additions + file.deletions > maxFileDiffLines) {
        file.omitted = "large";
        continue;
      }
      const output = await this.git([
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--unified=3",
        "--find-renames",
        base,
        head,
        "--",
        file.path,
      ]);

      if (output.length > maxFileDiffBytes) {
        file.omitted = "large";
        continue;
      }
      file.hunks = parseUnifiedDiff(output.toString("utf8"), Number.POSITIVE_INFINITY).hunks;
    }
    return { files, additions, deletions };
  }

  async compareWorktreeFile(commit: string, path: string): Promise<SyncFileChange> {
    if (!isRepositoryPath(path)) throw new ShadowGitError("invalid_path", "Path is not valid");
    await this.git(["cat-file", "-e", `${commit}^{commit}`]).catch(() => {
      throw new ShadowGitError("unknown_commit", "That version is not on this machine");
    });
    const local = await lstat(join(this.workTree, path)).catch(() => null);
    if (local && !local.isFile())
      throw new ShadowGitError("invalid_path", "Only regular files can be compared");
    const theirs = await this.git(["rev-parse", "--verify", "--quiet", `${commit}:${path}`]).then(
      (output) => output.toString("utf8").trim(),
      () => null,
    );
    const empty = await this.emptyBlob();
    const ours = local
      ? (await this.git(["hash-object", "-w", "--", path])).toString("utf8").trim()
      : empty;
    const file: SyncFileChange = {
      path,
      status: !local ? "added" : theirs === null ? "deleted" : "modified",
      binary: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    };
    const theirsBlob = theirs ?? empty;
    if (ours === theirsBlob) return file;
    const statistic = parseNumstat(
      (await this.git(["diff", "--numstat", "-z", ours, theirsBlob])).toString("utf8"),
    )
      .values()
      .next().value;
    file.binary = statistic?.binary ?? false;
    file.additions = statistic?.additions ?? 0;
    file.deletions = statistic?.deletions ?? 0;
    if (file.binary) return file;
    if (file.additions + file.deletions > maxFileDiffLines) {
      file.omitted = "large";
      return file;
    }
    const output = await this.git([
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--unified=3",
      ours,
      theirsBlob,
    ]);
    if (output.length > maxFileDiffBytes) {
      file.omitted = "large";
      return file;
    }
    file.hunks = parseUnifiedDiff(output.toString("utf8"), Number.POSITIVE_INFINITY).hunks;
    return file;
  }

  async mergeTree(
    baseHead: string,
    oursHead: string,
    theirsHead: string,
    picks: Readonly<Record<string, MergePick>> = {},
  ): Promise<MergeResult> {
    const directory = await mkdtemp(join(tmpdir(), "nautilus-index-"));
    const indexEnvironment = { GIT_INDEX_FILE: join(directory, "index") };
    try {
      await this.validateTree(oursHead);
      await this.validateTree(theirsHead);

      await this.git(
        ["read-tree", "-m", "--aggressive", baseHead, oursHead, theirsHead],
        indexEnvironment,
      );
      const conflicts: MergeConflict[] = [];
      for (const [path, stages] of await this.unmergedStages(indexEnvironment)) {
        const conflict = await this.resolvePath(
          path,
          stages,
          picks[path],
          directory,
          indexEnvironment,
        );
        if (conflict) conflicts.push(conflict);
      }
      if (conflicts.length > 0) return { clean: false, conflicts };
      const tree = (await this.git(["write-tree"], indexEnvironment)).toString("utf8").trim();
      await this.validateTree(tree);
      return { clean: true, tree };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async unmergedStages(
    indexEnvironment: NodeJS.ProcessEnv,
  ): Promise<Map<string, MergeStages>> {
    const output = (await this.git(["ls-files", "--unmerged", "-z"], indexEnvironment)).toString(
      "utf8",
    );
    const paths = new Map<string, MergeStages>();
    for (const entry of output.split("\0").filter(Boolean)) {
      const [metadata, path] = entry.split("\t", 2);
      const [mode, oid, stage] = (metadata ?? "").split(" ");

      if (!metadata || !path || !mode || !oid || !stage) {
        throw new ShadowGitError("unmerged_index_unreadable", "The index has an unreadable entry");
      }
      const stages = paths.get(path) ?? {};
      if (stage === "1") stages.base = { mode, oid };
      if (stage === "2") stages.ours = { mode, oid };
      if (stage === "3") stages.theirs = { mode, oid };
      paths.set(path, stages);
    }
    return paths;
  }

  private async resolvePath(
    path: string,
    { base, ours, theirs }: MergeStages,
    pick: MergePick | undefined,
    directory: string,
    indexEnvironment: NodeJS.ProcessEnv,
  ): Promise<MergeConflict | null> {
    if (pick) {
      await this.setIndexEntry(path, pick === "ours" ? ours : theirs, indexEnvironment);
      return null;
    }
    if (base && ours && theirs) {
      const merged = await this.mergeFile(base, ours, theirs, directory);
      if (merged) {
        const mode = ours.mode === base.mode ? theirs.mode : ours.mode;
        await this.setIndexEntry(path, { mode, oid: merged }, indexEnvironment);
        return null;
      }
    }
    const change = (entry: MergeEntry | undefined): ConflictChange =>
      entry === undefined ? "deleted" : base === undefined ? "added" : "modified";
    return {
      path,
      reason:
        base === undefined
          ? "add_conflict"
          : ours && theirs
            ? "content_conflict"
            : "delete_conflict",
      ours: change(ours),
      theirs: change(theirs),
    };
  }

  private async writeMergeBlob(entry: MergeEntry, path: string): Promise<string> {
    await writeFile(path, await this.git(["cat-file", "blob", entry.oid]), {
      mode: 0o600,
    });
    return path;
  }

  private async mergeFile(
    base: MergeEntry,
    ours: MergeEntry,
    theirs: MergeEntry,
    directory: string,
  ): Promise<string | null> {
    const [oursPath, basePath, theirsPath] = await Promise.all([
      this.writeMergeBlob(ours, join(directory, "merge-0")),
      this.writeMergeBlob(base, join(directory, "merge-1")),
      this.writeMergeBlob(theirs, join(directory, "merge-2")),
    ]);
    try {
      await this.git(["merge-file", "-q", oursPath, basePath, theirsPath]);
    } catch {
      return null;
    }
    return (await this.git(["hash-object", "-w", "--no-filters", oursPath]))
      .toString("utf8")
      .trim();
  }

  private async setIndexEntry(
    path: string,
    entry: MergeEntry | undefined,
    indexEnvironment: NodeJS.ProcessEnv,
  ): Promise<void> {
    await this.git(["update-index", "--force-remove", "--", path], indexEnvironment);
    if (entry) {
      await this.git(
        ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.oid},${path}`],
        indexEnvironment,
      );
    }
  }

  async applyTree(tree: string, parents: string[], message: string): Promise<string> {
    const uniqueParents = [...new Set(parents)];
    const commit = (
      await this.git([
        "commit-tree",
        tree,
        ...uniqueParents.flatMap((parent) => ["-p", parent]),
        "-m",
        message.slice(0, maxMessageLength),
      ])
    )
      .toString("utf8")
      .trim();
    await this.git(["read-tree", "-u", "--reset", tree]);
    await this.git(["update-ref", headRef, commit]);
    return commit;
  }

  async restoreHead(head: string): Promise<void> {
    await this.git(["read-tree", "-u", "--reset", head]);
    await this.git(["update-ref", headRef, head]);
  }

  private async emptyBlob(): Promise<string> {
    const path = join(this.gitDir, "nautilus", "empty");
    await writeFile(path, "", { flag: "a" });
    return (await this.git(["hash-object", "-w", "--no-filters", path])).toString("utf8").trim();
  }

  private async emptyTree(): Promise<string> {
    return (await this.git(["mktree"])).toString("utf8").trim();
  }

  private async validateIndex(): Promise<void> {
    const entries = (await this.git(["ls-files", "-s", "-z"])).toString("utf8");
    for (const entry of entries.split("\0").filter(Boolean)) {
      const [metadata, path] = entry.split("\t", 2);
      const mode = metadata?.split(" ", 1)[0];

      if (mode === undefined || path === undefined)
        throw new ShadowGitError("unsupported_tree_mode", "Tree entry could not be read");
      if (mode === "160000")
        throw new ShadowGitError("submodule_rejected", `Submodule is not synchronizable: ${path}`);
      if (mode !== "100644" && mode !== "100755")
        throw new ShadowGitError(
          "unsupported_tree_mode",
          `Tree entry is not a regular file: ${path}`,
        );
    }
  }

  private async validateTree(head: string): Promise<void> {
    const entries = (await this.git(["ls-tree", "-r", "-z", "--full-tree", head])).toString("utf8");
    for (const entry of entries.split("\0").filter(Boolean)) {
      const [metadata, path] = entry.split("\t", 2);
      const mode = metadata?.split(" ", 1)[0];
      if (mode === undefined || path === undefined)
        throw new ShadowGitError("unsupported_tree_mode", "Tree entry could not be read");
      const segments = path.split("/");
      if (mode === "160000")
        throw new ShadowGitError("submodule_rejected", `Submodule is not synchronizable: ${path}`);
      if (mode !== "100644" && mode !== "100755")
        throw new ShadowGitError(
          "unsupported_tree_mode",
          `Tree entry is not a regular file: ${path}`,
        );
      if (segments.at(-1) === ".gitmodules")
        throw new ShadowGitError("gitmodules_rejected", ".gitmodules is not synchronizable");

      if (segments.length > 1 && segments.slice(0, -1).includes(".git"))
        throw new ShadowGitError(
          "nested_git_rejected",
          `Received Git metadata is not synchronizable: ${path}`,
        );
    }
  }

  private async ignoredPaths(): Promise<{
    untracked: string[];
    tracked: string[];
  }> {
    const list = async (args: string[]): Promise<string[]> =>
      (
        await this.git([
          "-c",
          `core.excludesFile=${join(this.gitDir, "info", "exclude")}`,
          "ls-files",
          "--ignored",
          "--exclude-standard",
          "-z",
          ...args,
        ])
      )
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((path) => path.replace(/\/$/, ""));
    return {
      untracked: await list(["--others", "--directory", "--no-empty-directory"]),
      tracked: await list(["--cached"]),
    };
  }

  private async scan(ignored: ReadonlySet<string>): Promise<string[]> {
    let count = 0;
    let totalBytes = 0;
    const excluded: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".gitmodules")
          throw new ShadowGitError("gitmodules_rejected", ".gitmodules is not synchronizable");
      }
      const repository = relative(this.workTree, directory).split(sep).join("/");
      if (repository !== "" && entries.some((entry) => entry.name === ".git")) {
        excluded.push(repository);
        return;
      }
      for (const entry of entries) {
        const absolute = join(directory, entry.name);
        const path = relative(this.workTree, absolute).split(sep).join("/");
        if (
          ignored.has(path) ||
          ignoredNames.has(entry.name) ||
          (entry.isFile() && ignoredFiles.test(entry.name))
        )
          continue;
        if (entry.isSymbolicLink())
          throw new ShadowGitError("symlink_rejected", `Symlink is not synchronizable: ${path}`);
        if (entry.isDirectory()) {
          await visit(absolute);
          continue;
        }
        if (!entry.isFile())
          throw new ShadowGitError(
            "special_file_rejected",
            `Special file is not synchronizable: ${path}`,
          );
        const file = await stat(absolute);
        count += 1;
        totalBytes += file.size;
        if (file.size > this.limits.maxFileBytes || totalBytes > this.limits.maxTotalBytes)
          throw new ShadowGitError(
            "file_too_large",
            `Synchronized file exceeds the configured size limit: ${path}. Add it to .gitignore to leave it out of synchronization.`,
          );
        if (count > this.limits.maxFileCount)
          throw new ShadowGitError(
            "too_many_files",
            "Synchronized file count exceeds the configured limit",
          );
        const prefix = await readFile(absolute)
          .then((bytes) => bytes.subarray(0, 200).toString("utf8"))
          .catch(() => "");
        if (prefix.startsWith("version https://git-lfs.github.com/spec/v1"))
          throw new ShadowGitError(
            "lfs_pointer_rejected",
            `Git LFS pointer is not synchronizable: ${path}`,
          );
      }
    };
    await visit(this.workTree);
    return excluded;
  }
}

type DiffStatistic = {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
};

function parseNameStatus(
  output: string,
): Omit<SyncFileChange, "binary" | "additions" | "deletions" | "hunks">[] {
  const entries = output.split("\0").filter((part) => part.length > 0);
  const changes: Omit<SyncFileChange, "binary" | "additions" | "deletions" | "hunks">[] = [];
  let index = 0;
  while (index < entries.length) {
    const code = entries[index++];
    if (!code) continue;
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = entries[index++];
      const path = entries[index++];
      if (oldPath && path) changes.push({ path, oldPath, status: "renamed" });
      continue;
    }
    const path = entries[index++];
    if (path)
      changes.push({
        path,
        status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified",
      });
  }
  return changes;
}

function parseNumstat(output: string): Map<string, DiffStatistic> {
  const entries = output.split("\0").filter((part) => part.length > 0);
  const statistics = new Map<string, DiffStatistic>();
  let index = 0;
  while (index < entries.length) {
    const fields = entries[index++]?.split("\t") ?? [];
    const [additionsField, deletionsField, first] = fields;
    if (additionsField === undefined || deletionsField === undefined || first === undefined)
      continue;
    let path = first;
    if (path === "") {
      index += 1;
      path = entries[index++] ?? "";
      if (!path) continue;
    }
    const additions = /^\d+$/.test(additionsField) ? Number(additionsField) : 0;
    const deletions = /^\d+$/.test(deletionsField) ? Number(deletionsField) : 0;
    statistics.set(path, {
      path,
      additions,
      deletions,
      binary: additionsField === "-" || deletionsField === "-",
    });
  }
  return statistics;
}

function parseUnifiedDiff(output: string, limit: number): { hunks: SyncDiffHunk[]; lines: number } {
  const hunks: SyncDiffHunk[] = [];
  let current: SyncDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let count = 0;
  for (const raw of output.split("\n")) {
    const hunk = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      current = {
        oldStart: Number(hunk[1]),
        oldLines: Number(hunk[2] || 1),
        newStart: Number(hunk[3]),
        newLines: Number(hunk[4] || 1),
        lines: [],
      };
      oldLine = current.oldStart;
      newLine = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current || count >= limit) continue;
    const type = raw.startsWith("+")
      ? "addition"
      : raw.startsWith("-")
        ? "deletion"
        : raw.startsWith(" ")
          ? "context"
          : null;
    if (!type) continue;
    const line: SyncDiffLine = {
      type,
      oldLine: type === "addition" ? null : oldLine,
      newLine: type === "deletion" ? null : newLine,
      content: raw.slice(1),
    };
    current.lines.push(line);
    if (type !== "addition") oldLine += 1;
    if (type !== "deletion") newLine += 1;
    count += 1;
  }
  return { hunks, lines: count };
}
