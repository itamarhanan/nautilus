import { agent as agentText } from "@nautilus/copy";
import { AgentApi } from "./api";
import type { RunningProcess, Spawner } from "./process";
import type { DesktopSettings } from "./settings";
import { localAgentPort } from "./ssh";

export type AgentPhase = "stopped" | "starting" | "running" | "error";

export type AgentSnapshot = { phase: AgentPhase; error: string | null };

export function createLaunchKey(
  random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  const bytes = random(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// Names the runner the agent syncs with, so the PC keeps a separate base and
// history for each one. It must match the agent's ^[a-z0-9-]{1,64}$.
export async function runnerKey(settings: DesktopSettings, localMode: boolean): Promise<string> {
  if (localMode) return "local";
  let origin: string;
  try {
    origin = new URL(settings.runnerUrl.trim()).origin.toLowerCase();
  } catch {
    return "unset";
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(origin)),
  );
  let hex = "";
  for (const byte of digest.slice(0, 8)) hex += byte.toString(16).padStart(2, "0");
  return `runner-${hex}`;
}

export type AgentOptions = {
  spawn: Spawner;

  devOrigins?: string[];
  startupTimeoutMs?: number;
  previous?: {
    read: () => number | null;
    write: (pid: number | null) => void;
    kill: (pid: number) => Promise<void>;
  };
};

export class AgentProcess {
  private process: RunningProcess | undefined;
  private snapshot: AgentSnapshot = { phase: "stopped", error: null };
  private readonly listeners = new Set<(snapshot: AgentSnapshot) => void>();
  private api: AgentApi | undefined;
  private starting: Promise<AgentApi> | undefined;
  private runner = "unset";

  constructor(private readonly options: AgentOptions) {}

  get current(): AgentSnapshot {
    return this.snapshot;
  }

  get client(): AgentApi | undefined {
    return this.snapshot.phase === "running" ? this.api : undefined;
  }

  subscribe(listener: (snapshot: AgentSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  get runnerKey(): string {
    return this.runner;
  }

  // Starts the agent for a runner, or keeps the running one. A different
  // runner restarts it, since the agent reads its runner once at launch.
  async start(runnerKey = this.runner): Promise<AgentApi> {
    if (runnerKey !== this.runner) {
      await this.starting?.catch(() => undefined);
      this.runner = runnerKey;
      if (this.process) await this.stop();
    }
    if (this.process && this.api) return this.api;
    this.starting ??= this.launch(this.runner).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async launch(runnerKey: string): Promise<AgentApi> {
    this.update({ phase: "starting", error: null });
    const leftover = this.options.previous?.read() ?? null;
    if (leftover !== null) {
      await this.options.previous?.kill(leftover).catch(() => undefined);
      this.options.previous?.write(null);
    }
    const launchKey = createLaunchKey();
    const api = new AgentApi(`http://127.0.0.1:${String(localAgentPort)}`, launchKey);

    const output = { stderr: "", exited: false };
    let resolveReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    let spawned: RunningProcess | undefined;
    try {
      spawned = await this.options.spawn(
        "nautilus-sync-agent",
        ["--launch-key-stdin"],
        {
          onStdout: (line) => {
            if (line.includes('"event":"ready"')) resolveReady();
          },
          onStderr: (line) => {
            output.stderr = `${output.stderr}${line}\n`.slice(-2_000);
          },
          onClose: (code) => {
            output.exited = true;
            resolveReady();

            if (spawned === undefined || this.process !== spawned) return;
            this.process = undefined;
            this.api = undefined;
            this.options.previous?.write(null);
            if (this.snapshot.phase !== "stopped") {
              this.update({
                phase: "error",
                error: agentExitMessage(code, output.stderr),
              });
            }
          },
        },
        {
          env: {
            NAUTILUS_AGENT_RUNNER: runnerKey,
            ...(this.options.devOrigins?.length
              ? { NAUTILUS_AGENT_ORIGINS: this.options.devOrigins.join(",") }
              : {}),
          },
        },
      );
    } catch {
      this.update({
        phase: "error",
        error: "The sync agent could not be started. Reinstall Nautilus and try again.",
      });
      throw new Error(this.snapshot.error ?? "sync agent failed to start");
    }
    this.process = spawned;
    if (spawned.pid !== undefined) this.options.previous?.write(spawned.pid);
    await spawned.write(`${launchKey}\n`);
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, this.options.startupTimeoutMs ?? 10_000),
    );
    await Promise.race([ready, timeout]);
    if (output.exited || !(await api.healthy())) {
      const message = this.snapshot.error ?? agentExitMessage(null, output.stderr);
      await this.stop();
      this.update({ phase: "error", error: message });
      throw new Error(message);
    }
    this.api = api;
    this.update({ phase: "running", error: null });
    return api;
  }

  async stop(): Promise<void> {
    const running = this.process;
    this.process = undefined;
    this.api = undefined;
    this.update({ phase: "stopped", error: null });
    this.options.previous?.write(null);
    if (running) await running.kill().catch(() => undefined);
  }

  private update(snapshot: AgentSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function agentExitMessage(code: number | null, stderr: string): string {
  if (/EADDRINUSE/.test(stderr)) return agentText.exit.portInUse(localAgentPort);
  const detail = stderr.trim().split("\n").at(-1);
  if (detail) return agentText.exit.stoppedWithDetail(detail);
  return code === null ? agentText.exit.stopped : agentText.exit.stoppedWithCode(code);
}
