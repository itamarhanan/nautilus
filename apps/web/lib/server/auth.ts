import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";
import { adminToken, authSecret, secureCookies } from "./config";
import { findDevice, touchDevice } from "./devices";
import { GatewayError } from "./http";

// A session lasts until its device is revoked or the phone signs out, never
// for a set time. Browsers keep a cookie for at most 400 days, so a phone that
// connects gets a fresh cookie once a day and its copy never runs out.
const SESSION_SECONDS = 400 * 24 * 60 * 60;
const RENEW_AFTER_SECONDS = 24 * 60 * 60;
const COOKIE = "nautilus_session";

export type Principal = { kind: "admin" } | { kind: "device"; deviceId: string };

export type Authenticated = { principal: Principal; renew: boolean };

type SessionClaims = {
  iss: "nautilus";
  aud: "nautilus-pwa";
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  deviceId: string;
};

function sameSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sign(content: string): string {
  return createHmac("sha256", authSecret()).update(content).digest("base64url");
}

export function sessionToken(deviceId: string, now = Math.floor(Date.now() / 1000)): string {
  const claims: SessionClaims = {
    iss: "nautilus",
    aud: "nautilus-pwa",
    sub: deviceId,
    jti: randomUUID(),
    iat: now,
    exp: now + SESSION_SECONDS,
    deviceId,
  };
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

export function verifySessionToken(
  token: string,
  now = Math.floor(Date.now() / 1000),
): SessionClaims | undefined {
  const [header, payload, signature, extra] = token.split(".");
  if (!header || !payload || !signature || extra !== undefined) return undefined;
  if (!sameSecret(signature, sign(`${header}.${payload}`))) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const claims = parsed as Record<string, unknown>;
    if (
      claims.iss !== "nautilus" ||
      claims.aud !== "nautilus-pwa" ||
      typeof claims.sub !== "string" ||
      typeof claims.jti !== "string" ||
      typeof claims.iat !== "number" ||
      typeof claims.exp !== "number" ||
      typeof claims.deviceId !== "string" ||
      claims.sub !== claims.deviceId ||
      claims.iat > now + 60 ||
      claims.exp <= now ||
      claims.exp - claims.iat > SESSION_SECONDS
    ) {
      return undefined;
    }
    return claims as unknown as SessionClaims;
  } catch {
    return undefined;
  }
}

function cookieValue(request: Request): string | undefined {
  for (const item of request.headers.get("cookie")?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator > 0 && item.slice(0, separator).trim() === COOKIE) {
      return item.slice(separator + 1).trim();
    }
  }
  return undefined;
}

// A cookie request that changes something must come from this origin, and
// carry the header the PWA adds, which a cross-site form cannot.
function assertSameOrigin(request: Request): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let sameOrigin: boolean;
  try {
    sameOrigin = origin !== null && host !== null && new URL(origin).host === host;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin || request.headers.get("x-nautilus-request") !== "1") {
    throw new GatewayError(403, "forbidden", "Cross-site request refused");
  }
}

function unauthorized(): GatewayError {
  return new GatewayError(401, "unauthorized", "Invalid credentials");
}

export async function authenticate(request: Request): Promise<Authenticated> {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (token && sameSecret(token, adminToken())) {
      return { principal: { kind: "admin" }, renew: false };
    }
    throw unauthorized();
  }
  const cookie = cookieValue(request);
  // The signature is checked before anything else, so a request without a
  // valid cookie never reaches Postgres or the runner.
  const claims = cookie ? verifySessionToken(cookie) : undefined;
  if (!claims) throw unauthorized();
  assertSameOrigin(request);
  const device = await findDevice(claims.deviceId);
  if (!device || device.revokedAt) throw unauthorized();
  await touchDevice(device.id);
  return {
    principal: { kind: "device", deviceId: device.id },
    renew: claims.iat <= Math.floor(Date.now() / 1000) - RENEW_AFTER_SECONDS,
  };
}

export async function requireAdmin(request: Request): Promise<void> {
  const { principal } = await authenticate(request);
  // A phone asking for an admin route is told the route does not exist.
  if (principal.kind !== "admin") throw new GatewayError(404, "not_found", "Route not found");
}

export function principalHeader(principal: Principal): string {
  return principal.kind === "admin" ? "admin" : `device:${principal.deviceId}`;
}

export function setSessionCookie(response: NextResponse, deviceId: string): void {
  response.cookies.set(COOKIE, sessionToken(deviceId), {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: SESSION_SECONDS,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: 0,
  });
}

export function finish(response: NextResponse, auth: Authenticated): NextResponse {
  if (auth.renew && auth.principal.kind === "device") {
    setSessionCookie(response, auth.principal.deviceId);
  }
  return response;
}
