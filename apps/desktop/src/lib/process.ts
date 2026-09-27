import { Child, Command } from "@tauri-apps/plugin-shell";

export type AllowedProgram = "nautilus-ssh-control" | "nautilus-ssh-sync" | "nautilus-sync-agent";

export type SpawnHandlers = {
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  onClose: (code: number | null) => void;
};

type SpawnOptions = { env?: Record<string, string> };

export type RunningProcess = {
  pid?: number;
  write: (data: string) => Promise<void>;
  kill: () => Promise<void>;
};

export type Spawner = (
  program: AllowedProgram,
  args: string[],
  handlers: SpawnHandlers,
  options?: SpawnOptions,
) => Promise<RunningProcess>;

const sidecars: Partial<Record<AllowedProgram, string>> = {
  "nautilus-sync-agent": "binaries/nautilus-sync-agent",
};

export const tauriSpawner: Spawner = async (program, args, handlers, options) => {
  const env = options?.env ? { env: options.env } : undefined;
  const sidecar = sidecars[program];
  const command = sidecar
    ? Command.sidecar(sidecar, args, env)
    : Command.create(program, args, env);
  let closed = false;
  const close = (code: number | null) => {
    if (closed) return;
    closed = true;
    handlers.onClose(code);
  };
  command.on("close", ({ code }) => {
    close(code);
  });
  command.on("error", () => {
    close(null);
  });
  if (handlers.onStdout) command.stdout.on("data", handlers.onStdout);
  if (handlers.onStderr) command.stderr.on("data", handlers.onStderr);
  const child = await command.spawn();
  return {
    pid: child.pid,
    write: (data) => child.write(data),
    kill: () => child.kill(),
  };
};

export const killTauriChild = (pid: number): Promise<void> => new Child(pid).kill();
