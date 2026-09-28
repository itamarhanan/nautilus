import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type AgentProject = {
  id: string;
  name: string;
  localPath: string;
  shadowPath: string;
};

export type AgentConfig = {
  host: string;
  port: number;
  home: string;
  transactionPath: string;
  backupPath: string;
  // Every runner keeps its own base and history under runnersPath/<runner key>.
  // Recovery scans all of them, and the legacy folders from before that.
  runnersPath?: string;
  legacyTransactionPath?: string;
  legacyBackupPath?: string;
  lockPath?: string;
  statePath?: string;
  projects: AgentProject[];
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFileCount: number;
  maxBundleBytes: number;
  requestTimeoutMs: number;
};

const projectIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const runnerKeyPattern = /^[a-z0-9-]{1,64}$/;

export function runnerKeyValue(value: string | undefined): string {
  const key = value ?? "local";
  if (!runnerKeyPattern.test(key)) {
    throw new Error("NAUTILUS_AGENT_RUNNER must be 1 to 64 lowercase letters, digits or dashes");
  }
  return key;
}

function expandPath(value: string, home: string): string {
  const expanded =
    value === "~" ? home : value.startsWith("~/") ? resolve(home, value.slice(2)) : value;
  if (!isAbsolute(expanded)) {
    throw new Error("sync agent paths must be absolute or start with ~");
  }
  return resolve(expanded);
}

function numberValue(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}`);
  }
  return parsed;
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const home = env.HOME ?? homedir();
  const runnerKey = runnerKeyValue(env.NAUTILUS_AGENT_RUNNER);
  const root = expandPath("~/.nautilus", home);
  const runnersPath = join(root, "runners");
  return {
    host: "127.0.0.1",
    port: numberValue(env.NAUTILUS_AGENT_PORT, 4100, "NAUTILUS_AGENT_PORT", 1, 65535),
    home,
    transactionPath: join(runnersPath, runnerKey, "transactions"),
    backupPath: join(runnersPath, runnerKey, "backups"),
    runnersPath,
    legacyTransactionPath: join(root, "transactions"),
    legacyBackupPath: join(root, "backups"),
    lockPath: join(root, "locks"),
    statePath: expandPath(env.NAUTILUS_STATE_PATH ?? "~/.nautilus/state.json", home),
    projects: [],
    maxFileBytes: numberValue(
      env.NAUTILUS_SYNC_MAX_FILE_BYTES,
      10_000_000,
      "maxFileBytes",
      1,
      100_000_000,
    ),
    maxTotalBytes: numberValue(
      env.NAUTILUS_SYNC_MAX_TOTAL_BYTES,
      100_000_000,
      "maxTotalBytes",
      1,
      500_000_000,
    ),
    maxFileCount: numberValue(env.NAUTILUS_SYNC_MAX_FILE_COUNT, 10_000, "maxFileCount", 1, 100_000),
    maxBundleBytes: numberValue(
      env.NAUTILUS_SYNC_MAX_BUNDLE_BYTES,
      100_000_000,
      "maxBundleBytes",
      1,
      500_000_000,
    ),
    requestTimeoutMs: numberValue(
      env.NAUTILUS_SYNC_REQUEST_TIMEOUT_MS,
      30_000,
      "requestTimeoutMs",
      1_000,
      600_000,
    ),
  };
}

export async function loadStateProjects(statePath: string, home: string): Promise<AgentProject[]> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("state.json is not valid JSON", { cause: error });
  }
  const entries =
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { projects?: unknown }).projects)
      ? (value as { projects: unknown[] }).projects
      : [];
  const projects: AgentProject[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !projectIdPattern.test(record.id)) continue;
    if (typeof record.localPath !== "string") continue;
    const name = typeof record.name === "string" ? record.name : record.id;
    const shadowPath = expandPath(`~/.nautilus/shadow/${record.id}.git`, home);
    try {
      projects.push({
        id: record.id,
        name,
        localPath: expandPath(record.localPath, home),
        shadowPath,
      });
    } catch {
      continue;
    }
  }
  return projects;
}
