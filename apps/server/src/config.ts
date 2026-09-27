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
