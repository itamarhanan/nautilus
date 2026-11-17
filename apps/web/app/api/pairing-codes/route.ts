import { requireAdmin } from "@/lib/server/auth";
import { createPairingCode } from "@/lib/server/devices";
import { GatewayError, handled, json, readObject } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const POST = handled(async (request: Request) => {
  await requireAdmin(request);
  const body = await readObject(request);
  const deviceName =
    typeof body.deviceName === "string" && body.deviceName.trim()
      ? body.deviceName.trim().slice(0, 120)
      : "Phone";
  const ttlSeconds = body.ttlSeconds === undefined ? 600 : Number(body.ttlSeconds);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) {
    throw new GatewayError(400, "invalid_ttl", "ttlSeconds must be between 60 and 3600");
  }
  return json(await createPairingCode(deviceName, ttlSeconds), 201);
});
