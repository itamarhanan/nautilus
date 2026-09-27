import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
  createOpencodeClient,
  type Event,
  type GlobalEvent,
  type OpencodeClient,
  type Provider,
  type Session,
} from "@opencode-ai/sdk";
import type { AgentModel, ModelRef, ModelsResponse } from "@nautilus/types";
import type { Logger } from "./logger";
export type { Event } from "@opencode-ai/sdk";

export type OpenCodeEvent = {
  directory: string;
  payload: Event;
};

export type OpenCodeService = {
  start: () => Promise<void>;
  createSession: (directory: string, title: string) => Promise<Session>;
  prompt: (sessionId: string, directory: string, text: string, model?: ModelRef) => Promise<void>;
  listModels: () => Promise<ModelsResponse>;

  respondToPermission: (
    requestId: string,
    response: "once" | "always" | "reject",
    directory: string,
  ) => Promise<void>;
  abort: (sessionId: string) => Promise<void>;

  parentSessionId: (sessionId: string) => Promise<string | null>;
  events: () => AsyncGenerator<OpenCodeEvent>;
  close: () => Promise<void>;
};

export type OpenCodeProcessOptions = {
  host?: string;
  port?: number;
  dataDir?: string;
  startupTimeoutMs?: number;
  binary?: string;
};

export class OpenCodeProcess implements OpenCodeService {
  private readonly host: string;
  private readonly port: number;
  private readonly dataDir: string;
  private readonly startupTimeoutMs: number;
  private readonly binary: string;
  private readonly logger: Logger;
  private child: ChildProcess | undefined;
  private client: OpencodeClient | undefined;
  private starting: Promise<void> | undefined;

  constructor(logger: Logger, options: OpenCodeProcessOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 4096;
    this.dataDir = options.dataDir ?? `${process.env.HOME ?? "/tmp"}/nautilus/opencode/state`;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.binary = options.binary ?? process.env.NAUTILUS_OPENCODE_BIN ?? "opencode";
    this.logger = logger;
  }

  async start(): Promise<void> {
    if (this.client) return;
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    if (this.client) {
      return;
    }
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await this.stopLeftover();

    if (await portAnswers(this.host, this.port)) {
      this.logger.error("opencode_port_in_use", {
        host: this.host,
        port: this.port,
      });
      throw new Error(`OpenCode port ${String(this.port)} is already in use by another process`);
    }
    const startedAt = Date.now();
    this.logger.info("opencode_starting", { host: this.host, port: this.port });
    this.child = spawn(
      this.binary,
      ["serve", `--hostname=${this.host}`, `--port=${String(this.port)}`],
      {
        env: {
          ...process.env,
          XDG_DATA_HOME: this.dataDir,
          XDG_CONFIG_HOME: `${this.dataDir}/config`,
          XDG_CACHE_HOME: `${this.dataDir}/cache`,
        },
        stdio: ["ignore", "pipe", "pipe"],

        detached: true,
      },
    );
    const child = this.child;
    if (child.pid !== undefined) {
      await writeFile(this.pidPath(), `${String(child.pid)}\n`, {
        mode: 0o600,
      });
    }

    const signals = new Promise<"listening" | "exited">((resolve) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        const output = chunk.toString();
        if (/listening on/i.test(output)) resolve("listening");
        for (const line of output.split("\n")) {
          if (line.trim()) this.logger.debug("opencode_output", { output: line.trim() });
        }
      });
      child.once("exit", () => {
        resolve("exited");
      });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) this.logger.warn("opencode_stderr", { output: line.trim() });
      }
    });
    child.once("exit", (code, signal) => {
      this.logger.warn("opencode_exited", { code, signal: signal ?? null });
      this.client = undefined;
      void this.forgetPid(child.pid);
    });
    await this.waitUntilReady(signals);
    this.client = createOpencodeClient({
      baseUrl: `http://${this.host}:${String(this.port)}`,
      responseStyle: "data",
      throwOnError: true,
      fetch: boundedFetch,
    });
    this.logger.info("opencode_started", {
      host: this.host,
      port: this.port,
      dataDir: this.dataDir,
      startupMs: Date.now() - startedAt,
    });
  }

  private pidPath(): string {
    return join(this.dataDir, "opencode.pid");
  }

  private async forgetPid(pid: number | undefined): Promise<void> {
    const recorded = await readFile(this.pidPath(), "utf8").catch(() => "");
    if (pid !== undefined && Number(recorded.trim()) === pid) {
      await rm(this.pidPath(), { force: true });
    }
  }

  private async stopLeftover(): Promise<void> {
    const pid = Number((await readFile(this.pidPath(), "utf8").catch(() => "")).trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return;
    }
    const commandLine = await readFile(`/proc/${String(pid)}/cmdline`, "utf8").catch(() => "");
    if (commandLine.includes("opencode") && commandLine.includes("serve")) {
      this.logger.warn("opencode_leftover_stopping", { pid });
      await stopProcess(pid);
    }
    await rm(this.pidPath(), { force: true });
  }

  private async waitUntilReady(signals: Promise<"listening" | "exited">): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;

    let delayMs = 250;
    while (Date.now() < deadline) {
      const signal = await Promise.race([signals, sleep(Math.min(delayMs, deadline - Date.now()))]);
      const listening = signal === "listening";
      if (!this.child || this.child.exitCode !== null) {
        throw new Error("OpenCode exited before becoming ready");
      }
      try {
        const response = await fetch(`http://${this.host}:${String(this.port)}/global/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          return;
        }
      } catch (error) {
        if (listening || !isConnectionRefused(error)) {
          this.logger.debug("opencode_health_check_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      delayMs = listening ? 100 : Math.min(delayMs * 2, 2_000);
    }
    await this.close();
    throw new Error("Timed out waiting for OpenCode to become ready");
  }

  private async clientOrStart(): Promise<OpencodeClient> {
    if (!this.client) await this.start();
    if (!this.client) throw new Error("OpenCode is not started");
    return this.client;
  }

  async createSession(directory: string, title: string): Promise<Session> {
    const client = await this.clientOrStart();

    return (await client.session.create({
      body: { title },
      query: { directory },
    })) as unknown as Session;
  }

  async prompt(
    sessionId: string,
    directory: string,
    text: string,
    model?: ModelRef,
  ): Promise<void> {
    const client = await this.clientOrStart();
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text }],

        ...(model ? { model: { providerID: model.providerId, modelID: model.modelId } } : {}),

        ...(model?.variant ? { variant: model.variant } : {}),
      },
      query: { directory },
    });
  }

  async listModels(): Promise<ModelsResponse> {
    const client = await this.clientOrStart();

    const [catalog, config] = (await Promise.all([
      client.config.providers(),
      client.config.get(),
    ])) as unknown as [{ providers: Array<Provider> }, { model?: string }];
    const models: AgentModel[] = [];
    for (const provider of catalog.providers) {
      for (const model of Object.values(provider.models)) {
        if (model.status === "deprecated") continue;
        models.push({
          providerId: provider.id,
          modelId: model.id,
          name: model.name || model.id,
          providerName: provider.name || provider.id,
          isReasoning: model.capabilities.reasoning,
          contextLimit: model.limit.context > 0 ? model.limit.context : null,

          variants: Object.keys((model as { variants?: Record<string, unknown> }).variants ?? {}),
        });
      }
    }
    return { models, default: parseModelRef(config.model) };
  }

  async respondToPermission(
    requestId: string,
    response: "once" | "always" | "reject",
    directory: string,
  ): Promise<void> {
    await this.clientOrStart();

    const url = new URL(
      `/permission/${encodeURIComponent(requestId)}/reply`,
      `http://${this.host}:${String(this.port)}`,
    );
    url.searchParams.set("directory", directory);
    const result = await boundedFetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reply: response }),
      }),
    );
    if (!result.ok) throw new Error(`permission_reply_failed:${String(result.status)}`);
  }

  async abort(sessionId: string): Promise<void> {
    const client = await this.clientOrStart();
    await client.session.abort({ path: { id: sessionId } });
  }

  async parentSessionId(sessionId: string): Promise<string | null> {
    const client = await this.clientOrStart();
    const session = (await client.session.get({
      path: { id: sessionId },
    })) as unknown as Session;
    return session.parentID ?? null;
  }

  async *events(): AsyncGenerator<OpenCodeEvent> {
    if (!this.client) {
      throw new Error("OpenCode is not started");
    }
    const stream = await this.client.global.event({
      sseDefaultRetryDelay: 1_000,
      sseMaxRetryAttempts: 10,
    });
    for await (const event of stream.stream as AsyncGenerator<GlobalEvent>) {
      yield { directory: event.directory, payload: event.payload };
    }
  }

  async close(): Promise<void> {
    this.client = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) {
      return;
    }
    if (child.pid === undefined) {
      child.kill("SIGTERM");
      return;
    }
    await stopProcess(child.pid);
  }
}

const requestTimeoutMs = 60_000;

function boundedFetch(request: Request): Promise<Response> {
  if (new URL(request.url).pathname.endsWith("/event")) return fetch(request);
  return fetch(request, {
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(requestTimeoutMs)]),
  });
}

function portAnswers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(1_000);
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(pid: number): Promise<void> {
  const target = isAlive(-pid) ? -pid : pid;
  try {
    process.kill(target, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && isAlive(target)) {
    await sleep(50);
  }
  if (isAlive(target)) {
    process.kill(target, "SIGKILL");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}

function isConnectionRefused(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return cause?.code === "ECONNREFUSED";
}

function parseModelRef(value: string | undefined): ModelRef | null {
  const slash = value?.indexOf("/") ?? -1;
  if (!value || slash <= 0 || slash === value.length - 1) return null;
  return { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) };
}
