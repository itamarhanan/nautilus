import { spawn, type ChildProcess } from "node:child_process";
import { readFile, readlink, realpath, stat } from "node:fs/promises";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { join, sep } from "node:path";
import type { Readable } from "node:stream";
import type { ProjectConfig, ProjectRecord } from "@nautilus/types";
import { baseEnvironment } from "./environment";
import { HttpError } from "./errors";
import { pickListener, sessionListeners, sessionMembers } from "./listeners";
import type { Logger } from "./logger";
import type { Registry } from "./registry";

type ActiveProject = {
  child: ChildProcess;
  stopping: boolean;
};

const OUTPUT_TAIL_BYTES = 4096;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
// Saving several keys in a row, or pushing code and keys together, lands as
// one restart rather than one per change.
const RESTART_DELAY_MS = 1500;
// Resolved against the package root, from src/ as from the dist/ bundle, the
// same way app.ts finds package.json.
const devPortShim = new URL("../dev-port-shim.mjs", import.meta.url);

function captureOutputTail(...streams: (Readable | null)[]): () => string {
  let tail = "";
  for (const stream of streams) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-OUTPUT_TAIL_BYTES);
    });
  }
  return () => tail.trim();
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

// A dev server that exits because its port is taken says so in its output.
function portInUse(output: string): string | undefined {
  const port = /EADDRINUSE[^\n]*?:(\d{2,5})\b/.exec(output)?.[1];
  return port === undefined ? undefined : `dev_port_in_use:${port}`;
}

// Stops what is left of a dev server's session. A folder limits it to
// processes working inside that project, for a session recorded before the
// runner restarted, whose number the system may since have given to another.
async function stopSession(sessionId: number, folder?: string): Promise<number> {
  const members = async (): Promise<number[]> => {
    const pids = [...(await sessionMembers(sessionId)).keys()].filter((pid) => pid !== process.pid);
    if (folder === undefined) return pids;
    const inside: number[] = [];
    for (const pid of pids) {
      const cwd = await readlink(`/proc/${String(pid)}/cwd`).catch(() => undefined);
      if (cwd !== undefined && (cwd === folder || cwd.startsWith(`${folder}${sep}`))) {
        inside.push(pid);
      }
    }
    return inside;
  };
  const signal = (pids: number[], name: NodeJS.Signals): void => {
    for (const pid of pids) {
      try {
        process.kill(pid, name);
      } catch {
        // Already gone.
      }
    }
  };
  let pids = await members();
  const found = pids.length;
  if (found === 0) return 0;
  signal(pids, "SIGTERM");
  for (let waited = 0; waited < 3000; waited += 100) {
    await sleep(100);
    pids = await members();
    if (pids.length === 0) return found;
  }
  signal(pids, "SIGKILL");
  return found;
}

function parseDevCommand(command: string): {
  executable: string;
  args: string[];
} {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  const executable = parts.shift();
  if (!executable) {
    throw new HttpError(400, "invalid_dev_command", "Project dev command is empty");
  }
  return { executable, args: parts };
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

// Every Node process of the dev server loads the shim, so none of them takes
// one of the runner's ports or exits because a port it asked for is taken.
function devNodeOptions(inherited: string | undefined, reserved: readonly number[]): string {
  const shim = new URL(devPortShim);
  shim.searchParams.set("reserved", reserved.join(","));
  return [inherited, `--import=${shim.href}`].filter(Boolean).join(" ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDevServer(
  child: ChildProcess,
  port: number,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("dev_process_exited");
    }
    const session = child.pid;
    if (session !== undefined) {
      let listener = pickListener(await sessionListeners(session), port);
      if (listener && listener.port !== port) {
        await sleep(500);
        listener = pickListener(await sessionListeners(session), port) ?? listener;
      }
      if (listener) return `http://${listener.host}:${String(listener.port)}`;
    }
    if (await checkPort(port)) {
      return `http://127.0.0.1:${String(port)}`;
    }
    await sleep(100);
  }
  throw new Error("dev_server_timeout");
}

export class ProjectManager {
  private readonly active = new Map<string, ActiveProject>();
  // Leftovers still being stopped after a dev server exited. Shutting down
  // waits for them, so none of them writes to the registry after it closes.
  private readonly cleanups = new Set<Promise<void>>();
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private readonly restarts = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly registry: Registry,
    private readonly projects: Map<string, ProjectConfig>,
    private readonly logger: Logger,
    private readonly readyTimeoutMs: number,
    private readonly projectHasCode?: (projectId: string) => Promise<boolean>,
    // The ports of the runner's own services, which no dev server may take.
    private readonly reservedPorts: readonly number[] = [],
    // The preview values the desktop sent for a project.
    private readonly projectEnvironment?: (projectId: string) => Promise<Record<string, string>>,
  ) {}

  activeProject(): ProjectRecord | undefined {
    const id = this.registry.getActiveProjectId();
    return id ? this.registry.getProject(id) : undefined;
  }

  private async hasCode(projectId: string): Promise<boolean> {
    return (await this.projectHasCode?.(projectId)) ?? true;
  }

  // A dev server outlives a runner that stops without stopping it, and keeps
  // its port. This stops what is left of the ones recorded before the restart.
  async stopLeftovers(): Promise<void> {
    for (const { projectId, sessionId } of this.registry.devSessions()) {
      const project = this.projects.get(projectId);
      if (project) {
        const folder = await realpath(project.remotePath).catch(() => project.remotePath);
        const stopped = await stopSession(sessionId, folder);
        if (stopped > 0) {
          this.logger.info("project_leftover_stopped", { projectId, processes: stopped });
        }
      }
      this.registry.setDevSession(projectId, null);
    }
  }

  async recoverActiveProject(): Promise<ProjectRecord | undefined> {
    const id = this.registry.getActiveProjectId();
    if (!id) {
      return undefined;
    }
    const project = this.registry.getProject(id);
    if (!project || !this.projects.has(id) || project.state === "unhealthy") {
      if (project?.state !== "unhealthy") {
        this.registry.setActiveProjectId(null);
      }
      return undefined;
    }
    if (project.state === "inactive" || project.state === "stopped") {
      this.registry.setActiveProjectId(null);
      return undefined;
    }
    try {
      return await this.start(id);
    } catch (error) {
      this.logger.error("active_project_recovery_failed", {
        projectId: id,
        error: error instanceof Error ? error.message : "unknown_error",
      });
      return undefined;
    }
  }

  async start(id: string): Promise<ProjectRecord> {
    return this.serialized(() => this.startInternal(id));
  }

  private async startInternal(id: string): Promise<ProjectRecord> {
    const project = this.registry.getProject(id);
    const configured = this.projects.get(id);
    if (!project || !configured) {
      throw new HttpError(404, "project_not_found", "Project is not configured");
    }

    if (!(await this.hasCode(id))) {
      throw new HttpError(409, "project_not_synced", "Push this project once before starting it");
    }
    if (project.state === "unhealthy") {
      throw new HttpError(
        409,
        "project_unhealthy",
        "Project requires recovery before it can start",
      );
    }
    if (
      project.state === "running" ||
      project.state === "starting" ||
      project.state === "editing" ||
      project.state === "checkpointing"
    ) {
      throw new HttpError(409, "project_already_running", "Project is already running");
    }

    const activeId = this.registry.getActiveProjectId();
    if (activeId && activeId !== id) {
      await this.stopInternal(activeId);
    }
    if (this.active.has(id)) {
      throw new HttpError(409, "project_already_running", "Project is already running");
    }

    this.registry.setActiveProjectId(id);
    this.registry.updateProjectState(id, "starting", null);
    let outputTail = (): string => "";
    try {
      const directory = await stat(configured.remotePath);
      if (!directory.isDirectory()) {
        throw new Error("remote_path_not_directory");
      }
      // Something else holding the project's port moves the dev server rather
      // than stopping it.
      const port =
        this.reservedPorts.includes(configured.devPort) || (await checkPort(configured.devPort))
          ? await freePort()
          : configured.devPort;

      await this.installDependencies(id, configured.remotePath);

      const { executable, args } = parseDevCommand(configured.devCommand);
      const variables = (await this.projectEnvironment?.(id)) ?? {};
      const child = spawn(executable, args, {
        cwd: configured.remotePath,
        detached: true,
        env: {
          ...baseEnvironment(),
          ...variables,
          // The gateway proxies to the port the runner picked, so a PORT the
          // project sets is overridden.
          PORT: String(port),
          NODE_OPTIONS: devNodeOptions(
            variables.NODE_OPTIONS ?? process.env.NODE_OPTIONS,
            this.reservedPorts,
          ),
          NAUTILUS_PROJECT_ID: id,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      outputTail = captureOutputTail(child.stdout, child.stderr);
      const session = child.pid;
      if (session !== undefined) this.registry.setDevSession(id, session);
      const active = { child, stopping: false };
      this.active.set(id, active);
      child.once("exit", (code, signal) => {
        // A task runner can exit and leave the server it started holding the
        // port, so the rest of the session goes with it.
        if (session !== undefined) {
          const cleanup = stopSession(session)
            .then(() => {
              if (this.registry.devSession(id) === session) this.registry.setDevSession(id, null);
            })
            .finally(() => this.cleanups.delete(cleanup));
          this.cleanups.add(cleanup);
        }
        if (this.active.get(id)?.child !== child) {
          return;
        }
        this.active.delete(id);
        this.registry.setActiveDevTarget(id, null);
        if (this.registry.getActiveProjectId() === id) {
          this.registry.setActiveProjectId(null);
        }
        this.registry.updateProjectState(
          id,
          active.stopping ? "stopped" : "error",
          active.stopping
            ? null
            : (portInUse(outputTail()) ?? `process_exited:${String(code ?? signal ?? "unknown")}`),
        );
        this.logger.info("project_process_exited", {
          projectId: id,
          code,
          signal,
        });
        if (!active.stopping) {
          this.logger.error("project_process_output", {
            projectId: id,
            output: outputTail(),
          });
        }
      });

      const target = await waitForDevServer(child, port, this.readyTimeoutMs);
      const startedAt = new Date().toISOString();
      this.registry.setActiveDevTarget(id, target);
      this.registry.updateProjectState(id, "running", null, startedAt);
      this.logger.info("project_started", {
        projectId: id,
        devPort: port,
        target,
      });
      return this.registry.getProject(id) as ProjectRecord;
    } catch (error) {
      const projectAfterFailure = this.active.get(id);
      if (projectAfterFailure) {
        await this.stopChild(projectAfterFailure);
      }
      if (this.registry.getActiveProjectId() === id) {
        this.registry.setActiveProjectId(null);
      }
      this.registry.setActiveDevTarget(id, null);
      const reason = error instanceof Error ? error.message : "project_start_failed";
      const message = (reason === "dev_process_exited" && portInUse(outputTail())) || reason;
      this.registry.updateProjectState(id, "error", message);
      this.logger.error("project_start_failed", {
        projectId: id,
        reason: message,
      });
      if (error instanceof HttpError) {
        throw error;
      }
      throw new HttpError(409, "project_start_failed", message);
    }
  }

  private async installDependencies(id: string, directory: string): Promise<void> {
    const lockfile = await readIfExists(join(directory, "pnpm-lock.yaml"));
    if (
      lockfile === undefined ||
      lockfile === (await readIfExists(join(directory, "node_modules", ".pnpm", "lock.yaml")))
    ) {
      return;
    }
    this.logger.info("project_dependencies_installing", { projectId: id });
    const child = spawn("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
      cwd: directory,
      env: { ...baseEnvironment(), CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: INSTALL_TIMEOUT_MS,
    });
    const outputTail = captureOutputTail(child.stdout, child.stderr);
    const code = await new Promise<number | null>((resolve) => {
      child.once("error", () => {
        resolve(null);
      });
      child.once("close", (exitCode) => {
        resolve(exitCode);
      });
    });
    if (code !== 0) {
      const output = outputTail();
      this.logger.error("project_dependencies_install_failed", {
        projectId: id,
        code,
        output,
      });

      const reason = /ERR_PNPM_[A-Z_]+/.exec(output)?.[0];
      throw new Error(reason ? `dependency_install_failed:${reason}` : "dependency_install_failed");
    }
    this.logger.info("project_dependencies_installed", { projectId: id });
  }

  async stop(id: string): Promise<ProjectRecord> {
    this.cancelRestart(id);
    return this.serialized(() => this.stopInternal(id));
  }

  // New values only reach a dev server through a fresh process. A project
  // that is not running picks them up on its next start instead.
  scheduleRestart(id: string): void {
    if (!this.active.has(id)) return;
    this.cancelRestart(id);
    const timer = setTimeout(() => {
      this.restarts.delete(id);
      void this.serialized(async () => {
        if (!this.active.has(id)) return;
        this.logger.info("project_restarting", { projectId: id });
        await this.stopInternal(id);
        await this.startInternal(id);
      }).catch((error: unknown) => {
        this.logger.error("project_restart_failed", {
          projectId: id,
          error: error instanceof Error ? error.message : "unknown_error",
        });
      });
    }, RESTART_DELAY_MS);
    timer.unref();
    this.restarts.set(id, timer);
  }

  private cancelRestart(id: string): void {
    clearTimeout(this.restarts.get(id));
    this.restarts.delete(id);
  }

  private async stopInternal(id: string): Promise<ProjectRecord> {
    const project = this.registry.getProject(id);
    if (!project) {
      throw new HttpError(404, "project_not_found", "Project is not found");
    }
    const active = this.active.get(id);
    if (active) {
      await this.stopChild(active);
    } else {
      this.registry.updateProjectState(id, "stopped", null);
    }
    if (this.registry.getActiveProjectId() === id) {
      this.registry.setActiveProjectId(null);
    }
    this.registry.setActiveDevTarget(id, null);
    this.logger.info("project_stopped", { projectId: id });
    return this.registry.getProject(id) as ProjectRecord;
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.restarts.keys()]) this.cancelRestart(id);
    await this.serialized(async () => {
      const ids = new Set([...this.active.keys()]);
      const durable = this.registry.getActiveProjectId();
      if (durable) {
        ids.add(durable);
      }
      for (const id of ids) {
        await this.stopInternal(id);
      }
    });
    await Promise.all(this.cleanups);
  }

  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleQueue;
    let release = (): void => {};
    this.lifecycleQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private async stopChild(active: ActiveProject): Promise<void> {
    active.stopping = true;
    const child = active.child;
    if (child.exitCode !== null) {
      return;
    }

    const pid = child.pid;
    if (pid === undefined) {
      child.kill("SIGTERM");
      return;
    }
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => {
        resolve();
      }),
    );
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    // turbo and similar runners move each task into a process group of its
    // own, which the signals above never reach.
    await stopSession(pid);
  }
}
