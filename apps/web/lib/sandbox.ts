import { Sandbox } from "@vercel/sandbox";

export type SandboxRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  outBundle?: Buffer;
};

export async function runInSandbox(
  command: string,
  args: string[] = [],
  options: { timeoutMs?: number; env?: Record<string, string>; files?: Array<{ path: string; content: Buffer }> } = {},
): Promise<SandboxRunResult> {
  const sandbox = await Sandbox.create({
    runtime: "node22",
    timeout: options.timeoutMs ?? 60_000,
    env: options.env,
  });
  try {
    if (options.files?.length) {
      await sandbox.writeFiles(options.files.map((f) => ({ path: f.path, content: f.content })));
    }
    const result = await sandbox.runCommand(command, args);
    const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
    let outBundle: Buffer | undefined;
    try {
      const buf = await sandbox.readFileToBuffer({ path: "/workspace/out.bundle" });
      outBundle = buf ?? undefined;
    } catch {
      outBundle = undefined;
    }
    return { stdout, stderr, exitCode: result.exitCode ?? 0, outBundle };
  } finally {
    await sandbox.stop().catch(() => {});
  }
}

export async function runTurnInSandbox(params: {
  baseBundle?: Buffer | null;
  prompt: string;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number; outBundle?: Buffer }> {
  const files = params.baseBundle
    ? [{ path: "/workspace/base.bundle", content: params.baseBundle }]
    : [];
  const prompt = params.prompt.replace(/"/g, '\\"');
  const args = [
    "-lc",
    [
      "set -e",
      "npm install -g opencode-ai >/tmp/opencode-install.log 2>&1 || true",
      "rm -rf /workspace/project && mkdir -p /workspace/project",
      "cd /workspace/project",
      "if [ -f /workspace/base.bundle ]; then git clone /workspace/base.bundle . || true; fi",
      "opencode run --auto --format json \"" + prompt + "\" || true",
      "git add -A",
      "git commit -m 'nautilus turn' --allow-empty || true",
      "git bundle create /workspace/out.bundle --all || true",
      "echo done",
    ].join("; "),
  ];
  const res = await runInSandbox("bash", args, { timeoutMs: params.timeoutMs ?? 120_000, files });
  return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode, outBundle: res.outBundle };
}
