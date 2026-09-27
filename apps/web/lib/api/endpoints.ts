import type {
  BootstrapResponse,
  DeviceResponse,
  PreviewTokenResponse,
  ProjectRecord,
  SyncEvent,
} from "@nautilus/types";
import { apiPost, apiRequest } from "./client";

const segment = encodeURIComponent;

export function bootstrap(): Promise<BootstrapResponse> {
  return apiRequest<BootstrapResponse>("/api/bootstrap");
}

export async function redeemPairingCode(code: string, deviceName: string): Promise<DeviceResponse> {
  const body = await apiPost<{ device: DeviceResponse }>("/api/pairing-codes/redeem", {
    code,
    deviceName,
  });
  return body.device;
}

export async function signOut(): Promise<void> {
  await apiPost<unknown>("/api/auth/sign-out");
}

export async function setProjectRunning(
  projectId: string,
  action: "start" | "stop",
): Promise<ProjectRecord> {
  const body = await apiPost<{ project: ProjectRecord }>(
    `/api/projects/${segment(projectId)}/${action}`,
  );
  return body.project;
}

export async function getSyncHistory(projectId: string): Promise<SyncEvent[]> {
  const body = await apiRequest<{ events: SyncEvent[] }>(
    `/api/projects/${segment(projectId)}/sync-history`,
  );
  return body.events;
}

export async function createPreviewUrl(projectId: string): Promise<string> {
  const body = await apiPost<PreviewTokenResponse>(
    `/api/projects/${segment(projectId)}/preview-token`,
    {
      ttlSeconds: 300,
    },
  );
  return body.previewUrl ?? `${body.previewPath}?token=${segment(body.token)}`;
}
