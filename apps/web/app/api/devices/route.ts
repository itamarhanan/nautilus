import { requireAdmin } from "@/lib/server/auth";
import { listDevices } from "@/lib/server/devices";
import { handled, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const GET = handled(async (request: Request) => {
  await requireAdmin(request);
  return json({ devices: await listDevices() });
});
