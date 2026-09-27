import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./errors";
import { RateLimiter, requestRateKey } from "./rate-limiter";
import type { Registry } from "./registry";

export type Principal = { kind: "admin" } | { kind: "device"; deviceId: string };

type SessionClaims = {
  iss: "nautilus";
  aud: "nautilus-pwa";
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  deviceId: string;
};

function encode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const item of header?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator > 0) {
      cookies.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
    }
  }
  return cookies;
}

export class Auth {
  private readonly failedAuth = new RateLimiter(30, 60_000);

  constructor(
    private readonly registry: Registry,
    private readonly authSecret: string,
    private readonly secureCookies = true,
    private readonly sessionSeconds = 28_800,
  ) {
    if (authSecret.length < 32) {
      throw new Error("Auth secret must be at least 32 characters");
    }
    if (!Number.isInteger(sessionSeconds) || sessionSeconds < 60 || sessionSeconds > 604_800) {
      throw new Error("Auth session duration must be between 60 and 604800 seconds");
    }
  }

  authenticate(request: IncomingMessage): Principal {
    const rateKey = requestRateKey(request);
    if (this.failedAuth.isLimited(rateKey)) {
      throw new HttpError(429, "rate_limited", "Too many authentication attempts");
    }

    const sessionToken = parseCookies(request.headers.cookie).get("nautilus_session");
    if (sessionToken) {
      const claims = this.verifySessionToken(sessionToken);
      if (claims) {
        const device = this.registry.findDeviceById(claims.deviceId);
        if (device && !device.revokedAt) {
          this.registry.touchDevice(device.id);
          return { kind: "device", deviceId: device.id };
        }
      }
    }

    this.failedAuth.recordFailure(rateKey);
    throw new HttpError(401, "unauthorized", "Invalid credentials");
  }

  issueSessionCookie(deviceId: string, response: ServerResponse): void {
    const device = this.registry.findDeviceById(deviceId);
    if (!device || device.revokedAt) {
      throw new HttpError(401, "unauthorized", "Device is not active");
    }
    const now = Math.floor(Date.now() / 1000);
    const claims: SessionClaims = {
      iss: "nautilus",
      aud: "nautilus-pwa",
      sub: device.id,
      jti: randomUUID(),
      iat: now,
      exp: now + this.sessionSeconds,
      deviceId: device.id,
    };
    const header = encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = encode(JSON.stringify(claims));
    const content = `${header}.${payload}`;
    const signature = createHmac("sha256", this.authSecret).update(content).digest("base64url");
    response.setHeader("Set-Cookie", this.cookie(`${content}.${signature}`, this.sessionSeconds));
  }

  clearSessionCookie(response: ServerResponse): void {
    response.setHeader("Set-Cookie", this.cookie("", 0));
  }

  private cookie(value: string, maxAge: number): string {
    return [
      `nautilus_session=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      ...(this.secureCookies ? ["Secure"] : []),
      `Max-Age=${String(maxAge)}`,
    ].join("; ");
  }

  private verifySessionToken(token: string): SessionClaims | undefined {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return undefined;
    }
    const [header, payload, signature] = parts;
    if (header === undefined || payload === undefined || signature === undefined) {
      return undefined;
    }
    const actual = Buffer.from(signature, "base64url");
    const expected = createHmac("sha256", this.authSecret).update(`${header}.${payload}`).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(decode(payload));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return undefined;
      }
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
        claims.iat > Math.floor(Date.now() / 1000) + 60 ||
        claims.exp <= Math.floor(Date.now() / 1000) ||
        claims.exp - claims.iat > this.sessionSeconds
      ) {
        return undefined;
      }
      return claims as unknown as SessionClaims;
    } catch {
      return undefined;
    }
  }
}
