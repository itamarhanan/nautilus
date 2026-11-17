import { NextResponse } from "next/server";
import { ConfigError } from "./config";

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json(
    { error: code, message },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

// Wraps a route handler so a thrown GatewayError becomes its JSON answer, and
// anything else a 500 that does not leak its message.
export function handled<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof GatewayError) {
        return errorResponse(error.status, error.code, error.message);
      }
      if (error instanceof ConfigError) {
        logEvent("gateway_misconfigured", { message: error.message });
        return errorResponse(503, "gateway_misconfigured", error.message);
      }
      logEvent("gateway_failed", {
        message: error instanceof Error ? error.message : "unknown_error",
      });
      return errorResponse(500, "internal_error", "Internal server error");
    }
  };
}

export async function readObject(
  request: Request,
  maxBytes = 16_384,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new GatewayError(413, "request_too_large", "Request body is too large");
  }
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Answered below.
  }
  throw new GatewayError(400, "invalid_json", "Request body must be a JSON object");
}

export function clientAddress(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ event, ...fields, at: new Date().toISOString() })}\n`);
}
