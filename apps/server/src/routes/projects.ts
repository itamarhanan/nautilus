import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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

export function projectRoutes(context: AppContext): Route[] {
  const { registry, projectMap, projectManager, previewTokens, sync, limiters, settings } = context;
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
      handle: ({ response, params }) => {
        const project = requireProject(context, params.projectId);
        if (project.state === "running" || project.state === "starting") {
          throw new HttpError(409, "project_running", "Stop the project before deleting it");
        }
        registry.deleteProject(project.id);
        sendJson(response, 204, null);
        return Promise.resolve(204);
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
          issued = previewTokens.issue(project, ttlSeconds);
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
