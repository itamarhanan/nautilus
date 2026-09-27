import { HttpError } from "../errors";
import { bodyString, readJson } from "../http/body";
import { sendJson } from "../http/respond";
import type { Registry } from "../registry";
import { type AppContext, enforceRateLimit } from "./context";
import type { Route } from "./router";

export function deviceRoutes(context: AppContext): Route[] {
  const { auth, logger, registry, limiters } = context;
  const signOut: Route["handle"] = ({ response }) => {
    auth.clearSessionCookie(response);
    sendJson(response, 200, { loggedOut: true });
    return Promise.resolve(200);
  };
  return [
    {
      method: "POST",
      path: "/api/pairing-codes/redeem",
      access: "public",
      handle: async ({ request, response }) => {
        enforceRateLimit(limiters.pairing, request, "pairing-redeem");
        const body = await readJson(request);
        const deviceName = bodyString(body, "deviceName", 120);
        const code = bodyString(body, "code", 32);
        let result: ReturnType<Registry["redeemPairingCode"]>;
        try {
          result = registry.redeemPairingCode(code, deviceName);
        } catch {
          throw new HttpError(
            400,
            "pairing_code_invalid",
            "Pairing code is invalid, expired, or already used",
          );
        }
        logger.info("device_paired", { deviceId: result.device.id });
        auth.issueSessionCookie(result.device.id, response);
        sendJson(response, 201, { device: result.device });
        return 201;
      },
    },
    { method: "POST", path: "/api/session/logout", access: "public", handle: signOut },
    { method: "POST", path: "/api/auth/sign-out", access: "public", handle: signOut },
    {
      method: "POST",
      path: "/api/pairing-codes",
      access: "admin",
      handle: async ({ request, response }) => {
        enforceRateLimit(limiters.pairing, request, "pairing-create");
        const body = await readJson(request);
        const deviceName =
          typeof body.deviceName === "string" && body.deviceName.trim()
            ? body.deviceName.trim()
            : "Phone";
        const ttlSeconds = body.ttlSeconds === undefined ? 600 : Number(body.ttlSeconds);
        if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) {
          throw new HttpError(400, "invalid_ttl", "ttlSeconds must be between 60 and 3600");
        }
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
        const pairing = registry.createPairingCode(deviceName, expiresAt);
        logger.info("pairing_code_created", { pairingId: pairing.id, deviceName });
        sendJson(response, 201, pairing);
        return 201;
      },
    },
    {
      method: "GET",
      path: "/api/devices",
      access: "admin",
      handle: ({ response }) => {
        sendJson(response, 200, { devices: registry.listDevices() });
        return Promise.resolve(200);
      },
    },
    {
      method: "POST",
      path: "/api/devices/:deviceId/revoke",
      access: "admin",
      handle: ({ response, params }) => {
        if (!registry.revokeDevice(params.deviceId ?? "")) {
          throw new HttpError(404, "device_not_found", "Device is not found or already revoked");
        }
        logger.info("device_revoked", { deviceId: params.deviceId ?? "" });
        sendJson(response, 200, { revoked: true });
        return Promise.resolve(200);
      },
    },
  ];
}
