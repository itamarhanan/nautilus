import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// The runner is built into apps/web/runner-dist at build time and shipped with
// the functions that wake it. Its version is a hash of the files, so any
// change to the runner restarts it on the next request.

export type RunnerBundle = {
  version: string;
  files: { path: string; content: Buffer }[];
  packageHash: string;
};

let cached: Promise<RunnerBundle> | undefined;

async function load(): Promise<RunnerBundle> {
  const root = join(process.cwd(), "runner-dist");
  const names = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
  const files = await Promise.all(
    names.map(async (name) => ({ path: name, content: await readFile(join(root, name)) })),
  );
  const digest = createHash("sha256");
  for (const entry of files) digest.update(entry.path).update("\0").update(entry.content);
  const manifest = files.find((entry) => entry.path === "package.json");
  if (!manifest || !files.some((entry) => entry.path === "dist/main.js")) {
    throw new Error("runner-dist is missing; build the web app with pnpm build");
  }
  return {
    version: digest.digest("hex").slice(0, 16),
    files,
    packageHash: createHash("sha256").update(manifest.content).digest("hex").slice(0, 16),
  };
}

export function runnerBundle(): Promise<RunnerBundle> {
  cached ??= load().catch((error: unknown) => {
    cached = undefined;
    throw error;
  });
  return cached;
}
