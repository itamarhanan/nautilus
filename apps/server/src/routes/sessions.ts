import { HttpError, SessionError } from "../errors";
import {
  bodyModel,
  bodyString,
  checkpointValue,
  readJson,
  requestAfterSequence,
  requestProjectId,
} from "../http/body";
import { sendJson } from "../http/respond";
import { streamSessionEvents } from "../http/sse";
import type { SessionService } from "../sessions";
import { type AppContext, enforceRateLimit, requireSessions } from "./context";
import type { Route, RouteRequest } from "./router";

function openCodeError(error: unknown, fallback: string): never {
  if (error instanceof SessionError) throw error;
  throw new HttpError(502, "opencode_error", error instanceof Error ? error.message : fallback);
}

function wantsStream({ request }: RouteRequest): boolean {
  return request.headers.accept?.toLowerCase().includes("text/event-stream") ?? false;
}

export function sessionRoutes(context: AppContext): Route[] {
  const { projectMap, limiters } = context;

  const session = ({ params }: RouteRequest): { sessions: SessionService; id: string } => {
    const sessions = requireSessions(context);
    const id = params.sessionId ?? "";
    if (!sessions.getSession(id)) {
      throw new HttpError(404, "session_not_found", "Session is not found");
    }
    return { sessions, id };
  };
  return [
    {
      method: "GET",
      path: "/api/sessions",
      handle: ({ response, url }) => {
        const sessions = requireSessions(context);
        const projectId = url.searchParams.get("projectId");
        sendJson(response, 200, {
          sessions: sessions.listSessions(projectId ? requestProjectId(projectId) : undefined),
        });
        return Promise.resolve(200);
      },
    },
    {
      method: "GET",
      path: "/api/models",
      handle: async ({ response }) => {
        const sessions = requireSessions(context);
        try {
          sendJson(response, 200, await sessions.listModels());
        } catch (error) {
          openCodeError(error, "Unable to list models");
        }
        return 200;
      },
    },
    {
      method: "POST",
      path: "/api/sessions",
      handle: async ({ request, response }) => {
        const sessions = requireSessions(context);
        const body = await readJson(request);
        const projectId = requestProjectId(body.projectId);
        if (!projectMap.has(projectId)) {
          throw new HttpError(
            400,
            "project_not_configured",
            "Project is not present in the server configuration",
          );
        }
        const title =
          typeof body.title === "string" && body.title.trim()
            ? body.title.trim()
            : "Nautilus session";
        if (title.length > 120) {
          throw new HttpError(400, "invalid_request", "title must be at most 120 characters");
        }
        try {
          sendJson(response, 201, {
            session: await sessions.createSession(projectId, title),
          });
        } catch (error) {
          openCodeError(error, "Unable to create OpenCode session");
        }
        return 201;
      },
    },
    {
      method: "GET",
      path: "/api/sessions/:sessionId",
      handle: (route) => {
        const { sessions, id } = session(route);
        sendJson(route.response, 200, sessions.snapshot(id, requestAfterSequence(route.request)));
        return Promise.resolve(200);
      },
    },
    {
      method: "POST",
      path: "/api/sessions/:sessionId/prompt",
      handle: async (route) => {
        const { sessions, id } = session(route);
        const { request, response } = route;
        enforceRateLimit(limiters.prompt, request, "prompt");
        const body = await readJson(request);
        const prompt = bodyString(body, "prompt", 200_000);
        const model = bodyModel(body);
        if (wantsStream(route)) {
          await streamSessionEvents(
            request,
            response,
            sessions,
            id,
            requestAfterSequence(request),
            () => sessions.prompt(id, prompt, { model }),
          );
          return 200;
        }
        try {
          await sessions.prompt(id, prompt, { model });
        } catch (error) {
          openCodeError(error, "Unable to submit prompt");
        }
        sendJson(response, 202, { accepted: true });
        return 202;
      },
    },
    {
      method: "POST",
      path: "/api/sessions/:sessionId/retry",
      handle: async (route) => {
        const { sessions, id } = session(route);
        const { request, response } = route;
        enforceRateLimit(limiters.prompt, request, "retry");
        if (wantsStream(route)) {
          await streamSessionEvents(
            request,
            response,
            sessions,
            id,
            requestAfterSequence(request),
            () => sessions.retry(id),
          );
          return 200;
        }
        try {
          await sessions.retry(id);
        } catch (error) {
          if (error instanceof SessionError) throw error;
          throw new HttpError(
            409,
            "retry_failed",
            error instanceof Error ? error.message : "Unable to retry this turn",
          );
        }
        sendJson(response, 202, { accepted: true });
        return 202;
      },
    },
    {
      method: "GET",
      path: "/api/sessions/:sessionId/events",
      handle: async (route) => {
        const { sessions, id } = session(route);
        await streamSessionEvents(
          route.request,
          route.response,
          sessions,
          id,
          requestAfterSequence(route.request),
        );
        return 200;
      },
    },
    {
      method: "POST",
      path: "/api/sessions/:sessionId/permissions/:permissionId",
      handle: async (route) => {
        const { sessions, id } = session(route);
        const body = await readJson(route.request);
        const answer = body.response;
        if (answer !== "once" && answer !== "always" && answer !== "reject") {
          throw new HttpError(
            400,
            "invalid_permission_response",
            "response must be once, always, or reject",
          );
        }
        try {
          await sessions.respondToPermission(id, route.params.permissionId ?? "", answer);
        } catch (error) {
          openCodeError(error, "Unable to respond to permission request");
        }
        sendJson(route.response, 200, { accepted: true });
        return 200;
      },
    },
    {
      method: "GET",
      path: "/api/sessions/:sessionId/changes",
      handle: async (route) => {
        const { sessions, id } = session(route);
        const commit = checkpointValue(route.url.searchParams.get("commit"));
        sendJson(route.response, 200, {
          diff: await sessions.changes(id, commit),
        });
        return 200;
      },
    },
    {
      method: "POST",
      path: "/api/sessions/:sessionId/revert",
      handle: async (route) => {
        const { sessions, id } = session(route);
        const body = await readJson(route.request);
        const result = await sessions.revert(id, checkpointValue(body.commit));
        const statusCode = result.status === "ok" ? 200 : 409;
        sendJson(route.response, statusCode, result);
        return statusCode;
      },
    },
    {
      method: "POST",
      path: "/api/sessions/:sessionId/interrupt",
      handle: async (route) => {
        const { sessions, id } = session(route);
        try {
          await sessions.interrupt(id);
        } catch (error) {
          openCodeError(error, "Unable to interrupt session");
        }
        sendJson(route.response, 200, { session: sessions.getSession(id) });
        return 200;
      },
    },
  ];
}
