import { createSession, createWorktree, createProject, fetchLatestBundle, uploadBaseBundle, runTurn } from "./cloud";

// High-level helper: ensure project/worktree exist, upload a base bundle, run a turn, fetch the resulting bundle.
export async function runCloudTurn(params: {
  baseUrl: string;
  ownerDeviceId: string;
  projectName: string;
  worktreeName: string;
  prompt: string;
  baseBundleBase64: string;
  baseHead: string | null;
}): Promise<{ sessionId: string; worktreeId: string; result: Response }> {
  const project = await createProject(params.baseUrl, params.projectName, params.ownerDeviceId);
  const worktree = await createWorktree(params.baseUrl, project.id, params.worktreeName);
  await uploadBaseBundle(params.baseUrl, worktree.id, params.baseHead, params.baseBundleBase64);
  const session = await createSession(params.baseUrl, project.id, worktree.id);
  const result = await runTurn(params.baseUrl, session.id, params.prompt, params.baseBundleBase64);
  return { sessionId: session.id, worktreeId: worktree.id, result };
}

export { fetchLatestBundle };
