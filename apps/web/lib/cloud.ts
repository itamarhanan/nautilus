export async function createCloudDevice(kind: "phone" | "desktop") {
  const res = await fetch("/api/cloud/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  if (!res.ok) throw new Error(`createCloudDevice failed: ${res.status}`);
  return res.json() as Promise<{ id: string; kind: string }>;
}

export async function createCloudProject(name: string, ownerDeviceId: string) {
  const res = await fetch("/api/cloud/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ownerDeviceId }),
  });
  if (!res.ok) throw new Error(`createCloudProject failed: ${res.status}`);
  return res.json() as Promise<{ id: string; name: string }>;
}

export async function createCloudWorktree(projectId: string, name: string) {
  const res = await fetch(`/api/cloud/projects/${projectId}/worktrees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`createCloudWorktree failed: ${res.status}`);
  return res.json() as Promise<{ id: string; name: string }>;
}

export async function createCloudSession(projectId: string, worktreeId: string) {
  const res = await fetch("/api/cloud/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, worktreeId }),
  });
  if (!res.ok) throw new Error(`createCloudSession failed: ${res.status}`);
  return res.json() as Promise<{ id: string }>;
}

export function streamCloudTurn(sessionId: string, prompt: string, baseBundleBase64?: string | null) {
  return fetch("/api/cloud/turns/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, prompt, baseBundleBase64 }),
  });
}
