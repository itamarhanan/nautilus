import { spawn } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";

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

const headRef = "refs/nautilus/head";
const baselineRef = "refs/nautilus/baseline";

const legacyRefs: readonly (readonly [legacy: string, current: string])[] = [
  ["refs/heads/lines/default/head", headRef],
  ["refs/heads/lines/default/baseline", baselineRef],
  ["refs/heads/nautilus", headRef],
  ["refs/heads/nautilus-baseline", baselineRef],
];

export const commitPattern = /^[0-9a-f]{40,64}$/;

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
}
