import type { ServerResponse } from "node:http";

export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (statusCode === 204) {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export function sendError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  sendJson(response, statusCode, { error: code, message });
}

export function firstHeader(value: string | string[] | undefined): string | undefined {
  const first = (Array.isArray(value) ? value[0] : value)?.split(",", 1)[0]?.trim();
  return first || undefined;
}
