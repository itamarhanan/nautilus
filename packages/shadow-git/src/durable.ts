import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

export class LockBusyError extends Error {
  constructor() {
    super("Another sync operation is already running for this project");
    this.name = "LockBusyError";
  }
}

type LockOwner = { pid: number; instance: string; acquiredAt: string };

const instance = randomUUID();

const maxLockAgeMs = 30 * 60 * 1000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isStale(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (info === null) return true;
  if (info.isDirectory()) return true;
  const owner = await readJson<Partial<LockOwner> | null>(path, null);
  if (!owner || typeof owner.pid !== "number" || typeof owner.acquiredAt !== "string") {
    return Date.now() - info.mtimeMs > maxLockAgeMs;
  }
  if (Date.now() - Date.parse(owner.acquiredAt) > maxLockAgeMs) return true;
  if (owner.pid === process.pid) return owner.instance !== instance;
  return !isAlive(owner.pid);
}

async function acquire(path: string): Promise<boolean> {
  try {
    const file = await open(path, "wx", 0o600);
    try {
      const owner: LockOwner = {
        pid: process.pid,
        instance,
        acquiredAt: new Date().toISOString(),
      };
      await file.writeFile(JSON.stringify(owner));
    } finally {
      await file.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (!(await acquire(path))) {
    if (!(await isStale(path))) throw new LockBusyError();
    await rm(path, { recursive: true, force: true });

    if (!(await acquire(path))) throw new LockBusyError();
  }
  try {
    return await action();
  } finally {
    await rm(path, { force: true });
  }
}

export async function pruneFiles(
  directory: string,
  options: {
    keep: number;
    suffix: string;
    protect?: (path: string) => Promise<boolean>;
  },
): Promise<void> {
  const entries = await readdir(directory).catch(() => [] as string[]);
  const files: { path: string; modified: number }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(options.suffix)) continue;
    const path = join(directory, entry);
    if (await options.protect?.(path)) continue;
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) files.push({ path, modified: info.mtimeMs });
  }
  files.sort((left, right) => right.modified - left.modified);
  await Promise.all(files.slice(options.keep).map(({ path }) => rm(path, { force: true })));
}
