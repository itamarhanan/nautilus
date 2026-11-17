import type { SyncDirection, SyncResolutions, SyncResponse } from "@nautilus/types";
import { ApiError, type AgentApi, type ControlApi } from "./api";

export type SyncSessionOptions = {
  projectId: string;
  direction: SyncDirection;
  control: ControlApi;
  agent: AgentApi;
  onStep?: (step: SyncStep) => void;
  // How long to wait for the agent's first poll to reach the runner.
  relayTimeoutMs?: number;
};

export type SyncStep = "authorizing" | "tunnel" | "reviewing" | "applying" | "closing";

// One sync: a grant from the local agent, a relay the agent opens to the
// runner, then the review and the apply, and both taken down at the end.
export class SyncSession {
  private grantId: string | undefined;
  private grant: string | undefined;
  private relaying = false;
  private closed = false;

  constructor(private readonly options: SyncSessionOptions) {}

  async preview(signal?: AbortSignal): Promise<SyncResponse> {
    const { agent, control, direction, projectId } = this.options;
    this.options.onStep?.("authorizing");
    const minted = await agent.mintGrant(projectId, direction);
    this.grant = minted.grant;
    this.grantId = minted.claims.grantId;
    this.options.onStep?.("tunnel");
    await agent.startRelay(await control.relay());
    this.relaying = true;
    const deadline = Date.now() + (this.options.relayTimeoutMs ?? 30_000);
    while (!(await control.tunnelHealth())) {
      if (signal?.aborted) throw new ApiError("cancelled", "Cancelled", 0);
      if (Date.now() > deadline) {
        throw new ApiError(
          "relay_unavailable",
          "The sync agent could not reach the runner. Check your connection and try again.",
          0,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    this.options.onStep?.("reviewing");
    return settle(() =>
      control.syncPreview(projectId, direction, {
        grant: minted.grant,
        signal,
      }),
    );
  }

  async apply(
    requestId: string | undefined,
    signal?: AbortSignal,
    resolutions?: SyncResolutions,
  ): Promise<SyncResponse> {
    if (!this.grant) throw new Error("preview the sync before applying it");
    this.options.onStep?.("applying");
    const { control, direction, projectId } = this.options;
    return settle(() =>
      control.sync(projectId, direction, {
        grant: this.grant as string,
        signal,
        ...(requestId ? { requestId } : {}),
        ...(resolutions ? { resolutions } : {}),
      }),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.options.onStep?.("closing");
    const grantId = this.grantId;
    this.grant = undefined;
    await Promise.all([
      grantId ? this.options.agent.revokeGrant(grantId).catch(() => undefined) : undefined,
      this.relaying ? this.options.agent.stopRelay().catch(() => undefined) : undefined,
    ]);
  }
}

async function settle(request: () => Promise<SyncResponse>): Promise<SyncResponse> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof ApiError && error.syncResponse) return error.syncResponse;
    throw error;
  }
}
