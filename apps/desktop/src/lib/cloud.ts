// Minimal client for the new Vercel-backed cloud API.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const httpFetch: typeof fetch = (input, init) =>
  typeof window !== "undefined" && (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    ? tauriFetch(input, init)
    : fetch(input, init);

export type CloudDevice = { id: string; kind: "phone" | "desktop" };

export async function createDevice(baseUrl: string, kind: "phone" | "desktop"): Promise<CloudDevice> {
  const res = await httpFetch(`${baseUrl}/api/cloud/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  if (!res.ok) throw new Error(`createDevice failed: ${res.status}`);
  return (await res.json()) as CloudDevice;
}

export async function createPairingCode(baseUrl: string, deviceId: string): Promise<{ code: string; expiresAt: string }> {
  const res = await httpFetch(`${baseUrl}/api/cloud/devices/${deviceId}/pairing-codes`, { method: "POST" });
  if (!res.ok) throw new Error(`createPairingCode failed: ${res.status}`);
  return (await res.json()) as { code: string; expiresAt: string };
}

export async function redeemPairing(baseUrl: string, code: string, deviceId?: string): Promise<{ linkedDeviceId: string }> {
  const res = await httpFetch(`${baseUrl}/api/cloud/pairings/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceId }),
  });
  if (!res.ok) throw new Error(`redeemPairing failed: ${res.status}`);
  return (await res.json()) as { linkedDeviceId: string };
}

export async function createProject(baseUrl: string, name: string, ownerDeviceId: string): Promise<{ id: string; name: string }> {
  const res = await httpFetch(`${baseUrl}/api/cloud/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ownerDeviceId }),
  });
  if (!res.ok) throw new Error(`createProject failed: ${res.status}`);
  return (await res.json()) as { id: string; name: string };
}

export async function createWorktree(baseUrl: string, projectId: string, name: string): Promise<{ id: string; name: string }> {
  const res = await httpFetch(`${baseUrl}/api/cloud/projects/${projectId}/worktrees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`createWorktree failed: ${res.status}`);
  return (await res.json()) as { id: string; name: string };
}

export async function runTurn(baseUrl: string, sessionId: string, prompt: string, baseBundleBase64?: string): Promise<Response> {
  return httpFetch(`${baseUrl}/api/cloud/turns/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, prompt, baseBundleBase64 }),
  });
}

export async function createSession(baseUrl: string, projectId: string, worktreeId: string): Promise<{ id: string }> {
  const res = await httpFetch(`${baseUrl}/api/cloud/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, worktreeId }),
  });
  if (!res.ok) throw new Error(`createSession failed: ${res.status}`);
  return (await res.json()) as { id: string };
}

export async function uploadBaseBundle(baseUrl: string, worktreeId: string, baseHead: string | null, bundleBase64: string): Promise<void> {
  const res = await httpFetch(`${baseUrl}/api/cloud/worktrees/${worktreeId}/base`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseHead, bundleBase64 }),
  });
  if (!res.ok) throw new Error(`uploadBaseBundle failed: ${res.status}`);
}

export async function fetchLatestBundle(baseUrl: string, worktreeId: string): Promise<{ bundleBase64: string | null; head: string | null; baseHead: string | null }> {
  const res = await httpFetch(`${baseUrl}/api/cloud/worktrees/${worktreeId}/bundle`);
  if (!res.ok) throw new Error(`fetchLatestBundle failed: ${res.status}`);
  return (await res.json()) as { bundleBase64: string | null; head: string | null; baseHead: string | null };
}
