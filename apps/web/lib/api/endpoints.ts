import type {
  BootstrapResponse,
  DeviceResponse,
  ModelRef,
  ModelsResponse,
  PreviewTokenResponse,
  ProjectRecord,
  SessionRecord,
  SessionSnapshot,
  SyncDiff,
  SyncEvent,
} from "@nautilus/types";
import { ApiError, apiPost, apiRequest } from "./client";

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

export async function listSessions(projectId: string): Promise<SessionRecord[]> {
  const body = await apiRequest<{ sessions: SessionRecord[] }>(
    `/api/sessions?projectId=${segment(projectId)}`,
  );
  return body.sessions;
}

export async function createSession(projectId: string, title: string): Promise<SessionRecord> {
  const body = await apiPost<{ session: SessionRecord }>("/api/sessions", {
    projectId,
    title,
  });
  return body.session;
}

export function getSession(sessionId: string, signal?: AbortSignal): Promise<SessionSnapshot> {
  return apiRequest<SessionSnapshot>(`/api/sessions/${segment(sessionId)}`, {
    signal,
  });
}

export function sessionEventsUrl(sessionId: string, afterSequence: number): string {
  return `/api/sessions/${segment(sessionId)}/events?after=${String(afterSequence)}`;
}

export async function sendPrompt(
  sessionId: string,
  prompt: string,
  model: ModelRef | null = null,
): Promise<void> {
  await apiPost<unknown>(
    `/api/sessions/${segment(sessionId)}/prompt`,
    model ? { prompt, model } : { prompt },
  );
}

export async function respondToPermission(
  sessionId: string,
  permissionId: string,
  response: "once" | "always" | "reject",
): Promise<void> {
  await apiPost<unknown>(
    `/api/sessions/${segment(sessionId)}/permissions/${segment(permissionId)}`,
    { response },
  );
}

export async function getCheckpointChanges(sessionId: string, commit: string): Promise<SyncDiff> {
  const body = await apiRequest<{ diff: SyncDiff }>(
    `/api/sessions/${segment(sessionId)}/changes?commit=${segment(commit)}`,
  );
  return body.diff;
}

export type RevertResult =
  | {
      status: "ok";
      checkpoint: { commit: string; previousHead: string | null };
    }
  | { status: "conflict"; conflicts: string[] };

export async function revertCheckpoint(sessionId: string, commit: string): Promise<RevertResult> {
  const body = await apiPost<RevertResult | { error?: string; message?: string }>(
    `/api/sessions/${segment(sessionId)}/revert`,
    { commit },
    { acceptStatuses: [409] },
  );
  if ("status" in body) return body;

  throw new ApiError(body.message ?? "Unable to undo this turn", 409, body.error);
}

export async function interruptSession(sessionId: string): Promise<void> {
  await apiPost<unknown>(`/api/sessions/${segment(sessionId)}/interrupt`);
}

export function listModels(): Promise<ModelsResponse> {
  return apiRequest<ModelsResponse>("/api/models");
}

export async function retrySession(sessionId: string): Promise<void> {
  await apiPost<unknown>(`/api/sessions/${segment(sessionId)}/retry`);
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
