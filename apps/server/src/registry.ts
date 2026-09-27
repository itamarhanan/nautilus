import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
}
