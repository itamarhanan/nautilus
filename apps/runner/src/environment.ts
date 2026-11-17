import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectEnvironment } from "@nautilus/types";
import { HttpError } from "./errors";

const keyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const projectIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const maxKeys = 200;
const maxBytes = 64 * 1024;
// Shorter values are words like "true" or "3000" that turn up everywhere, so
// hiding them would blank out half a transcript and protect nothing.
const minRedactedLength = 4;

// Only what a toolchain needs to find itself and the network. Everything else
// in the runner's own environment, model-provider keys and NAUTILUS_* settings
// included, stays out of the processes a project runs.
const inheritedNames = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TERM",
  "PNPM_HOME",
  "COREPACK_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

export function baseEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && inheritedNames.has(name)) environment[name] = value;
  }
  return environment;
}

export function parseEnvironmentUpdate(body: Record<string, unknown>): Record<string, string> {
  const variables = body.variables;
  if (typeof variables !== "object" || variables === null || Array.isArray(variables)) {
    throw new HttpError(400, "invalid_environment", "variables must be an object");
  }
  const entries = Object.entries(variables as Record<string, unknown>);
  if (entries.length > maxKeys) {
    throw new HttpError(
      400,
      "invalid_environment",
      `A project can hold at most ${String(maxKeys)} keys`,
    );
  }
  let bytes = 0;
  const parsed: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!keyPattern.test(key)) {
      throw new HttpError(400, "invalid_environment_key", `${key} is not a valid variable name`);
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw new HttpError(400, "invalid_environment_value", `${key} must be a plain string`);
    }
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    parsed[key] = value;
  }
  if (bytes > maxBytes) {
    throw new HttpError(400, "invalid_environment", "Environment exceeds 64KB");
  }
  return parsed;
}

type StoredEnvironment = {
  variables: Record<string, string>;
  updatedAt: string;
};

// Each project's preview values live in a 0600 file under the runner's
// secrets folder, outside the project folder the agent works in, so they
// survive restarts without the desktop and never enter sync.
export class EnvironmentStore {
  private readonly cache = new Map<string, StoredEnvironment | null>();

  constructor(private readonly directory: string) {}

  private path(projectId: string): string {
    if (!projectIdPattern.test(projectId)) {
      throw new HttpError(400, "invalid_project_id", "Project id is not valid");
    }
    return join(this.directory, `${projectId}.json`);
  }

  private async load(projectId: string): Promise<StoredEnvironment | null> {
    if (this.cache.has(projectId)) return this.cache.get(projectId) ?? null;
    const stored = await readFile(this.path(projectId), "utf8")
      .then((contents) => JSON.parse(contents) as StoredEnvironment)
      .catch(() => null);
    this.cache.set(projectId, stored);
    return stored;
  }

  async variables(projectId: string): Promise<Record<string, string>> {
    return { ...(await this.load(projectId))?.variables };
  }

  async describe(projectId: string): Promise<ProjectEnvironment> {
    const stored = await this.load(projectId);
    return {
      keys: Object.keys(stored?.variables ?? {}).sort(),
      updatedAt: stored?.updatedAt ?? null,
    };
  }

  // Reports whether anything changed, so an unchanged push restarts nothing.
  async replace(projectId: string, variables: Record<string, string>): Promise<boolean> {
    const path = this.path(projectId);
    const current = (await this.load(projectId))?.variables ?? {};
    if (sameVariables(current, variables)) return false;
    if (Object.keys(variables).length === 0) {
      await this.remove(projectId);
      return true;
    }
    const stored: StoredEnvironment = { variables, updatedAt: new Date().toISOString() };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${String(process.pid)}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(stored));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    this.cache.set(projectId, stored);
    return true;
  }

  async remove(projectId: string): Promise<void> {
    await rm(this.path(projectId), { force: true });
    this.cache.set(projectId, null);
  }

  // Values are replaced longest first, so a value that contains a shorter one
  // is hidden whole rather than leaving a recognizable remainder.
  async redactor(projectId: string): Promise<(text: string) => string> {
    const secrets = Object.entries((await this.load(projectId))?.variables ?? {})
      .filter(([, value]) => value.length >= minRedactedLength)
      .sort(([, a], [, b]) => b.length - a.length);
    if (secrets.length === 0) return (text) => text;
    return (text) =>
      secrets.reduce((result, [key, value]) => result.replaceAll(value, `[redacted:${key}]`), text);
  }
}

function sameVariables(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
}

export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => redactDeep(item, redact)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactDeep(item, redact)]),
    ) as T;
  }
  return value;
}
