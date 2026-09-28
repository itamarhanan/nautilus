import type {
  ModelRef,
  ModelsResponse,
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

const RETRYABLE: ReadonlySet<SessionStatus> = new Set(["interrupted", "error"]);

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
  private readonly workspace: SessionWorkspace | undefined;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly subagents = new Map<string, string | null>();
  private consuming = false;
  private stopped = false;

  constructor(
    openCode: OpenCodeService,
    registry: Registry,
    projects: ReadonlyMap<string, ProjectConfig>,
    logger: Logger,

    workspace?: SessionWorkspace,
  ) {
    this.openCode = openCode;
    this.registry = registry;
    this.projects = projects;
    this.logger = logger;
    this.workspace = workspace;
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
    // A project being deleted leaves the project map before its sessions leave
    // the registry; events that land in between have nowhere to go.
    if (!this.projects.has(session.projectId)) return;

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
    if (TERMINAL_STATUS[translated.type] && this.workspace) {
      if (await this.checkpointOnTerminal(session)) return;
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

  private async checkpointOnTerminal(session: SessionRecord): Promise<boolean> {
    if (!this.workspace) return false;
    this.registry.updateProjectState(session.projectId, "checkpointing", null);
    try {
      const checkpoint = await this.workspace.checkpoint(session.projectId, session.id);
      this.registry.updateProjectState(session.projectId, "idle", null);
      this.publish(
        this.registry.appendAgentSessionEvent(session.id, "session.checkpoint", {
          ...checkpoint,
          sessionId: session.id,
        }),
      );
      return false;
    } catch (error) {
      this.registry.updateProjectState(session.projectId, "unhealthy", "checkpoint_failed");
      const failed = this.registry.appendAgentSessionEvent(session.id, "session.error", {
        error: "checkpoint_failed",
        message: error instanceof Error ? error.message : "Checkpoint failed",
      });
      this.registry.setAgentSessionStatus(session.id, "error", failed.sequence);
      this.publish(failed);
      return true;
    }
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

  async prompt(
    id: string,
    text: string,
    { retry = false, model }: { retry?: boolean; model?: ModelRef | undefined } = {},
  ): Promise<void> {
    const { session } = this.assertPromptable(id, retry);
    this.recordPrompt(id, text, model, retry);
    try {
      await this.openCode.prompt(
        session.openCodeSessionId,
        this.projectPath(session.projectId),
        text,
        model,
      );
    } catch (error) {
      const failed = this.registry.appendAgentSessionEvent(id, "session.error", {
        error: error instanceof Error ? error.message : "prompt_failed",
      });
      this.registry.setAgentSessionStatus(id, "error", failed.sequence);
      this.publish(failed);
      this.logger.error("opencode_prompt_failed", {
        sessionId: id,
        error: error instanceof Error ? error.message : "unknown_error",
      });
      throw error;
    }
  }

  private assertPromptable(id: string, retry: boolean): { session: SessionRecord } {
    const session = this.registry.getAgentSession(id);
    if (!session) {
      throw new SessionError("session_not_found", "Session is not found");
    }
    if (session.status === "running") {
      throw new SessionError("session_busy", "Wait for the agent to finish, or stop it");
    }
    if (retry && !RETRYABLE.has(session.status)) {
      throw new SessionError(
        "session_not_retryable",
        "Only an interrupted or failed turn can be retried",
      );
    }
    if (!this.projects.has(session.projectId)) {
      throw new SessionError(
        "project_not_configured",
        "Project is not present in the server configuration",
      );
    }
    return { session };
  }

  private recordPrompt(
    id: string,
    text: string,
    model: ModelRef | undefined,
    retry: boolean,
  ): void {
    if (!retry && !this.registry.hasUserPrompt(id)) {
      this.registry.renameAgentSession(id, titleFromPrompt(text));
    }
    this.registry.setAgentSessionStatus(id, "running");
    this.publish(
      retry
        ? this.registry.appendAgentSessionEvent(id, "session.retry", { reason: "retry" })
        : this.registry.appendAgentSessionEvent(id, "session.message", {
            message: model ? { role: "user", text, model } : { role: "user", text },
          }),
    );
  }

  listModels(): Promise<ModelsResponse> {
    return this.openCode.listModels();
  }

  async retry(id: string): Promise<void> {
    const session = this.registry.getAgentSession(id);
    if (!session) {
      throw new SessionError("session_not_found", "Session is not found");
    }
    const last = this.registry.getLastDurableUserPrompt(id);
    if (!last) {
      throw new SessionError("session_prompt_not_found", "This session has no prompt to retry");
    }
    await this.prompt(id, last.text, {
      retry: true,
      model: last.model ?? undefined,
    });
  }

  async respondToPermission(
    id: string,
    permissionId: string,
    response: "once" | "always" | "reject",
  ): Promise<void> {
    const session = this.registry.getAgentSession(id);
    if (!session) {
      throw new SessionError("session_not_found", "Session is not found");
    }

    const asked = this.registry
      .listDurableAgentSessionEvents(id)
      .some(
        (event) =>
          event.type === "session.permission" &&
          event.payload.id === permissionId &&
          event.payload.response === undefined,
      );
    if (!asked)
      throw new SessionError("permission_not_found", "This session has no such permission request");
    await this.openCode.respondToPermission(
      permissionId,
      response,
      this.projectPath(session.projectId),
    );
  }

  async changes(id: string, commit: string): Promise<SyncDiff> {
    const { session, checkpoint } = this.checkpointOf(id, commit);
    return this.requireWorkspace().changes(session.projectId, checkpoint.previousHead, commit);
  }

  async revert(id: string, commit: string): Promise<RevertResult> {
    const { session, checkpoint } = this.checkpointOf(id, commit);
    if (session.status === "running")
      throw new SessionError("session_busy", "Wait for the agent to finish, or stop it");
    const result = await this.requireWorkspace().revert(
      session.projectId,
      commit,
      checkpoint.previousHead,
      session.id,
    );
    if (result.status === "ok") {
      this.publish(
        this.registry.appendAgentSessionEvent(session.id, "session.checkpoint", {
          ...result.checkpoint,
          sessionId: session.id,
          revertOf: commit,
        }),
      );
    }
    return result;
  }

  private requireWorkspace(): SessionWorkspace {
    if (!this.workspace)
      throw new SessionError("checkpoints_unavailable", "This runner keeps no checkpoints");
    return this.workspace;
  }

  private checkpointOf(
    id: string,
    commit: string,
  ): { session: SessionRecord; checkpoint: { previousHead: string | null } } {
    const session = this.registry.getAgentSession(id);
    if (!session) throw new SessionError("session_not_found", "Session is not found");
    const event = this.registry
      .listDurableAgentSessionEvents(id)
      .find((entry) => entry.type === "session.checkpoint" && entry.payload.commit === commit);
    if (!event || !("previousHead" in event.payload))
      throw new SessionError("checkpoint_not_found", "This session has no such checkpoint");
    return {
      session,
      checkpoint: {
        previousHead: stringValue(event.payload.previousHead) ?? null,
      },
    };
  }

  async interrupt(id: string): Promise<void> {
    const session = this.registry.getAgentSession(id);
    if (!session) {
      throw new SessionError("session_not_found", "Session is not found");
    }
    await this.openCode.abort(session.openCodeSessionId);
    this.registry.setAgentSessionStatus(id, "interrupted");
    this.publish(
      this.registry.appendAgentSessionEvent(id, "session.interrupted", {
        reason: "user",
      }),
    );
  }
}
