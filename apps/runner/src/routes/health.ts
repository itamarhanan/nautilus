import type { BootstrapResponse } from "@nautilus/types";
import { HttpError } from "../errors";
import { sendJson } from "../http/respond";
import type { AppContext } from "./context";
import type { Route } from "./router";

async function tunnelAgentReady(syncAgentUrl: string): Promise<boolean> {
  const healthUrl = new URL("/health", syncAgentUrl);
  if (healthUrl.protocol !== "http:" || healthUrl.hostname !== "127.0.0.1") return false;
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function healthRoutes(context: AppContext): Route[] {
  const { lifecycle, projectManager, registry, settings } = context;
  const health = () => ({
    status: "ok",
    service: "nautilus-server",
    lifecycle: lifecycle.snapshot(),
    activeProject: projectManager.activeProject() ?? null,
  });
  return [
    {
      method: "GET",
      path: "/health",
      access: "public",
      handle: ({ response }) => {
        sendJson(response, 200, health());
        return Promise.resolve(200);
      },
    },
    {
      method: "GET",
      path: "/health/ready",
      access: "public",
      handle: ({ response }) => {
        const state = lifecycle.snapshot().state;
        if (!registry.isReady() || (state !== "ready" && state !== "degraded")) {
          throw new HttpError(503, "not_ready", "Server is not ready");
        }
        sendJson(response, 200, health());
        return Promise.resolve(200);
      },
    },
    {
      method: "GET",
      path: "/api/control/info",
      access: "admin",
      handle: ({ response }) => {
        sendJson(response, 200, {
          service: "nautilus-server",
          version: settings.version,
          lifecycle: lifecycle.snapshot(),
          activeProject: projectManager.activeProject() ?? null,
        });
        return Promise.resolve(200);
      },
    },
    {
      method: "GET",
      path: "/api/bootstrap",
      handle: ({ response, principal }) => {
        sendJson(response, 200, {
          device:
            principal?.kind === "device"
              ? (registry.findDeviceById(principal.deviceId) ?? null)
              : null,
          projects: registry.listProjects(),
          lifecycle: lifecycle.snapshot(),
          activeProject: projectManager.activeProject() ?? null,
        } satisfies BootstrapResponse);
        return Promise.resolve(200);
      },
    },
    {
      method: "GET",
      path: "/api/tunnel-health",
      access: "admin",
      handle: async ({ response }) => {
        const ready = await tunnelAgentReady(settings.tunnelHealthUrl);
        sendJson(response, ready ? 200 : 503, { ready });
        return ready ? 200 : 503;
      },
    },
  ];
}
