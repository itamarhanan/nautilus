import type { SyncDirection, SyncResolutions, SyncResponse } from "@nautilus/types";
import { ApiError, type AgentApi, type ControlApi } from "./api";
import type { Spawner } from "./process";
import type { DesktopSettings } from "./settings";
import { resolveHomePath, SshForward, syncArgs } from "./ssh";

export type SyncSessionOptions = {
  projectId: string;
  direction: SyncDirection;
  control: ControlApi;
  agent: AgentApi;
  settings: DesktopSettings;
  home: string;
  spawn: Spawner;

  localMode: boolean;
  onStep?: (step: SyncStep) => void;
};

export type SyncStep = "authorizing" | "tunnel" | "reviewing" | "applying" | "closing";

export class SyncSession {
  private grantId: string | undefined;
  private grant: string | undefined;
  private tunnel: SshForward | undefined;
  private closed = false;

  constructor(private readonly options: SyncSessionOptions) {}

  async preview(signal?: AbortSignal): Promise<SyncResponse> {
    const { agent, control, direction, projectId } = this.options;
    this.options.onStep?.("authorizing");
    const minted = await agent.mintGrant(projectId, direction);
    this.grant = minted.grant;
    this.grantId = minted.claims.grantId;
    if (!this.options.localMode) {
      this.options.onStep?.("tunnel");
      const keyPath = resolveHomePath(this.options.settings.ssh.keyPath, this.options.home);
      this.tunnel = new SshForward(
        "nautilus-ssh-sync",
        syncArgs(this.options.settings, keyPath),
        this.options.spawn,
      );
      await this.tunnel.start(() => control.tunnelHealth(), 20_000);
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
      this.tunnel?.stop(),
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
