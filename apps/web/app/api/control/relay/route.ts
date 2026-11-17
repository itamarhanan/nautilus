import { relayToken } from "@/lib/runner/relay";
import { ensureRunner } from "@/lib/runner/sandbox";
import { requireAdmin } from "@/lib/server/auth";
import { runnerKey } from "@/lib/server/config";
import { handled, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The PC's sync agent polls the runner directly for the length of a sync, so
// bundles never pass through a function and its size and time limits.
export const POST = handled(async (request: Request) => {
  await requireAdmin(request);
  const url = await ensureRunner();
  return json({ url, ...relayToken(runnerKey()) });
});
