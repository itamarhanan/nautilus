import type { IncomingMessage, ServerResponse } from "node:http";
import type { Auth, Principal } from "../auth";
import { HttpError } from "../errors";

export type Channel = "public" | "control";

type Access = "public" | "device" | "admin";

export type RouteRequest = {
  request: IncomingMessage;
  response: ServerResponse;
  channel: Channel;
  url: URL;
  params: Readonly<Record<string, string>>;

  principal: Principal | null;
};

export type Route = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;

  access?: Access;

  handle: (request: RouteRequest) => Promise<number>;
};

type Match = { route: Route; params: Record<string, string> };

function match(routes: readonly Route[], method: string, pathname: string): Match | undefined {
  const segments = pathname.split("/").slice(1);
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = route.path.split("/").slice(1);
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const matched = pattern.every((part, index) => {
      const segment = segments[index];
      if (segment === undefined) return false;
      if (!part.startsWith(":")) return part === segment;
      try {
        params[part.slice(1)] = decodeURIComponent(segment);
      } catch {
        throw new HttpError(400, "invalid_request", "Path is not valid");
      }
      return true;
    });
    if (matched) return { route, params };
  }
  return undefined;
}

export function createRouter(
  routes: readonly Route[],
  auth: Auth,
): (request: IncomingMessage, response: ServerResponse, channel: Channel) => Promise<number> {
  return async (request, response, channel) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const found = match(routes, request.method ?? "GET", url.pathname);

    const access = found?.route.access ?? "device";
    const principal: Principal | null =
      channel === "control"
        ? { kind: "admin" }
        : access === "public" && found
          ? null
          : auth.authenticate(request);
    if (!found) throw new HttpError(404, "not_found", "Route not found");
    if (access === "admin" && principal?.kind !== "admin") {
      throw new HttpError(404, "not_found", "Route not found");
    }
    return found.route.handle({
      request,
      response,
      channel,
      url,
      params: found.params,
      principal,
    });
  };
}
