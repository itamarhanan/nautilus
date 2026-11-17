import type { IncomingMessage } from "node:http";
import { HttpError } from "../errors";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

const desktopOrigins = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

export function controlGuard(
  extraOrigins: readonly string[] = [],
): (request: IncomingMessage) => void {
  const origins = new Set([...desktopOrigins, ...extraOrigins]);
  return (request) => {
    const host = request.headers.host ?? "";
    const hostname = host.startsWith("[")
      ? host.slice(0, host.indexOf("]") + 1)
      : (host.split(":")[0] ?? "");
    const origin = request.headers.origin;
    if (
      !loopbackHosts.has(hostname) ||
      (origin !== undefined && !origins.has(origin)) ||
      request.headers["x-nautilus-control"] !== "1"
    ) {
      throw new HttpError(403, "forbidden", "Control requests must come from the Nautilus desktop");
    }
  };
}
