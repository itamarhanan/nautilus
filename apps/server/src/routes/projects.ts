import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ProjectConfig } from "@nautilus/types";
import { ConfigurationError, derivePreviewOrigin, parseProjectConfig } from "../config";
import { HttpError } from "../errors";
import { bodyString, readJson, requestProjectId } from "../http/body";
import { firstHeader, sendJson } from "../http/respond";
import { type AppContext, enforceRateLimit, requireProject } from "./context";
import type { Route } from "./router";

function allocateDevPort(used: Set<number>, [low, high]: [number, number]): number {
  for (let port = low; port <= high; port += 1) {
    if (!used.has(port)) return port;
  }
  throw new HttpError(409, "dev_ports_exhausted", "No free dev-server port is left in the range");
}

// Only a plain web origin is kept, so a stray header binds a token to nothing.
function requestOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function projectConfig(value: unknown): ProjectConfig {
  try {
    return parseProjectConfig(value);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw new HttpError(400, "invalid_project", error.message);
    }
    throw error;
  }
}

// Only a real directory strictly inside the projects root is removed. A path
// given at registration may point anywhere, so a symlink, the root itself, or
// anything that resolves outside it is left on disk.
async function removeProjectFolder(remotePath: string, projectsRoot: string): Promise<boolean> {
  try {
    const entry = await lstat(remotePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (entry === null) return true;
    if (!entry.isDirectory()) return false;
    const [root, target] = await Promise.all([realpath(projectsRoot), realpath(remotePath)]);
    const inside = relative(root, target);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      return false;
    }
    await rm(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function projectRoutes(context: AppContext): Route[] {
  const {
    registry,
    projectMap,
    projectManager,
    previewTokens,
    sync,
    lifecycle,
    logger,
    limiters,
    settings,
  } = context;
  return [
    {
      method: "GET",
      path: "/api/projects",
      handle: ({ response }) => {
        sendJson(response, 200, { projects: registry.listProjects() });
        return Promise.resolve(200);
      },
    },
    {
      method: "POST",
      path: "/api/projects",
      access: "admin",
      handle: async ({ request, response }) => {
        const body = await readJson(request);
        const id = requestProjectId(body.projectId);
        let project = projectMap.get(id);
        if (!project) {
          const usedPorts = new Set([
            ...registry.listProjects().map((entry) => entry.devPort),
            ...[...projectMap.values()].map((entry) => entry.devPort),
          ]);
          project = projectConfig({
            id,
            name: body.name,
            remotePath: body.remotePath ?? body.remote_path ?? join(settings.projectsRoot, id),
            devCommand: body.devCommand ?? body.dev_command ?? "pnpm dev",
            devPort:
              body.devPort ?? body.dev_port ?? allocateDevPort(usedPorts, settings.devPortRange),
            previewPath: body.previewPath ?? body.preview_path ?? `/preview/${id}/`,
          });
          projectMap.set(id, project);
        }

        try {
          await mkdir(project.remotePath, { recursive: true, mode: 0o700 });
        } catch {
          throw new HttpError(500, "remote_path_unavailable", "Project directory is not available");
        }
        sync?.addProject(project);
        sendJson(response, 201, { project: registry.upsertProject(project) });
        return 201;
      },
    },
    {
      method: "GET",
      path: "/api/projects/:projectId",
      handle: ({ response, params }) => {
        sendJson(response, 200, {
          project: requireProject(context, params.projectId),
        });
        return Promise.resolve(200);
      },
    },
    {
      method: "PUT",
      path: "/api/projects/:projectId",
      access: "admin",
      handle: async ({ request, response, params }) => {
        const project = requireProject(context, params.projectId);
        const body = await readJson(request);

        const name = body.name === undefined ? project.name : bodyString(body, "name", 120);
        if (body.devCommand === undefined) {
          registry.updateProjectName(project.id, name);
        } else {
          const configured = projectMap.get(project.id);
          if (!configured) {
            throw new HttpError(
              409,
              "project_not_configured",
              "Register the project again before changing its dev command",
            );
          }

          const next = projectConfig({
            ...configured,
            name,
            devCommand: bodyString(body, "devCommand", 4096),
          });

          projectMap.set(project.id, next);
          registry.upsertProject(next);
        }
        sendJson(response, 200, {
          project: requireProject(context, project.id),
        });
        return 200;
      },
    },
    {
      method: "DELETE",
      path: "/api/projects/:projectId",
      access: "admin",
      handle: async ({ response, params }) => {
        const project = requireProject(context, params.projectId);
        if (project.state === "running" || project.state === "starting") {
          throw new HttpError(409, "project_running", "Stop the project before deleting it");
        }
        if (
          project.state === "editing" ||
          project.state === "checkpointing" ||
          registry.listAgentSessions(project.id).some((session) => session.status === "running")
        ) {
          throw new HttpError(
            409,
            "agent_running",
            "Wait for the agent to finish, or stop it, before deleting the project",
          );
        }

        // Leaving the map first means no prompt, start or sync can pick the
        // project up while its files are being removed.
        const configured = projectMap.get(project.id);
        projectMap.delete(project.id);
        try {
          await sync?.removeProject(project.id);
        } catch (error) {
          if (configured) projectMap.set(project.id, configured);
          throw error;
        }
        await projectManager.stop(project.id);
        registry.deleteProject(project.id);
        await lifecycle.clearDegradedProject(project.id);
        if (!(await removeProjectFolder(project.remotePath, settings.projectsRoot))) {
          logger.info("project_folder_kept", { projectId: project.id });
        }
        sendJson(response, 204, null);
        return 204;
      },
    },
    {
      method: "POST",
      path: "/api/projects/:projectId/preview-token",
      handle: async ({ request, response, params, channel }) => {
        const project = requireProject(context, params.projectId);
        enforceRateLimit(limiters.preview, request, "preview-token");
        const body = await readJson(request);
        const ttlSeconds = body.ttlSeconds === undefined ? 120 : Number(body.ttlSeconds);
        let issued: ReturnType<typeof previewTokens.issue>;
        try {
          issued = previewTokens.issue(project, ttlSeconds, requestOrigin(request.headers.origin));
        } catch (error) {
          throw new HttpError(
            400,
            "invalid_preview_token_ttl",
            error instanceof Error ? error.message : "Invalid preview token TTL",
          );
        }

        const origin =
          settings.previewOrigin ??
          (channel === "public" && settings.previewPort !== undefined
            ? derivePreviewOrigin(
                firstHeader(request.headers["x-forwarded-host"]) ?? request.headers.host,
                firstHeader(request.headers["x-forwarded-proto"]),
                settings.previewPort,
              )
            : undefined);
        sendJson(
          response,
          201,
          origin
            ? {
                ...issued,
                previewUrl: `${origin}/?token=${encodeURIComponent(issued.token)}`,
              }
            : issued,
        );
        return 201;
      },
    },
    {
      method: "POST",
      path: "/api/projects/:projectId/start",
      handle: async ({ request, response, params }) => {
        const project = requireProject(context, params.projectId);
        enforceRateLimit(limiters.project, request, "project-control");
        sendJson(response, 200, {
          project: await projectManager.start(project.id),
        });
        return 200;
      },
    },
    {
      method: "POST",
      path: "/api/projects/:projectId/stop",
      handle: async ({ request, response, params }) => {
        const project = requireProject(context, params.projectId);
        enforceRateLimit(limiters.project, request, "project-control");
        sendJson(response, 200, {
          project: await projectManager.stop(project.id),
        });
        return 200;
      },
    },
  ];
}
