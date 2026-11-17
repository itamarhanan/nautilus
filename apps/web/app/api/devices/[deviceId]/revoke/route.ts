import { requireAdmin } from "@/lib/server/auth";
import { isUuid, revokeDevice } from "@/lib/server/devices";
import { GatewayError, handled, json, logEvent } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const POST = handled(
  async (request: Request, context: { params: Promise<{ deviceId: string }> }) => {
    await requireAdmin(request);
    const { deviceId } = await context.params;
    if (!isUuid(deviceId) || !(await revokeDevice(deviceId))) {
      throw new GatewayError(404, "device_not_found", "Device is not found or already revoked");
    }
    logEvent("device_revoked", { deviceId });
    return json({ revoked: true });
  },
);
