import { runnerIfReady } from "@/lib/runner/sandbox";
import { handled, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

// Public, so it never wakes the runner: it only reports whether it serves.
export const GET = handled(async () => {
  const runner = await runnerIfReady().catch(() => undefined);
  return json({ status: "ok", service: "nautilus-gateway", runner: runner ? "ready" : "asleep" });
});
