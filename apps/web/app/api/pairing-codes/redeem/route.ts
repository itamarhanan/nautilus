import { setSessionCookie } from "@/lib/server/auth";
import { consumeRateLimit, redeemPairingCode } from "@/lib/server/devices";
import {
  clientAddress,
  GatewayError,
  handled,
  json,
  logEvent,
  readObject,
} from "@/lib/server/http";

export const dynamic = "force-dynamic";

function text(value: unknown, key: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new GatewayError(400, "invalid_request", `${key} must be a non-empty string`);
  }
  return value.trim();
}

export const POST = handled(async (request: Request) => {
  // Counted before anything else runs, so guessing codes is slow.
  if (!(await consumeRateLimit(`pairing-redeem:${clientAddress(request)}`, 20, 60))) {
    throw new GatewayError(429, "rate_limited", "Too many requests");
  }
  const body = await readObject(request);
  const code = text(body.code, "code", 32);
  const deviceName = text(body.deviceName, "deviceName", 120);
  const device = await redeemPairingCode(code, deviceName);
  if (!device) {
    throw new GatewayError(
      400,
      "pairing_code_invalid",
      "Pairing code is invalid, expired, or already used",
    );
  }
  logEvent("device_paired", { deviceId: device.id });
  const response = json({ device }, 201);
  setSessionCookie(response, device.id);
  return response;
});
