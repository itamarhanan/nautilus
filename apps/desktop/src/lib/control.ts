import { ControlApi, type RunnerInfo } from "./api";
import { friendlyError } from "./errors";
import type { Spawner } from "./process";
import type { DesktopSettings } from "./settings";
import {
  controlArgs,
  randomControlPort,
  resolveHomePath,
  runnerControlPort,
  SshForward,
} from "./ssh";

export type ConnectionPhase = "idle" | "connecting" | "connected" | "reconnecting" | "offline";

export type ConnectionSnapshot = {
  phase: ConnectionPhase;
  error: string | null;
  info: RunnerInfo | null;
  api: ControlApi | null;

  retryAt: number | null;
};

const retryDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000];
const portAttempts = 3;

export type ControlChannelOptions = {
  spawn: Spawner;
  home: string;

  localMode: boolean;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export class ControlChannel {
  private forward: SshForward | undefined;
  private settings: DesktopSettings | undefined;
  private attempt = 0;
  private timer: unknown;
  private generation = 0;
  private snapshot: ConnectionSnapshot = {
    phase: "idle",
    error: null,
    info: null,
    api: null,
    retryAt: null,
  };
  private readonly listeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: ControlChannelOptions) {
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      options.clearTimer ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
  }

  get current(): ConnectionSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: ConnectionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  async connect(settings: DesktopSettings, { retry = true } = {}): Promise<void> {
    const generation = await this.reset();
    this.settings = settings;
    this.attempt = 0;
    this.update({ phase: "connecting", error: null, retryAt: null });
    try {
      await this.open(settings, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      const message = error instanceof Error ? error.message : "Could not reach the runner";
      if (retry) this.scheduleRetry(message, generation);
      else
        this.update({
          phase: "offline",
          error: message,
          api: null,
          info: null,
          retryAt: null,
        });
      throw error;
    }
  }

  reconnect(): void {
    if (!this.settings) return;
    void this.connect(this.settings).catch(() => undefined);
  }

  async disconnect(): Promise<void> {
    await this.reset();
    this.update({
      phase: "idle",
      error: null,
      api: null,
      info: null,
      retryAt: null,
    });
  }

  private async reset(): Promise<number> {
    this.generation += 1;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    const forward = this.forward;
    this.forward = undefined;
    await forward?.stop();
    return this.generation;
  }

  private async open(settings: DesktopSettings, generation: number): Promise<void> {
    if (this.options.localMode) {
      const api = new ControlApi(`http://127.0.0.1:${String(runnerControlPort)}`);
      const info = await api.info({ timeoutMs: 3_000 });
      if (generation !== this.generation) return;
      this.connected(api, info);
      return;
    }
    const keyPath = resolveHomePath(settings.ssh.keyPath, this.options.home);
    let lastError: unknown;
    for (let attempt = 0; attempt < portAttempts; attempt += 1) {
      const port = randomControlPort();
      const api = new ControlApi(`http://127.0.0.1:${String(port)}`);
      const forward = new SshForward(
        "nautilus-ssh-control",
        controlArgs(settings, keyPath, port),
        this.options.spawn,
      );
      let info: RunnerInfo | undefined;
      try {
        await forward.start(async () => {
          info = await api.info({ timeoutMs: 2_000 });
          return true;
        });
      } catch (error) {
        lastError = error;

        if (error instanceof Error && /forward|address already in use/i.test(error.message))
          continue;
        throw friendlyError(error);
      }
      if (generation !== this.generation) {
        await forward.stop();
        return;
      }
      this.forward = forward;
      forward.onExit(() => {
        if (generation !== this.generation) return;
        this.forward = undefined;
        this.scheduleRetry("The SSH connection to the runner closed", generation);
      });
      this.connected(api, info ?? null);
      return;
    }
    throw friendlyError(lastError);
  }

  private connected(api: ControlApi, info: RunnerInfo | null): void {
    this.attempt = 0;
    this.update({ phase: "connected", error: null, api, info, retryAt: null });
  }

  private scheduleRetry(message: string, generation: number): void {
    const delay = retryDelaysMs[Math.min(this.attempt, retryDelaysMs.length - 1)] ?? 30_000;
    this.attempt += 1;
    this.update({
      phase: this.attempt > 2 ? "offline" : "reconnecting",
      error: message,
      api: null,
      retryAt: Date.now() + delay,
    });
    this.timer = this.setTimer(() => {
      if (generation !== this.generation || !this.settings) return;
      this.update({ phase: "reconnecting", retryAt: null });
      void this.open(this.settings, generation).catch((error: unknown) => {
        if (generation !== this.generation) return;
        this.scheduleRetry(
          error instanceof Error ? error.message : "Could not reach the runner",
          generation,
        );
      });
    }, delay);
  }

  private update(partial: Partial<ConnectionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
