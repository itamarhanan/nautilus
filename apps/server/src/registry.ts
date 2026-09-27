import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ModelRef,
  ProjectConfig,
  ProjectRecord,
  ProjectState,
  SessionEvent,
  SessionEventType,
  SessionRecord,
  SessionStatus,
} from "@nautilus/types";

type ProjectRow = {
  id: string;
  name: string;
  remotePath: string;
  devCommand: string;
  devPort: number;
  previewPath: string;
  state: ProjectState;
  lastError: string | null;
  startedAt: string | null;
  firstSyncAt: string | null;
  updatedAt: string;
};

type SessionRow = {
  id: string;
  projectId: string;
  openCodeSessionId: string;
  title: string;
  status: SessionStatus;
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
};

type SessionEventRow = {
  sessionId: string;
  projectId: string;
  sequence: number;
  timestamp: string;
  type: SessionEventType;
  durable: number;
  payload: string;
};

function now(): string {
  return new Date().toISOString();
}

function mapProject(row: ProjectRow): ProjectRecord {
  return row;
}

function mapSession(row: SessionRow): SessionRecord {
  return row;
}

function mapSessionEvent(row: SessionEventRow): SessionEvent {
  return {
    sessionId: row.sessionId,
    projectId: row.projectId,
    sequence: row.sequence,
    timestamp: row.timestamp,
    type: row.type,
    durable: row.durable === 1,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}

export class Registry {
  private readonly db: DatabaseSync;

  constructor(registryPath: string) {
    if (registryPath !== ":memory:") {
      mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(registryPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        remote_path TEXT NOT NULL,
        dev_command TEXT NOT NULL,
        dev_port INTEGER NOT NULL,
        preview_path TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'inactive',
        last_error TEXT,
        started_at TEXT,
        first_sync_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairing_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS preview_tokens (
        id_hash TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS preview_sessions (
        token_hash TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pairing_codes_expiry ON pairing_codes(expires_at);
      CREATE INDEX IF NOT EXISTS preview_tokens_expiry ON preview_tokens(expires_at);
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        opencode_session_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        last_sequence INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_session_events (
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        durable INTEGER NOT NULL DEFAULT 1,
        payload TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS agent_sessions_project ON agent_sessions(project_id, created_at);
      CREATE INDEX IF NOT EXISTS agent_session_events_session ON agent_session_events(session_id, sequence);
      CREATE INDEX IF NOT EXISTS preview_sessions_expiry ON preview_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS server_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.migrateRunnerWideDevices();
    this.migrateFirstSync();
    this.dropLines();
    this.dropSyncEvents();
  }

  private migrateFirstSync(): void {
    const columns = this.db.prepare("PRAGMA table_info(projects)").all() as {
      name: string;
    }[];
    if (columns.some((column) => column.name === "first_sync_at")) return;
    this.db.prepare("ALTER TABLE projects ADD COLUMN first_sync_at TEXT").run();
    const hasHistory = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_events'")
      .get();
    if (!hasHistory) return;
    this.db
      .prepare(
        `
        UPDATE projects SET first_sync_at = (
          SELECT MIN(created_at) FROM sync_events WHERE sync_events.project_id = projects.id
        )
        WHERE EXISTS (SELECT 1 FROM sync_events WHERE sync_events.project_id = projects.id)
      `,
      )
      .run();
  }

  private dropSyncEvents(): void {
    this.db.exec("DROP INDEX IF EXISTS sync_events_project");
    this.db.exec("DROP TABLE IF EXISTS sync_events");
  }

  private dropLines(): void {
    const columns = this.db.prepare("PRAGMA table_info(agent_sessions)").all() as {
      name: string;
    }[];
    if (columns.some((column) => column.name === "line_id")) {
      this.db.exec("ALTER TABLE agent_sessions DROP COLUMN line_id");
    }
    this.db.exec("DROP TABLE IF EXISTS project_lines");
    this.db.exec("DELETE FROM server_state WHERE key LIKE 'active_line:%'");
  }

  private migrateRunnerWideDevices(): void {
    const hasProjectColumn = (table: string) =>
      (
        this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).some((column) => column.name === "project_id");
    const rebuildDevices = hasProjectColumn("devices");
    const rebuildPairing = hasProjectColumn("pairing_codes");
    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DROP INDEX IF EXISTS pc_identities_project");
      this.db.exec("DROP TABLE IF EXISTS pc_identities");
      if (rebuildDevices) {
        this.db.exec(`
          DROP INDEX IF EXISTS devices_project;
          CREATE TABLE devices_next (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            last_seen_at TEXT,
            revoked_at TEXT
          );
          INSERT INTO devices_next (id, name, token_hash, created_at, last_seen_at, revoked_at)
            SELECT id, name, token_hash, created_at, last_seen_at, revoked_at FROM devices;
          DROP TABLE devices;
          ALTER TABLE devices_next RENAME TO devices;
        `);
      }
      if (rebuildPairing) {
        this.db.exec(`
          DROP INDEX IF EXISTS pairing_codes_expiry;
          CREATE TABLE pairing_codes_next (
            id TEXT PRIMARY KEY,
            code_hash TEXT NOT NULL UNIQUE,
            device_name TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            used_at TEXT,
            created_at TEXT NOT NULL
          );
          INSERT INTO pairing_codes_next (id, code_hash, device_name, expires_at, used_at, created_at)
            SELECT id, code_hash, device_name, expires_at, used_at, created_at FROM pairing_codes;
          DROP TABLE pairing_codes;
          ALTER TABLE pairing_codes_next RENAME TO pairing_codes;
          CREATE INDEX pairing_codes_expiry ON pairing_codes(expires_at);
        `);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  close(): void {
    this.db.close();
  }

  isReady(): boolean {
    this.db.exec("SELECT 1");
    return true;
  }

  getActiveProjectId(): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM server_state WHERE key = 'active_project_id'")
      .get() as { value: string } | undefined;
    return row?.value;
  }

  activeDevPort(projectId: string): number | null {
    return this.getProject(projectId)?.devPort ?? null;
  }

  activeDevTarget(projectId: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM server_state WHERE key = ?")
      .get(`dev_target:${projectId}`) as { value: string } | undefined;
    if (row) return row.value;
    const port = this.activeDevPort(projectId);
    return port === null ? null : `http://127.0.0.1:${String(port)}`;
  }

  setActiveDevTarget(projectId: string, target: string | null): void {
    const key = `dev_target:${projectId}`;
    if (target === null) {
      this.db.prepare("DELETE FROM server_state WHERE key = ?").run(key);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO server_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, target);
  }

  setActiveProjectId(projectId: string | null): void {
    if (projectId === null) {
      this.db.prepare("DELETE FROM server_state WHERE key = 'active_project_id'").run();
      return;
    }
    this.db
      .prepare(
        "INSERT INTO server_state (key, value) VALUES ('active_project_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(projectId);
  }

  upsertProject(config: ProjectConfig): ProjectRecord {
    const timestamp = now();
    this.db
      .prepare(
        `
      INSERT INTO projects (id, name, remote_path, dev_command, dev_port, preview_path, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'inactive', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        remote_path = excluded.remote_path,
        dev_command = excluded.dev_command,
        dev_port = excluded.dev_port,
        preview_path = excluded.preview_path,
        updated_at = excluded.updated_at
    `,
      )
      .run(
        config.id,
        config.name,
        config.remotePath,
        config.devCommand,
        config.devPort,
        config.previewPath,
        timestamp,
        timestamp,
      );
    return this.getProject(config.id) as ProjectRecord;
  }

  getProject(id: string): ProjectRecord | undefined {
    const row = this.db
      .prepare(
        `
      SELECT id, name, remote_path AS remotePath, dev_command AS devCommand, dev_port AS devPort,
        preview_path AS previewPath, state, last_error AS lastError, started_at AS startedAt,
        first_sync_at AS firstSyncAt, updated_at AS updatedAt
      FROM projects WHERE id = ?
    `,
      )
      .get(id) as ProjectRow | undefined;
    return row ? mapProject(row) : undefined;
  }

  listProjects(): ProjectRecord[] {
    const rows = this.db
      .prepare(
        `
      SELECT id, name, remote_path AS remotePath, dev_command AS devCommand, dev_port AS devPort,
        preview_path AS previewPath, state, last_error AS lastError, started_at AS startedAt,
        first_sync_at AS firstSyncAt, updated_at AS updatedAt
      FROM projects ORDER BY name COLLATE NOCASE
    `,
      )
      .all() as ProjectRow[];
    return rows.map(mapProject);
  }

  updateProjectName(id: string, name: string): void {
    this.db
      .prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
      .run(name, now(), id);
  }

  updateProjectState(
    id: string,
    state: ProjectState,
    lastError: string | null,
    startedAt: string | null = null,
  ): void {
    this.db
      .prepare(
        "UPDATE projects SET state = ?, last_error = ?, started_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(state, lastError, startedAt, now(), id);
  }

  markFirstSync(id: string): void {
    this.db
      .prepare(
        "UPDATE projects SET first_sync_at = ?, updated_at = ? WHERE id = ? AND first_sync_at IS NULL",
      )
      .run(now(), now(), id);
  }

  deleteProject(id: string): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  createAgentSession(projectId: string, openCodeSessionId: string, title: string): SessionRecord {
    const timestamp = now();
    const id = randomUUID();
    this.db
      .prepare(
        `
        INSERT INTO agent_sessions
          (id, project_id, opencode_session_id, title, status, last_sequence, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'idle', 0, ?, ?)
      `,
      )
      .run(id, projectId, openCodeSessionId, title, timestamp, timestamp);
    this.appendAgentSessionEvent(id, "session.started", { openCodeSessionId }, true);
    return this.getAgentSession(id) as SessionRecord;
  }

  getAgentSession(id: string): SessionRecord | undefined {
    const row = this.db
      .prepare(
        `
        SELECT id, project_id AS projectId, opencode_session_id AS openCodeSessionId,
          title, status, last_sequence AS lastSequence, created_at AS createdAt, updated_at AS updatedAt
        FROM agent_sessions WHERE id = ?
      `,
      )
      .get(id) as SessionRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  getAgentSessionByOpenCodeId(openCodeSessionId: string): SessionRecord | undefined {
    const row = this.db
      .prepare(
        `
        SELECT id, project_id AS projectId, opencode_session_id AS openCodeSessionId,
          title, status, last_sequence AS lastSequence, created_at AS createdAt, updated_at AS updatedAt
        FROM agent_sessions WHERE opencode_session_id = ?
      `,
      )
      .get(openCodeSessionId) as SessionRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  listAgentSessions(projectId?: string): SessionRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT id, project_id AS projectId, opencode_session_id AS openCodeSessionId,
          title, status, last_sequence AS lastSequence, created_at AS createdAt, updated_at AS updatedAt
        FROM agent_sessions
        WHERE (? IS NULL OR project_id = ?)
        ORDER BY created_at DESC
      `,
      )
      .all(projectId ?? null, projectId ?? null) as SessionRow[];
    return rows.map(mapSession);
  }

  appendAgentSessionEvent(
    sessionId: string,
    type: SessionEventType,
    payload: Record<string, unknown>,
    durable = true,
  ): SessionEvent {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const session = this.db
        .prepare(
          "SELECT project_id AS projectId, last_sequence AS lastSequence FROM agent_sessions WHERE id = ?",
        )
        .get(sessionId) as { projectId: string; lastSequence: number } | undefined;
      if (!session) {
        throw new Error("agent_session_not_found");
      }
      const sequence = session.lastSequence + 1;
      const timestamp = now();
      this.db
        .prepare(
          `
          INSERT INTO agent_session_events
            (session_id, sequence, project_id, timestamp, type, durable, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          sessionId,
          sequence,
          session.projectId,
          timestamp,
          type,
          durable ? 1 : 0,
          JSON.stringify(payload),
        );
      this.db
        .prepare("UPDATE agent_sessions SET last_sequence = ?, updated_at = ? WHERE id = ?")
        .run(sequence, timestamp, sessionId);
      this.db.exec("COMMIT");
      return {
        sessionId,
        projectId: session.projectId,
        sequence,
        timestamp,
        type,
        durable,
        payload,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renameAgentSession(id: string, title: string): void {
    this.db
      .prepare("UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, now(), id);
  }

  hasUserPrompt(id: string): boolean {
    return (
      this.db
        .prepare(
          `
          SELECT 1 FROM agent_session_events
          WHERE session_id = ? AND type = 'session.message'
            AND json_extract(payload, '$.message.role') = 'user'
          LIMIT 1
        `,
        )
        .get(id) !== undefined
    );
  }

  setAgentSessionStatus(id: string, status: SessionStatus, lastSequence?: number): void {
    const timestamp = now();
    this.db
      .prepare(
        `
        UPDATE agent_sessions
        SET status = ?, updated_at = ?,
          last_sequence = CASE WHEN ? IS NULL THEN last_sequence ELSE ? END
        WHERE id = ?
      `,
      )
      .run(status, timestamp, lastSequence ?? null, lastSequence ?? null, id);
  }

  listAgentSessionEvents(sessionId: string, afterSequence = 0): SessionEvent[] {
    const rows = this.db
      .prepare(
        `
        SELECT session_id AS sessionId, project_id AS projectId, sequence, timestamp,
          type, durable, payload
        FROM agent_session_events
        WHERE session_id = ? AND sequence > ?
        ORDER BY sequence ASC
      `,
      )
      .all(sessionId, afterSequence) as SessionEventRow[];
    return rows.map(mapSessionEvent);
  }

  listDurableAgentSessionEvents(sessionId: string, afterSequence = 0): SessionEvent[] {
    return this.listAgentSessionEvents(sessionId, afterSequence).filter((event) => event.durable);
  }

  getLastDurableUserPrompt(sessionId: string): { text: string; model?: ModelRef } | undefined {
    const events = this.listDurableAgentSessionEvents(sessionId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "session.message") {
        continue;
      }
      const message = event.payload.message;
      if (typeof message !== "object" || message === null) {
        continue;
      }
      const { role, text, model } = message as Record<string, unknown>;
      if (role === "user" && typeof text === "string") {
        return isModelRef(model) ? { text, model } : { text };
      }
    }
    return undefined;
  }
}

function isModelRef(value: unknown): value is ModelRef {
  if (typeof value !== "object" || value === null) return false;
  const { providerId, modelId } = value as Record<string, unknown>;
  return typeof providerId === "string" && typeof modelId === "string";
}
