import { ApiError } from "./api";

export function friendlyError(error: unknown): Error {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return new Error("The deployment refused the admin token. Check NAUTILUS_ADMIN_TOKEN.");
    }
    if (error.code === "runner_starting") {
      return new Error("The runner is still starting. Nautilus keeps trying.");
    }
    if (error.code === "gateway_misconfigured") return new Error(error.message);
    if (error.code === "runner_offline") {
      return new Error("The Nautilus deployment is not reachable. Check the address.");
    }
    return error;
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.code === "runner_offline")
    return "The runner is not reachable.";
  if (error instanceof ApiError && error.code === "agent_offline")
    return "The sync agent is not running.";
  return error instanceof Error && error.message ? error.message : fallback;
}
