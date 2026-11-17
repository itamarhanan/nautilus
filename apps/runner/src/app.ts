import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectConfig } from "@nautilus/types";
import { Auth } from "./auth";
import { ConfigurationError, loadProjects, loadServerOptions, type ServerOptions } from "./config";
import { EnvironmentStore } from "./environment";
import { HttpError, toHttpError } from "./errors";
import { controlGuard } from "./http/control";
import { sendError } from "./http/respond";
import { LifecycleJournal } from "./lifecycle-journal";
import { Logger } from "./logger";
import type { OpenCodeService } from "./opencode";
import { PreviewTokens } from "./preview-tokens";
import { ProjectManager } from "./project-manager";
import { RateLimiter } from "./rate-limiter";
import { Registry } from "./registry";
import type { AppContext } from "./routes/context";
import { deviceRoutes } from "./routes/devices";
import { healthRoutes } from "./routes/health";
import { projectRoutes } from "./routes/projects";
import { type Channel, createRouter } from "./routes/router";
import { sessionRoutes } from "./routes/sessions";
import { syncRoutes } from "./routes/sync";
import { loadOrCreateSecret } from "./secrets";
import { SessionService } from "./sessions";
import type { SyncCoordinator } from "./sync";

export type { Channel } from "./routes/router";

export type AppOptions = {
  registryPath?: string;
  lifecyclePath?: string;
  lifecycle?: LifecycleJournal;
  authSecret?: string;
  secretsPath?: string;
  projectsRoot?: string;
  devPortRange?: [number, number];
  secureCookies?: boolean;
  previewSecret?: string;
  previewSessionSeconds?: number;
  previewOrigin?: string | undefined;

  previewPort?: number | undefined;
  projects?: ProjectConfig[];
  logger?: Logger;
  devReadyTimeoutMs?: number;
  openCode?: OpenCodeService;
  sync?: SyncCoordinator;
  tunnelHealthUrl?: string;
};

export type NautilusApp = {
  server: Server;
  controlServer: Server;
  registry: Registry;
  auth: Auth;
  previewTokens: PreviewTokens;
  sessions?: SessionService | undefined;
  sync?: SyncCoordinator | undefined;
  lifecycle: LifecycleJournal;
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  handleControl: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  close: () => Promise<void>;
};

// The `catch` below turns a bad path into a silent "unknown", so the `../` here
// is load-bearing: the bundle is emitted as `dist/main.js`, one level below the
// package root. Keep it in step with the `entry` in tsdown.config.ts.
const serverVersion = (() => {
  try {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
})();

function runnerPorts(serverOptions: ServerOptions, previewPort: number | undefined): number[] {
  const syncAgentPort = Number(new URL(serverOptions.syncAgentUrl).port);
  return [
    serverOptions.port,
    serverOptions.controlPort,
    serverOptions.gatewayPort,
    serverOptions.webPort,
    serverOptions.openCodePort,
    ...(previewPort === undefined ? [] : [previewPort]),
    ...(syncAgentPort > 0 ? [syncAgentPort] : []),
  ];
}

async function checkProjects(
  sync: SyncCoordinator,
  registry: Registry,
  lifecycle: LifecycleJournal,
): Promise<void> {
  await sync.recoverAll();
  const validations = await sync.validateAll();
  const pendingCheckpoints = await sync.pendingCheckpoints();
  for (const [projectId, validation] of validations) {
    if (validation.dirty || !validation.valid || pendingCheckpoints.includes(projectId)) {
      const reason = pendingCheckpoints.includes(projectId)
        ? "checkpoint_incomplete"
        : validation.valid
          ? "shadow_worktree_changed"
          : `shadow_invalid:${validation.error ?? "unknown"}`;
      registry.updateProjectState(projectId, "unhealthy", reason);
      lifecycle.recordDegradedProject(projectId);
    }
  }
}

export async function createNautilusApp(options: AppOptions = {}): Promise<NautilusApp> {
  const logger = options.logger ?? new Logger();
  const serverOptions = loadServerOptions();
  const lifecycle =
    options.lifecycle ?? new LifecycleJournal(options.lifecyclePath ?? serverOptions.lifecyclePath);
  await lifecycle.initialize();
  await lifecycle.transition("starting");
  const secretsPath = options.secretsPath ?? serverOptions.secretsPath;
  const authSecret =
    options.authSecret ??
    serverOptions.authSecret ??
    (await loadOrCreateSecret(join(secretsPath, "auth-secret")));
  if (authSecret.length < 32) {
    throw new ConfigurationError("NAUTILUS_AUTH_SECRET must be at least 32 characters");
  }

  const projects = options.projects ?? (await loadProjects());
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const registry = new Registry(options.registryPath ?? serverOptions.registryPath);
  registry.recoverInterruptedProjects();
  for (const project of projects) {
    registry.upsertProject(project);
  }
  // A project the desktop registered is kept only in the registry; a projects
  // file holds just the ones that exist before any desktop connects. Without
  // this, every desktop project is "not configured" after a restart and can be
  // neither started, prompted nor synced.
  for (const {
    id,
    name,
    remotePath,
    devCommand,
    devPort,
    previewPath,
  } of registry.listProjects()) {
    if (!projectMap.has(id)) {
      projectMap.set(id, { id, name, remotePath, devCommand, devPort, previewPath });
    }
  }
  const auth = new Auth(registry, authSecret, options.secureCookies ?? serverOptions.secureCookies);
  const previewTokens = new PreviewTokens(
    options.previewSecret ?? serverOptions.previewSecret ?? authSecret,
    (tokenIdHash, projectId, expiresAt) => {
      registry.createPreviewToken(tokenIdHash, projectId, expiresAt);
    },
    (tokenIdHash, sessionTokenHash, projectId, expiresAt) =>
      registry.redeemPreviewToken(tokenIdHash, sessionTokenHash, projectId, expiresAt),
    (sessionTokenHash) => registry.findPreviewSession(sessionTokenHash)?.projectId,
    options.previewSessionSeconds ?? serverOptions.previewSessionSeconds,
  );
  const environment = new EnvironmentStore(join(secretsPath, "projects"));
  const sync = options.sync;
  for (const project of projectMap.values()) {
    sync?.addProject(project);
  }
  const projectManager = new ProjectManager(
    registry,
    projectMap,
    logger,
    options.devReadyTimeoutMs ?? serverOptions.devReadyTimeoutMs,
    sync ? (projectId) => sync.hasCode(projectId) : undefined,
    runnerPorts(serverOptions, options.previewPort ?? serverOptions.previewPort),
    (projectId) => environment.variables(projectId),
  );
  if (sync) {
    sync.connect({
      onEvent: (event) => {
        if (event.direction === "system" && event.remoteHead) {
          void lifecycle.recordCheckpoint(event.projectId, event.remoteHead);
        }
      },
      onFirstSync: (projectId) => {
        registry.markFirstSync(projectId);
      },
      busy: (projectId) =>
        registry.getProject(projectId)?.state === "checkpointing" ||
        registry.listAgentSessions(projectId).some((session) => session.status === "running"),
    });
    await checkProjects(sync, registry, lifecycle);
  }
  await projectManager.stopLeftovers();
  await projectManager.recoverActiveProject();
  const sessions = options.openCode
    ? new SessionService(options.openCode, registry, projectMap, logger, sync, environment)
    : undefined;
  if (options.openCode && sessions) {
    await options.openCode.start();
    await lifecycle.recordService("opencode", "start");
    for (const session of await sessions.start()) {
      await lifecycle.recordInterruptedSessions(1, session.projectId);
    }
  }
  await lifecycle.transition(
    lifecycle.snapshot().degradedProjects.length > 0 ? "degraded" : "ready",
  );

  const context: AppContext = {
    registry,
    auth,
    logger,
    lifecycle,
    projectManager,
    environment,
    projectMap,
    previewTokens,
    sessions,
    sync,
    limiters: {
      pairing: new RateLimiter(20, 60_000),
      prompt: new RateLimiter(60, 60_000),
      project: new RateLimiter(30, 60_000),
      preview: new RateLimiter(30, 60_000),
    },
    settings: {
      version: serverVersion,
      projectsRoot: options.projectsRoot ?? serverOptions.projectsRoot,
      devPortRange: options.devPortRange ?? serverOptions.devPortRange,
      previewOrigin: options.previewOrigin ?? serverOptions.previewOrigin,
      previewPort: options.previewPort ?? serverOptions.previewPort,
      tunnelHealthUrl: options.tunnelHealthUrl ?? serverOptions.syncAgentUrl,
    },
  };
  const route = createRouter(
    [
      ...healthRoutes(context),
      ...deviceRoutes(context),
      ...sessionRoutes(context),
      ...projectRoutes(context),
      ...syncRoutes(context),
    ],
    auth,
  );
  const assertControlRequest = controlGuard(serverOptions.controlOrigins);

  async function handleChannel(
    request: IncomingMessage,
    response: ServerResponse,
    channel: Channel,
  ): Promise<void> {
    const startedAt = Date.now();
    let statusCode = 500;
    try {
      if (channel === "control") assertControlRequest(request);
      statusCode = await route(request, response, channel);
    } catch (error) {
      const httpError =
        toHttpError(error) ?? new HttpError(500, "internal_error", "Internal server error");
      if (httpError.statusCode === 500) {
        logger.error("request_failed", {
          error: error instanceof Error ? error.message : "unknown_error",
        });
      }
      sendError(response, httpError.statusCode, httpError.code, httpError.message);
      statusCode = httpError.statusCode;
    } finally {
      logger.info("request_completed", {
        channel,
        method: request.method,
        path: request.url?.split("?")[0],
        statusCode,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  const handle = (request: IncomingMessage, response: ServerResponse) =>
    handleChannel(request, response, "public");
  const handleControl = (request: IncomingMessage, response: ServerResponse) =>
    handleChannel(request, response, "control");
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  const controlServer = createServer((request, response) => {
    void handleControl(request, response);
  });

  return {
    server,
    controlServer,
    registry,
    auth,
    previewTokens,
    sessions,
    sync,
    lifecycle,
    handle,
    handleControl,
    close: async () => {
      await lifecycle.transition("stopped");
      if (sessions) await lifecycle.recordService("opencode", "stop");
      await sessions?.close();
      await projectManager.stopAll();
      server.closeAllConnections();
      controlServer.closeAllConnections();
      registry.close();
      await Promise.all(
        [server, controlServer].map(
          (listener) =>
            new Promise<void>((resolve, reject) => {
              if (!listener.listening) {
                resolve();
                return;
              }
              listener.close((error) => {
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              });
            }),
        ),
      );
    },
  };
}
