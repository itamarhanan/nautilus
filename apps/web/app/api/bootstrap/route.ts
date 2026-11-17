import type { BootstrapResponse, RecoverySummary } from "@nautilus/types";
import { after } from "next/server";
import { forward } from "@/lib/runner/forward";
import { ensureRunner, runnerIfReady } from "@/lib/runner/sandbox";
import { authenticate, finish } from "@/lib/server/auth";
import { findDevice } from "@/lib/server/devices";
import { handled, json, logEvent } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function starting(): RecoverySummary {
  const now = new Date().toISOString();
  return {
    state: "starting",
    startedAt: now,
    updatedAt: now,
    recovered: false,
    interruptedSessions: 0,
    degradedProjects: [],
    reason: "The runner is waking up",
  };
}

// Never waits for a cold start: while the runner wakes the phone gets a
// placeholder at once and polls until the runner is ready.
export const GET = handled(async (request: Request) => {
  const auth = await authenticate(request);
  const device =
    auth.principal.kind === "device" ? ((await findDevice(auth.principal.deviceId)) ?? null) : null;
  const ready = await runnerIfReady().catch(() => undefined);
  if (ready !== undefined) {
    const upstream = await forward(request, auth, "/api/bootstrap");
    if (upstream.ok) {
      const body = (await upstream.json()) as BootstrapResponse;
      return finish(json({ ...body, device } satisfies BootstrapResponse), auth);
    }
  }
  after(() =>
    ensureRunner().catch((error: unknown) => {
      logEvent("runner_wake_failed", {
        message: error instanceof Error ? error.message : "unknown_error",
      });
    }),
  );
  return finish(
    json({
      device,
      projects: [],
      lifecycle: starting(),
      activeProject: null,
    } satisfies BootstrapResponse),
    auth,
  );
});
