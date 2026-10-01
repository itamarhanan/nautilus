import type { IncomingMessage } from "node:http";
import type { ProjectConfig, ProjectRecord } from "@nautilus/types";
import type { Auth } from "../auth";
import type { EnvironmentStore } from "../environment";
import { HttpError } from "../errors";
import type { LifecycleJournal } from "../lifecycle-journal";
import type { Logger } from "../logger";
import type { PreviewTokens } from "../preview-tokens";
import type { ProjectManager } from "../project-manager";
import { type RateLimiter, requestRateKey } from "../rate-limiter";
import type { Registry } from "../registry";
import type { SessionService } from "../sessions";
import type { SyncCoordinator } from "../sync";
import { requestProjectId } from "../http/body";

export type AppContext = {
  registry: Registry;
  auth: Auth;
  logger: Logger;
  lifecycle: LifecycleJournal;
  projectManager: ProjectManager;
  environment: EnvironmentStore;

  projectMap: Map<string, ProjectConfig>;
  previewTokens: PreviewTokens;

  sessions?: SessionService | undefined;

  sync?: SyncCoordinator | undefined;
  limiters: {
    pairing: RateLimiter;
    prompt: RateLimiter;
    project: RateLimiter;
    preview: RateLimiter;
  };
  settings: {
    version: string;
    projectsRoot: string;
    devPortRange: [number, number];
    previewOrigin?: string | undefined;
    previewPort?: number | undefined;
    tunnelHealthUrl: string;
  };
};

export function enforceRateLimit(
  limiter: RateLimiter,
  request: IncomingMessage,
  category: string,
): void {
  if (!limiter.consume(`${category}:${requestRateKey(request)}`)) {
    throw new HttpError(429, "rate_limited", "Too many requests");
  }
}

export function requireSessions(context: AppContext): SessionService {
  if (!context.sessions) {
    throw new HttpError(503, "opencode_unavailable", "OpenCode bridge is not configured");
  }
  return context.sessions;
}

export function requireSync(context: AppContext): SyncCoordinator {
  if (!context.sync) {
    throw new HttpError(503, "sync_unavailable", "Synchronization is not configured");
  }
  return context.sync;
}

export function requireProject(context: AppContext, value: string | undefined): ProjectRecord {
  const project = context.registry.getProject(requestProjectId(value ?? ""));
  if (!project) {
    throw new HttpError(404, "project_not_found", "Project is not registered");
  }
  return project;
}
