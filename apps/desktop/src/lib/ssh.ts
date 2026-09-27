import { expandHome } from "./folders";
import type { DesktopSettings } from "./settings";
import type { AllowedProgram, RunningProcess, Spawner } from "./process";

export const runnerControlPort = 4001;

const runnerAgentPort = 4200;

export const localAgentPort = 4100;

const controlPortRange: [number, number] = [47000, 47999];

export type ForwardState = "stopped" | "starting" | "connected" | "error";

export function resolveHomePath(path: string, home: string): string {
  if (
    !path ||
    path.length > 4096 ||
    path.includes("\0") ||
    path.includes("\r") ||
    path.includes("\n") ||
    (!path.startsWith("/") && path !== "~" && !path.startsWith("~/"))
  ) {
    throw new Error("SSH key path must be absolute or start with ~/");
  }
  return expandHome(path, home);
}

function baseArgs(settings: DesktopSettings, keyPath: string): string[] {
  if (!/^[A-Za-z0-9._-]+$/.test(settings.ssh.host)) throw new Error("invalid SSH host");
  if (!/^[A-Za-z0-9._-]+$/.test(settings.ssh.user)) throw new Error("invalid SSH user");
  return [
    "-F",
    "/dev/null",
    "-N",
    "-T",
    "-i",
    keyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "UpdateHostKeys=no",
  ];
}

function portValue(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
  return String(port);
}

export function controlArgs(
  settings: DesktopSettings,
  keyPath: string,
  localPort: number,
): string[] {
  return [
    ...baseArgs(settings, keyPath),
    "-L",
    `127.0.0.1:${portValue(localPort)}:127.0.0.1:${String(runnerControlPort)}`,
    `${settings.ssh.user}@${settings.ssh.host}`,
  ];
}

export function syncArgs(settings: DesktopSettings, keyPath: string): string[] {
  return [
    ...baseArgs(settings, keyPath),
    "-R",
    `127.0.0.1:${String(runnerAgentPort)}:127.0.0.1:${String(localAgentPort)}`,
    `${settings.ssh.user}@${settings.ssh.host}`,
  ];
}

export function randomControlPort(random = Math.random): number {
  const [low, high] = controlPortRange;
  return low + Math.floor(random() * (high - low + 1));
}

export class SshForward {
  private process: RunningProcess | undefined;
  private currentState: ForwardState = "stopped";
  private stderr = "";
  private exitListener: ((code: number | null) => void) | undefined;

  constructor(
    private readonly program: Extract<AllowedProgram, "nautilus-ssh-control" | "nautilus-ssh-sync">,
    private readonly args: string[],
    private readonly spawn: Spawner,
  ) {}

  get state(): ForwardState {
    return this.currentState;
  }

  get lastError(): string {
    return this.stderr.trim().split("\n").at(-1) ?? "";
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListener = listener;
  }

  async start(ready: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
    if (this.process) return;
    this.setState("starting");

    const exit: { done: boolean; code: number | null } = {
      done: false,
      code: null,
    };
    this.process = await this.spawn(this.program, this.args, {
      onStderr: (line) => {
        this.stderr = `${this.stderr}${line}\n`.slice(-2_000);
      },
      onClose: (code) => {
        exit.done = true;
        exit.code = code;
        const wasConnected = this.currentState === "connected";
        this.process = undefined;
        this.setState(code === 0 || this.currentState === "stopped" ? "stopped" : "error");
        if (wasConnected) this.exitListener?.(code);
      },
    });
    const hasExited = () => exit.done;
    const deadline = Date.now() + timeoutMs;
    while (!hasExited() && Date.now() < deadline) {
      if (await ready().catch(() => false)) {
        if (hasExited()) break;
        this.setState("connected");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const reason = hasExited()
      ? `ssh exited${exit.code === null ? "" : ` with code ${String(exit.code)}`}${this.lastError ? `: ${this.lastError}` : ""}`
      : "the SSH forward did not become ready in time";
    await this.stop();
    this.setState("error");
    throw new Error(reason);
  }

  async stop(): Promise<void> {
    const running = this.process;
    this.process = undefined;
    this.setState("stopped");
    if (running) await running.kill().catch(() => undefined);
  }

  private setState(state: ForwardState): void {
    if (state === this.currentState) return;
    this.currentState = state;
  }
}
