import { ControlApi, type RunnerInfo } from "./api";
import { friendlyError } from "./errors";
import type { DesktopSettings } from "./settings";

export type ConnectionPhase = "idle" | "connecting" | "connected" | "reconnecting" | "offline";

export type ConnectionSnapshot = {
  phase: ConnectionPhase;
  error: string | null;
  info: RunnerInfo | null;
  api: ControlApi | null;

  retryAt: number | null;
};

const retryDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000];
// The gateway wakes the runner in its sandbox on the first request, which can
// take about a minute after the sandbox slept.
const connectTimeoutMs = 90_000;

export type ControlChannelOptions = {
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  createApi?: (baseUrl: string, adminToken: string) => ControlApi;
};

export class ControlChannel {
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
  private readonly createApi: (baseUrl: string, adminToken: string) => ControlApi;

  constructor(options: ControlChannelOptions = {}) {
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      options.clearTimer ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
    this.createApi = options.createApi ?? ((baseUrl, token) => new ControlApi(baseUrl, token));
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
    const generation = this.reset();
    this.settings = settings;
    this.attempt = 0;
    this.update({ phase: "connecting", error: null, retryAt: null });
    try {
      await this.open(settings, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      const message = friendlyError(error).message;
      if (retry) this.scheduleRetry(message, generation);
      else
        this.update({
          phase: "offline",
          error: message,
          api: null,
          info: null,
          retryAt: null,
        });
      throw friendlyError(error);
    }
  }

  // The runner's lifecycle moves after connect, e.g. from degraded to ready once
  // an unhealthy project is removed, so the info is fetched again on refresh.
  // A failure here means the gateway or the runner went away, so it reconnects.
  async refreshInfo(): Promise<void> {
    const { api, phase } = this.snapshot;
    if (!api || phase !== "connected") return;
    const generation = this.generation;
    const info = await api.info({ timeoutMs: 10_000 }).catch(() => null);
    if (generation !== this.generation || this.snapshot.api !== api) return;
    if (info) this.update({ info });
    else this.scheduleRetry("The runner stopped answering", generation);
  }

  reconnect(): void {
    if (!this.settings) return;
    void this.connect(this.settings).catch(() => undefined);
  }

  disconnect(): Promise<void> {
    this.reset();
    this.update({
      phase: "idle",
      error: null,
      api: null,
      info: null,
      retryAt: null,
    });
    return Promise.resolve();
  }

  private reset(): number {
    this.generation += 1;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    return this.generation;
  }

  private async open(settings: DesktopSettings, generation: number): Promise<void> {
    const api = this.createApi(settings.runnerUrl.replace(/\/+$/, ""), settings.adminToken);
    const info = await api.info({
      timeoutMs: connectTimeoutMs,
      timeoutMessage: "The runner did not start in time. Try again in a minute.",
    });
    if (generation !== this.generation) return;
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
        this.scheduleRetry(friendlyError(error).message, generation);
      });
    }, delay);
  }

  private update(partial: Partial<ConnectionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
