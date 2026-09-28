import { parseResolutions, type SyncEvent, type SyncResponse } from "@nautilus/types";
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

// A phone reads the history too. The events hold no grants or bundles, but
// events.json is read back as written, so only the known fields go out.
function deviceSyncEvent(event: SyncEvent): SyncEvent {
  return {
    requestId: event.requestId,
    projectId: event.projectId,
    direction: event.direction,
    status: event.status,
    baseHead: event.baseHead,
    localHead: event.localHead,
    remoteHead: event.remoteHead,
    errorCode: event.errorCode,
    conflicts: event.conflicts.map(({ path, reason, pc, runner }) => ({
      path,
      reason,
      ...(pc ? { pc } : {}),
      ...(runner ? { runner } : {}),
    })),
    createdAt: event.createdAt,
    committedAt: event.committedAt,
    ...(event.undone ? { undone: true } : {}),
  };
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
      handle: async ({ response, params, principal }) => {
        const project = requireProject(context, params.projectId);
        const events = await requireSync(context).history(project.id);
        sendJson(response, 200, {
          events: principal?.kind === "admin" ? events : events.map(deviceSyncEvent),
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
