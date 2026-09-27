import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep, dirname } from "node:path";

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

export const commitPattern = /^[0-9a-f]{40,64}$/;

const maxMessageLength = 500;

export const shadowIndexPath = (gitDir: string): string =>
  join(resolve(gitDir), "nautilus", "index");

const shadowExcludePath = (gitDir: string): string => join(resolve(gitDir), "nautilus", "exclude");

const legacyStatePath = (gitDir: string, file: string): string =>
  join(resolve(gitDir), "nautilus", "lines", "default", file);

export class ShadowGitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ShadowGitError";
  }
}

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
