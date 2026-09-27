import type {
  ProjectConfig,
  SessionEvent,
  SessionRecord,
  SessionSnapshot,
  SessionStatus,
  SyncDiff,
} from "@nautilus/types";
import type { Logger } from "./logger";
import type { Checkpoint, RevertResult } from "./sync";
import type { Event, OpenCodeEvent, OpenCodeService } from "./opencode";
import type { Registry } from "./registry";
import { SessionError } from "./errors";

type Listener = (event: SessionEvent) => void;

const TERMINAL_STATUS: Partial<Record<SessionEvent["type"], SessionStatus>> = {
  "session.completed": "idle",
  "session.interrupted": "interrupted",
  "session.error": "error",
};

const SUBAGENT_TERMINAL: ReadonlySet<SessionEvent["type"]> = new Set([
  "session.completed",
  "session.error",
  "session.interrupted",
]);

const DELTA_EVENT = "message.part.delta";
const MAX_ANCESTOR_DEPTH = 4;
const RECONNECT_DELAY_MS = 1_000;

export type SessionWorkspace = {
  checkpoint: (projectId: string, sessionId: string) => Promise<Checkpoint>;
  changes: (projectId: string, from: string | null, to: string) => Promise<SyncDiff>;
  revert: (
    projectId: string,
    commit: string,
    previousHead: string | null,
    sessionId: string,
  ) => Promise<RevertResult>;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sessionIdFromEvent(event: Event): string | undefined {
  const properties = record(event.properties);
  return (
    stringValue(properties.sessionID) ??
    stringValue(record(properties.info).sessionID) ??
    stringValue(record(properties.part).sessionID)
  );
}

const maxTitleLength = 60;

export function titleFromPrompt(text: string): string {
  const line = text.trim().split("\n", 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (!line) return "Untitled session";
  return line.length > maxTitleLength ? `${line.slice(0, maxTitleLength - 1).trimEnd()}…` : line;
}

function permissionRequest(properties: Record<string, unknown>): Record<string, unknown> {
  const permission = stringValue(properties.permission) ?? "tool";
  const patterns = Array.isArray(properties.patterns)
    ? properties.patterns.filter((pattern): pattern is string => typeof pattern === "string")
    : [];
  return {
    id: stringValue(properties.id) ?? null,
    permission,
    patterns,
    title: patterns.length > 0 ? `${permission}: ${patterns.join(", ")}` : permission,
    callId: stringValue(record(properties.tool).callID) ?? null,
  };
}

function payloadForEvent(
  event: Event,
): { type: SessionEvent["type"]; payload: Record<string, unknown> } | undefined {
  const properties = record(event.properties);

  switch (event.type as string) {
    case "message.updated":
      return { type: "session.message", payload: { message: properties.info } };
    case "message.part.updated": {
      const part = record(properties.part);
      if (part.type === "tool") {
        return { type: "session.tool", payload: { part } };
      }
      if (part.type === "patch") {
        return { type: "session.file_change", payload: { part } };
      }
      return {
        type: "session.message",
        payload: { part, delta: properties.delta ?? null },
      };
    }
    case "permission.asked":
      return {
        type: "session.permission",
        payload: permissionRequest(properties),
      };
    case "permission.replied":
      return {
        type: "session.permission",
        payload: {
          id: stringValue(properties.requestID) ?? null,
          response: stringValue(properties.reply) ?? null,
        },
      };
    case "todo.updated":
      return {
        type: "session.todo",
        payload: {
          todos: Array.isArray(properties.todos) ? properties.todos : [],
        },
      };
    case "session.diff":
      return {
        type: "session.file_change",
        payload: { diff: properties.diff },
      };
    case "session.idle":
      return { type: "session.completed", payload: {} };
    case "session.error": {
      const error = record(properties.error);
      return error.name === "MessageAbortedError"
        ? { type: "session.interrupted", payload: { error } }
        : { type: "session.error", payload: { error } };
    }
    default:
      return undefined;
  }
}

export class SessionService {
  private readonly openCode: OpenCodeService;
  private readonly registry: Registry;
  private readonly projects: ReadonlyMap<string, ProjectConfig>;
  private readonly logger: Logger;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly subagents = new Map<string, string | null>();
  private consuming = false;
  private stopped = false;

  constructor(
    openCode: OpenCodeService,
    registry: Registry,
    projects: ReadonlyMap<string, ProjectConfig>,
    logger: Logger,
  ) {
    this.openCode = openCode;
    this.registry = registry;
    this.projects = projects;
    this.logger = logger;
  }

  private projectPath(projectId: string): string {
    const project = this.projects.get(projectId);
    if (!project)
      throw new SessionError(
        "project_not_configured",
        "Project is not present in the server configuration",
      );
    return project.remotePath;
  }

  start(): Promise<SessionRecord[]> {
    const recovered = this.registry.recoverInterruptedAgentSessions();
    for (const session of recovered) {
      const events = this.registry.listAgentSessionEvents(session.id, session.lastSequence - 1);
      for (const event of events) {
        this.publish(event);
      }
    }
    if (!this.consuming) {
      this.consuming = true;
      void this.consumeEvents();
    }
    return Promise.resolve(recovered);
  }

  private isStopped(): boolean {
    return this.stopped;
  }

  private async consumeEvents(): Promise<void> {
    while (!this.stopped) {
      try {
        for await (const event of this.openCode.events()) {
          await this.handleOpenCodeEvent(event);
        }
      } catch (error) {
        if (this.isStopped()) {
          return;
        }
        this.logger.error("opencode_event_stream_failed", {
          error: error instanceof Error ? error.message : "unknown_error",
        });
        await this.restartStream();
      }
    }
    // Only reachable once close() sets stopped; the early return above leaves
    // `consuming` set, which is harmless because start() is never called again.
    this.consuming = false;
  }

  private async restartStream(): Promise<void> {
    try {
      await this.openCode.start();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
    }
  }

  private async handleOpenCodeEvent(event: OpenCodeEvent): Promise<void> {
    this.learnSubagent(event.payload);
    const openCodeSessionId = sessionIdFromEvent(event.payload);
    if (!openCodeSessionId) {
      return;
    }
    const owner = await this.ownerOf(openCodeSessionId);
    if (!owner) {
      return;
    }
    const { session, subagent } = owner;

    if ((event.payload.type as string) === DELTA_EVENT) {
      this.publishDelta(session, event.payload, subagent);
      return;
    }
    const translated = payloadForEvent(event.payload);
    if (!translated) {
      return;
    }
    if (subagent) {
      if (SUBAGENT_TERMINAL.has(translated.type)) return;
      this.publish(
        this.registry.appendAgentSessionEvent(session.id, translated.type, {
          ...translated.payload,
          subagent,
        }),
      );
      return;
    }
    const persisted = this.registry.appendAgentSessionEvent(
      session.id,
      translated.type,
      translated.payload,
    );
    const status = TERMINAL_STATUS[translated.type];
    if (status) this.registry.setAgentSessionStatus(session.id, status, persisted.sequence);
    this.publish(persisted);
  }

  private learnSubagent(event: Event): void {
    const properties = record(event.properties);
    if (event.type === "session.created" || event.type === "session.updated") {
      const info = record(properties.info);
      const id = stringValue(info.id);
      const parent = stringValue(info.parentID);
      if (id && parent) this.linkSubagent(id, parent);
      return;
    }
    if (event.type === "message.part.updated") {
      const part = record(properties.part);
      const child = stringValue(record(record(part.state).metadata).sessionId);
      const parent = stringValue(part.sessionID);
      if (part.type === "tool" && part.tool === "task" && child && parent) {
        this.linkSubagent(child, parent);
      }
    }
  }

  private linkSubagent(child: string, parent: string): void {
    if (this.subagents.get(child)) return;
    const root = this.registry.getAgentSessionByOpenCodeId(parent)
      ? parent
      : this.subagents.get(parent);
    if (root) this.subagents.set(child, root);
  }

  private async ownerOf(
    openCodeSessionId: string,
  ): Promise<{ session: SessionRecord; subagent?: string } | undefined> {
    const own = this.registry.getAgentSessionByOpenCodeId(openCodeSessionId);
    if (own) return { session: own };
    if (!this.subagents.has(openCodeSessionId)) {
      this.subagents.set(openCodeSessionId, await this.resolveRoot(openCodeSessionId));
    }
    const root = this.subagents.get(openCodeSessionId);
    const session = root ? this.registry.getAgentSessionByOpenCodeId(root) : undefined;
    return session ? { session, subagent: openCodeSessionId } : undefined;
  }

  private knownRoot(parent: string | null): string | null {
    if (!parent) return null;
    if (this.registry.getAgentSessionByOpenCodeId(parent)) return parent;
    return this.subagents.get(parent) ?? null;
  }

  private async resolveRoot(openCodeSessionId: string): Promise<string | null> {
    try {
      let current: string | null = openCodeSessionId;
      for (let depth = 0; current && depth < MAX_ANCESTOR_DEPTH; depth += 1) {
        const parent: string | null = await this.openCode.parentSessionId(current);
        const root = this.knownRoot(parent);
        if (root) return root;
        if (!parent) break;
        current = parent;
      }
      return null;
    } catch {
      // The walk asks the runner for each ancestor. If that call fails the
      // subagent simply has no owner we can prove, and the caller already
      // handles an absent owner, so the failure must not propagate.
      return null;
    }
  }

  private publishDelta(session: SessionRecord, event: Event, subagent?: string): void {
    const properties = record(event.properties);
    const partId = stringValue(properties.partID);
    const delta = stringValue(properties.delta);
    if (!partId || !delta) return;
    this.publish({
      sessionId: session.id,
      projectId: session.projectId,
      sequence: session.lastSequence,
      timestamp: new Date().toISOString(),
      type: "session.delta",
      durable: false,
      payload: {
        messageId: stringValue(properties.messageID) ?? null,
        partId,
        field: stringValue(properties.field) ?? "text",
        delta,
        ...(subagent ? { subagent } : {}),
      },
    });
  }

  private publish(event: SessionEvent): void {
    for (const listener of this.listeners.get(event.sessionId) ?? []) {
      listener(event);
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.openCode.close();
  }

  async createSession(projectId: string, title: string): Promise<SessionRecord> {
    const openCodeSession = await this.openCode.createSession(this.projectPath(projectId), title);
    const session = this.registry.createAgentSession(projectId, openCodeSession.id, title);
    const started = this.registry.listAgentSessionEvents(session.id).at(0);
    if (started) this.publish(started);
    return session;
  }

  getSession(id: string): SessionRecord | undefined {
    return this.registry.getAgentSession(id);
  }

  listSessions(projectId?: string): SessionRecord[] {
    return this.registry.listAgentSessions(projectId);
  }

  snapshot(id: string, afterSequence = 0): SessionSnapshot | undefined {
    const session = this.registry.getAgentSession(id);
    if (!session) {
      return undefined;
    }
    return {
      session,
      events: this.registry.listDurableAgentSessionEvents(id, afterSequence),
    };
  }

  subscribe(id: string, listener: Listener): () => void {
    const listeners = this.listeners.get(id) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(id);
      }
    };
  }
}
