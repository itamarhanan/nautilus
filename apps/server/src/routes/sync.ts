import { parseResolutions, type SyncResponse } from "@nautilus/types";
import { HttpError } from "../errors";
import { readJson, requestGrant, requestIdValue } from "../http/body";
import { sendJson } from "../http/respond";
import { type AppContext, requireProject, requireSync } from "./context";
import type { Route } from "./router";

function syncHttpStatus(result: SyncResponse): number {
  switch (result.status) {
    case "ok":
      return 200;
    case "conflict":
    case "stale":
      return 409;
    case "invalid":
      return result.error?.code.startsWith("grant_") ? 403 : 400;
    case "offline":
      return 503;
    default:
      return 502;
  }
}

function direction(value: unknown): "pull" | "push" {
  if (value !== "pull" && value !== "push") {
    throw new HttpError(400, "invalid_sync_direction", "direction must be pull or push");
  }
  return value;
}

export function syncRoutes(context: AppContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/projects/:projectId/sync-history",
      access: "admin",
      handle: async ({ response, params }) => {
        const project = requireProject(context, params.projectId);
        sendJson(response, 200, {
          events: await requireSync(context).history(project.id),
        });
        return 200;
      },
    },
    {
      method: "GET",
      path: "/api/projects/:projectId/sync-status",
      access: "admin",
      handle: async ({ response, params }) => {
        const project = requireProject(context, params.projectId);
        sendJson(response, 200, await requireSync(context).status(project.id));
        return 200;
      },
    },
    {
      method: "POST",
      path: "/api/projects/:projectId/sync-rewind",
      access: "admin",
      handle: async ({ request, response, params }) => {
        const project = requireProject(context, params.projectId);
        const coordinator = requireSync(context);
        const body = await readJson(request);
        if (typeof body.from !== "string" || typeof body.to !== "string") {
          throw new HttpError(400, "invalid_request", "from and to are required");
        }
        await coordinator.rewindBase(project.id, body.from, body.to);
        sendJson(response, 200, { rewound: true });
        return 200;
      },
    },
    {
      method: "POST",
      path: "/api/projects/:projectId/sync-requests/preview",
      access: "admin",
      handle: async ({ request, response, params }) => {
        const project = requireProject(context, params.projectId);
        const coordinator = requireSync(context);
        const body = await readJson(request);
        const toward = direction(body.direction);
        const result = await coordinator.preview(
          project.id,
          toward,
          requestGrant(body.grant, project.id, toward),
          requestIdValue(body.requestId),
        );
        const statusCode = syncHttpStatus(result);
        sendJson(response, statusCode, result);
        return statusCode;
      },
    },
    {
      method: "POST",
      path: "/api/projects/:projectId/sync-requests",
      access: "admin",
      handle: async ({ request, response, params }) => {
        const project = requireProject(context, params.projectId);
        const coordinator = requireSync(context);
        const body = await readJson(request);
        const toward = direction(body.direction);
        const grant = requestGrant(body.grant, project.id, toward);
        const requestId = requestIdValue(body.requestId);
        const resolutions = parseResolutions(body.resolutions);
        const result =
          toward === "pull"
            ? await coordinator.pull(project.id, grant, requestId, resolutions)
            : await coordinator.push(project.id, grant, requestId, resolutions);
        const statusCode = syncHttpStatus(result);
        sendJson(response, statusCode, result);
        return statusCode;
      },
    },
  ];
}
