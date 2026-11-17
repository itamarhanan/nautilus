import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Principal } from "./auth";
import { HttpError } from "./errors";
import { firstHeader } from "./http/respond";

// Behind the gateway the runner keeps no phone credentials of its own. The
// gateway authenticates the caller and names it in x-nautilus-principal, and
// the runner believes that header only next to the runner key, which only the
// gateway knows.

const devicePrincipal = /^device:([0-9a-f-]{36})$/;
const relayTokenLifetimeMs = 15 * 60 * 1000;

function sameSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function gatewayPrincipal(request: IncomingMessage, runnerKey: string): Principal {
  const key = firstHeader(request.headers["x-nautilus-runner-key"]) ?? "";
  if (!sameSecret(key, runnerKey)) {
    throw new HttpError(401, "runner_unauthorized", "Requests must come through the gateway");
  }
  const principal = firstHeader(request.headers["x-nautilus-principal"]) ?? "";
  if (principal === "admin") return { kind: "admin" };
  const device = devicePrincipal.exec(principal)?.[1];
  if (device) return { kind: "device", deviceId: device };
  throw new HttpError(401, "runner_unauthorized", "Requests must come through the gateway");
}

function relaySignature(runnerKey: string, expiresAtMs: number): string {
  return createHmac("sha256", runnerKey)
    .update(`relay.${String(expiresAtMs)}`)
    .digest("base64url");
}

export function createRelayToken(
  runnerKey: string,
  now = Date.now(),
): { token: string; expiresAt: string } {
  const expiresAtMs = now + relayTokenLifetimeMs;
  return {
    token: `${String(expiresAtMs)}.${relaySignature(runnerKey, expiresAtMs)}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function verifyRelayToken(
  request: IncomingMessage,
  runnerKey: string,
  now = Date.now(),
): void {
  const authorization = firstHeader(request.headers.authorization) ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const [expires = "", signature = ""] = token.split(".");
  const expiresAtMs = /^\d{13}$/.test(expires) ? Number(expires) : 0;
  if (
    expiresAtMs <= now ||
    expiresAtMs > now + relayTokenLifetimeMs ||
    !sameSecret(signature, relaySignature(runnerKey, expiresAtMs))
  ) {
    throw new HttpError(401, "relay_unauthorized", "Relay token is invalid or expired");
  }
}
