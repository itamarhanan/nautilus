import { createSession, createWorktree, createProject, fetchLatestBundle, uploadBaseBundle, runTurn } from "./cloud";

// High-level helper: ensure project/worktree exist, upload a base bundle, run a turn, fetch the resulting bundle.
export class CloudSyncSession {
  private projectId: string | null = null;
  private worktreeId: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly ownerDeviceId: string,
    private readonly projectName: string,
    private readonly worktreeName: string,
  ) {}

  async uploadBase(baseHead: string | null, bundleBase64: string): Promise<string> {
    const project = await createProject(this.baseUrl, this.projectName, this.ownerDeviceId);
    const worktree = await createWorktree(this.baseUrl, project.id, this.worktreeName);
    this.projectId = project.id;
    this.worktreeId = worktree.id;
    await uploadBaseBundle(this.baseUrl, worktree.id, baseHead, bundleBase64);
    return worktree.id;
  }

  async runTurn(prompt: string, baseBundleBase64?: string) {
    if (!this.projectId || !this.worktreeId) throw new Error("uploadBase first");
    const session = await createSession(this.baseUrl, this.projectId, this.worktreeId);
    return runTurn(this.baseUrl, session.id, prompt, baseBundleBase64);
  }

  async fetchDiff() {
    if (!this.worktreeId) throw new Error("uploadBase first");
    return fetchLatestBundle(this.baseUrl, this.worktreeId);
  }
}

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
