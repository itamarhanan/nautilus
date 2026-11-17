import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ProjectConfig, ProjectId } from "@nautilus/types";

const projectIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const blockedExecutables = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "dash",
  "fish",
  "powershell",
  "powershell.exe",
  "sh",
  "zsh",
]);
const blockedArguments = new Set(["-c", "-e", "--eval", "--print"]);

export class ConfigurationError extends Error {}

export function validateProjectId(value: unknown): ProjectId {
  if (typeof value !== "string" || !projectIdPattern.test(value)) {
    throw new ConfigurationError("Project id must match ^[a-z0-9][a-z0-9_-]{0,63}$");
  }
  return value;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new ConfigurationError(
      `${field} must be a non-empty string of at most ${String(maxLength)} characters`,
    );
  }
  return value.trim();
}

export function parseProjectConfig(value: unknown): ProjectConfig {
  if (typeof value !== "object" || value === null) {
    throw new ConfigurationError("Each project must be an object");
  }

  const input = value as Record<string, unknown>;
  const rawRemotePath = requiredString(input.remotePath ?? input.remote_path, "remotePath", 4096);
  const remotePath =
    rawRemotePath === "~"
      ? homedir()
      : rawRemotePath.startsWith("~/")
        ? resolve(homedir(), rawRemotePath.slice(2))
        : rawRemotePath;
  const devCommand = requiredString(input.devCommand ?? input.dev_command, "devCommand", 4096);
  const previewPath = requiredString(input.previewPath ?? input.preview_path, "previewPath", 256);
  const devPort = input.devPort ?? input.dev_port;

  if (!isAbsolute(remotePath)) {
    throw new ConfigurationError("Project remotePath must be absolute");
  }
  if (!/^[1-9]\d*$/.test(String(devPort)) || Number(devPort) < 1 || Number(devPort) > 65535) {
    throw new ConfigurationError("Project devPort must be an integer between 1 and 65535");
  }
  if (!previewPath.startsWith("/") || !previewPath.endsWith("/")) {
    throw new ConfigurationError("Project previewPath must start and end with /");
  }
  if (/[;&|<>`$()\\]/.test(devCommand)) {
    throw new ConfigurationError("Project devCommand cannot contain shell operators");
  }
  const [executable, ...args] = devCommand.split(/\s+/).filter(Boolean);
  if (!executable || blockedExecutables.has(executable.toLowerCase())) {
    throw new ConfigurationError("Project devCommand cannot use a command shell");
  }
  if (args.some((argument) => blockedArguments.has(argument.toLowerCase()))) {
    throw new ConfigurationError("Project devCommand cannot evaluate inline code");
  }

  return {
    id: validateProjectId(input.id),
    name: requiredString(input.name, "name", 120),
    remotePath,
    devCommand,
    devPort: Number(devPort),
    previewPath,
  };
}

export function parseProjects(value: unknown): ProjectConfig[] {
  if (!Array.isArray(value)) {
    throw new ConfigurationError("Projects must be an array");
  }

  const ids = new Set<string>();
  return value.map((entry) => {
    const project = parseProjectConfig(entry);
    if (ids.has(project.id)) {
      throw new ConfigurationError(`Duplicate project id: ${project.id}`);
    }
    ids.add(project.id);
    return project;
  });
}

export async function loadProjects(env: NodeJS.ProcessEnv = process.env): Promise<ProjectConfig[]> {
  const inline = env.NAUTILUS_PROJECTS_JSON;
  const file = env.NAUTILUS_PROJECTS_FILE;
  if (inline) {
    return parseProjects(JSON.parse(inline) as unknown);
  }
  if (file) {
    return parseProjects(JSON.parse(await readFile(file, "utf8")) as unknown);
  }
  return [];
}

export type ServerOptions = {
  host: string;
  port: number;

  gatewayHost: string;
  gatewayPort: number;
  previewHost: string;

  webPort: number;
  sseHeartbeatMs: number;
  controlOrigins: string[];
  authSecret: string | undefined;
  secretsPath: string;
  controlHost: string;
  controlPort: number;
  projectsRoot: string;
  devPortRange: [number, number];
  secureCookies: boolean;
  devReadyTimeoutMs: number;
  previewSecret: string | undefined;
  previewSessionSeconds: number | undefined;
  previewOrigin: string | undefined;
  previewPort: number | undefined;
  registryPath: string;
  lifecyclePath: string;
  projectsFile: string | undefined;
  openCodeHost: string;
  openCodePort: number;
  openCodeDataDir: string;
  openCodeStartupTimeoutMs: number;
  syncShadowRoot: string;
  syncStatePath: string;
  syncAgentUrl: string;
  syncMaxFileBytes: number;
  syncMaxTotalBytes: number;
  syncMaxFileCount: number;
  syncRequestTimeoutMs: number;
};

export function loadServerOptions(env: NodeJS.ProcessEnv = process.env): ServerOptions {
  const gatewayHost = env.NAUTILUS_GATEWAY_HOST ?? "127.0.0.1";
  return {
    host: env.HOST ?? "127.0.0.1",
    // Not the generic PORT: a dev command that starts the runner next to its
    // PWA, as nautilus's own does, hands that one to both of them.
    port: Number(env.NAUTILUS_SERVER_PORT ?? 4000),
    gatewayHost,
    gatewayPort: Number(env.NAUTILUS_GATEWAY_PORT ?? 8080),
    previewHost: env.NAUTILUS_PREVIEW_HOST ?? gatewayHost,
    webPort: Number(env.NAUTILUS_WEB_PORT ?? 4002),
    sseHeartbeatMs: Number(env.NAUTILUS_SSE_HEARTBEAT_MS ?? 25_000),
    controlOrigins: (env.NAUTILUS_CONTROL_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    authSecret: env.NAUTILUS_AUTH_SECRET,
    secretsPath: env.NAUTILUS_SECRETS_PATH ?? `${env.HOME ?? "/tmp"}/nautilus/secrets`,
    controlHost: "127.0.0.1",
    controlPort: Number(env.NAUTILUS_CONTROL_PORT ?? 4001),
    projectsRoot: env.NAUTILUS_PROJECTS_ROOT ?? `${env.HOME ?? "/tmp"}/nautilus/projects`,
    devPortRange: parsePortRange(env.NAUTILUS_DEV_PORT_RANGE ?? "3100-3199"),
    secureCookies: env.NAUTILUS_SECURE_COOKIES !== "false",
    devReadyTimeoutMs: Number(env.NAUTILUS_DEV_READY_TIMEOUT_MS ?? 30_000),
    previewSecret: env.NAUTILUS_PREVIEW_SECRET,
    previewSessionSeconds: env.NAUTILUS_PREVIEW_SESSION_SECONDS
      ? Number(env.NAUTILUS_PREVIEW_SESSION_SECONDS)
      : undefined,
    previewOrigin: parsePreviewOrigin(env.NAUTILUS_PREVIEW_URL),
    previewPort: env.NAUTILUS_PREVIEW_PORT ? Number(env.NAUTILUS_PREVIEW_PORT) : undefined,
    registryPath: env.NAUTILUS_REGISTRY_PATH ?? `${env.HOME ?? "/tmp"}/nautilus/registry.sqlite`,
    lifecyclePath: env.NAUTILUS_LIFECYCLE_PATH ?? `${env.HOME ?? "/tmp"}/nautilus/journal.jsonl`,
    projectsFile: env.NAUTILUS_PROJECTS_FILE,
    openCodeHost: env.NAUTILUS_OPENCODE_HOST ?? "127.0.0.1",
    openCodePort: Number(env.NAUTILUS_OPENCODE_PORT ?? 4096),
    openCodeDataDir:
      env.NAUTILUS_OPENCODE_DATA_DIR ?? `${env.HOME ?? "/tmp"}/nautilus/opencode/state`,
    openCodeStartupTimeoutMs: Number(env.NAUTILUS_OPENCODE_STARTUP_TIMEOUT_MS ?? 30_000),
    syncShadowRoot: env.NAUTILUS_SYNC_SHADOW_ROOT ?? `${env.HOME ?? "/tmp"}/nautilus/shadow`,
    syncStatePath: env.NAUTILUS_SYNC_STATE_PATH ?? `${env.HOME ?? "/tmp"}/nautilus/sync-state`,
    syncAgentUrl: env.NAUTILUS_SYNC_AGENT_URL ?? "http://127.0.0.1:4200/v1/sync",
    syncMaxFileBytes: Number(env.NAUTILUS_SYNC_MAX_FILE_BYTES ?? 10_000_000),
    syncMaxTotalBytes: Number(env.NAUTILUS_SYNC_MAX_TOTAL_BYTES ?? 100_000_000),
    syncMaxFileCount: Number(env.NAUTILUS_SYNC_MAX_FILE_COUNT ?? 10_000),
    syncRequestTimeoutMs: Number(env.NAUTILUS_SYNC_REQUEST_TIMEOUT_MS ?? 30_000),
  };
}

function parsePreviewOrigin(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("NAUTILUS_PREVIEW_URL must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigurationError("NAUTILUS_PREVIEW_URL must use http or https");
  }
  return url.origin;
}

export function derivePreviewOrigin(
  host: string | undefined,
  protocol: string | undefined,
  previewPort: number,
): string | undefined {
  if (!host) return undefined;
  const scheme = protocol === "https" ? "https" : "http";
  let url: URL;
  try {
    url = new URL(`${scheme}://${host}`);
  } catch {
    return undefined;
  }
  const portLabel = /^\d{1,5}-(?=[^.]+\.)/.exec(url.hostname);
  if (portLabel) {
    url.hostname = `${String(previewPort)}-${url.hostname.slice(portLabel[0].length)}`;
    return url.origin;
  }
  if (url.port) {
    url.port = String(previewPort);
    return url.origin;
  }
  return undefined;
}

function parsePortRange(value: string): [number, number] {
  const match = /^(\d{1,5})-(\d{1,5})$/.exec(value.trim());
  const low = Number(match?.[1]);
  const high = Number(match?.[2]);
  if (!match || low < 1024 || high > 65535 || low > high) {
    throw new ConfigurationError("NAUTILUS_DEV_PORT_RANGE must look like 3100-3199");
  }
  return [low, high];
}
