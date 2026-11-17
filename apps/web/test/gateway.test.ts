import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyRelayToken } from "../../runner/src/runner-access";
import { relayToken } from "@/lib/runner/relay";
import { authenticate, principalHeader, sessionToken, verifySessionToken } from "@/lib/server/auth";
import { runnerKey } from "@/lib/server/config";
import { normalizeCode } from "@/lib/server/devices";
import { GatewayError } from "@/lib/server/http";

const deviceId = "6f1c2a52-6a4b-4c1e-9d8e-0d3c6c1f2b7a";

beforeEach(() => {
  vi.stubEnv("NAUTILUS_AUTH_SECRET", "s".repeat(40));
  vi.stubEnv("NAUTILUS_ADMIN_TOKEN", "a".repeat(40));
  vi.stubEnv("NAUTILUS_RUNNER_KEY", "");
  vi.stubEnv("DATABASE_URL", "");
});

async function rejection(request: Request): Promise<GatewayError> {
  const error = await authenticate(request).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(GatewayError);
  return error as GatewayError;
}

describe("gateway auth", () => {
  it("signs phone sessions and rejects tampered or expired ones", () => {
    const token = sessionToken(deviceId);
    expect(verifySessionToken(token)?.deviceId).toBe(deviceId);
    const [header, payload, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as object),
        deviceId: "other",
      }),
    ).toString("base64url");
    expect(verifySessionToken(`${header ?? ""}.${forged}.${signature ?? ""}`)).toBeUndefined();
    const longAgo = Math.floor(Date.now() / 1000) - 401 * 24 * 60 * 60;
    expect(verifySessionToken(sessionToken(deviceId, longAgo))).toBeUndefined();
    vi.stubEnv("NAUTILUS_AUTH_SECRET", "t".repeat(40));
    expect(verifySessionToken(token)).toBeUndefined();
  });

  it("accepts the admin token and refuses everything else before touching Postgres", async () => {
    const admin = await authenticate(
      new Request("https://n.example/api/projects", {
        headers: { authorization: `Bearer ${"a".repeat(40)}` },
      }),
    );
    expect(principalHeader(admin.principal)).toBe("admin");

    const wrong = await rejection(
      new Request("https://n.example/api/projects", {
        headers: { authorization: `Bearer ${"b".repeat(40)}` },
      }),
    );
    expect([wrong.status, wrong.code]).toEqual([401, "unauthorized"]);
    const anonymous = await rejection(new Request("https://n.example/api/projects"));
    expect(anonymous.status).toBe(401);
    const garbage = await rejection(
      new Request("https://n.example/api/projects", {
        headers: { cookie: "nautilus_session=a.b.c" },
      }),
    );
    expect(garbage.status).toBe(401);
  });

  it("refuses a cross-site cookie request before looking the phone up", async () => {
    const cookie = `nautilus_session=${sessionToken(deviceId)}`;
    const crossSite = await rejection(
      new Request("https://n.example/api/sessions", {
        method: "POST",
        headers: {
          cookie,
          origin: "https://evil.example",
          host: "n.example",
          "x-nautilus-request": "1",
        },
      }),
    );
    expect([crossSite.status, crossSite.code]).toEqual([403, "forbidden"]);
    const noHeader = await rejection(
      new Request("https://n.example/api/sessions", {
        method: "POST",
        headers: { cookie, origin: "https://n.example", host: "n.example" },
      }),
    );
    expect(noHeader.status).toBe(403);
  });

  it("mints relay tokens the runner accepts with the derived key", () => {
    const key = runnerKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { token } = relayToken(key);
    const request = { headers: { authorization: `Bearer ${token}` } };
    expect(() => {
      verifyRelayToken(request as never, key);
    }).not.toThrow();
    expect(() => {
      verifyRelayToken(request as never, `${key}x`);
    }).toThrow();
  });

  it("forgives case, spaces and dashes in typed pairing codes", () => {
    expect(normalizeCode("abcd-2345 ")).toBe("ABCD2345");
  });
});
