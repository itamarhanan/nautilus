export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export type FolderCandidate = {
  name: string;

  path: string;
  git: boolean;
  packageManager: PackageManager | null;
  devScript: "dev" | "start" | null;
};

export type DirEntry = { name: string; isDirectory: boolean };

export type FolderIo = {
  listDir: (absolutePath: string) => Promise<DirEntry[]>;
  readText: (absolutePath: string) => Promise<string>;
};

const scanDepth = 3;
const maxCandidates = 500;

const skippedDirectories = new Set([
  "node_modules",
  "Library",
  "snap",
  "target",
  "dist",
  "build",
  "vendor",
  "venv",
  "__pycache__",
]);

const lockfiles: Array<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}

export function collapseHome(path: string, home: string): string {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function inferDevCommand(
  packageManager: PackageManager | null,
  devScript: "dev" | "start" | null,
): string | null {
  if (!devScript) return null;
  switch (packageManager ?? "npm") {
    case "pnpm":
      return `pnpm ${devScript}`;
    case "yarn":
      return `yarn ${devScript}`;
    case "bun":
      return `bun run ${devScript}`;
    case "npm":
      return devScript === "start" ? "npm start" : `npm run ${devScript}`;
  }
}

function scriptFromPackageJson(content: string): "dev" | "start" | null {
  try {
    const scripts = (JSON.parse(content) as { scripts?: Record<string, unknown> }).scripts ?? {};
    if (typeof scripts.dev === "string") return "dev";
    if (typeof scripts.start === "string") return "start";
  } catch {
    // A package.json we cannot parse is a folder with no script to offer, which
    // is the same answer the function already returns for a missing file. The
    // caller offers a manual dev command instead, so there is nothing to report.
  }
  return null;
}

export async function describeFolder(
  absolutePath: string,
  entries: DirEntry[],
  io: FolderIo,
  home: string,
): Promise<FolderCandidate | undefined> {
  const names = new Set(entries.map((entry) => entry.name));
  const git = names.has(".git");
  const hasPackageJson = names.has("package.json");
  const packageManager = lockfiles.find(([file]) => names.has(file))?.[1] ?? null;
  if (!git && !hasPackageJson && !packageManager) return undefined;
  const devScript = hasPackageJson
    ? scriptFromPackageJson(await io.readText(`${absolutePath}/package.json`).catch(() => ""))
    : null;
  return {
    name: absolutePath.split("/").filter(Boolean).at(-1) ?? absolutePath,
    path: collapseHome(absolutePath, home),
    git,
    packageManager: packageManager ?? (hasPackageJson ? "npm" : null),
    devScript,
  };
}

export async function scanFolders(
  roots: string[],
  io: FolderIo,
  home: string,
  depth = scanDepth,
): Promise<FolderCandidate[]> {
  const found = new Map<string, FolderCandidate>();
  const visit = async (absolutePath: string, remaining: number): Promise<void> => {
    if (found.size >= maxCandidates) return;
    let entries: DirEntry[];
    try {
      entries = await io.listDir(absolutePath);
    } catch {
      return;
    }
    const candidate = await describeFolder(absolutePath, entries, io, home);
    if (candidate) {
      found.set(candidate.path, candidate);
      return;
    }
    if (remaining === 0) return;
    const children = entries.filter(
      (entry) =>
        entry.isDirectory && !entry.name.startsWith(".") && !skippedDirectories.has(entry.name),
    );
    for (const child of children) await visit(`${absolutePath}/${child.name}`, remaining - 1);
  };
  for (const root of roots) {
    const absolute = expandHome(root, home).replace(/\/+$/, "") || "/";

    await visit(absolute, depth);
  }
  return [...found.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export type FuzzyMatch = { score: number; indices: number[] };

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const needle = Array.from(query.trim().toLowerCase()).filter((character) => character !== " ");
  if (needle.length === 0) return { score: 0, indices: [] };
  const haystack = target.toLowerCase();
  const isWordStart = (index: number) => index === 0 || /[\s/_.-]/.test(haystack[index - 1] ?? "");
  const restMatches = (from: number, position: number) => {
    let cursor = from;
    for (const character of needle.slice(position)) {
      cursor = haystack.indexOf(character, cursor);
      if (cursor === -1) return false;
      cursor += 1;
    }
    return true;
  };
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  for (const [position, character] of needle.entries()) {
    const first = haystack.indexOf(character, from);
    if (first === -1) return null;

    const previous = indices.at(-1);
    let index = first;
    const continuesRun = previous !== undefined && first === previous + 1;
    if (!continuesRun) {
      for (
        let candidate = first;
        candidate !== -1;
        candidate = haystack.indexOf(character, candidate + 1)
      ) {
        if (isWordStart(candidate) && restMatches(candidate + 1, position + 1)) {
          index = candidate;
          break;
        }
      }
    }
    score +=
      1 + (previous !== undefined && index === previous + 1 ? 3 : 0) + (isWordStart(index) ? 2 : 0);
    indices.push(index);
    from = index + 1;
  }

  return { score: score - target.length / 100, indices };
}

export type RankedFolder<T> = {
  item: T;
  nameIndices: number[];
  pathIndices: number[];
};

export function rankFolders<T extends { name: string; path: string }>(
  query: string,
  items: T[],
): Array<RankedFolder<T>> {
  if (!query.trim()) return items.map((item) => ({ item, nameIndices: [], pathIndices: [] }));
  const ranked: Array<RankedFolder<T> & { score: number }> = [];
  for (const item of items) {
    const byName = fuzzyMatch(query, item.name);
    const byPath = byName ? null : fuzzyMatch(query, item.path);
    if (byName)
      ranked.push({
        item,
        nameIndices: byName.indices,
        pathIndices: [],
        score: byName.score + 10,
      });
    else if (byPath)
      ranked.push({
        item,
        nameIndices: [],
        pathIndices: byPath.indices,
        score: byPath.score,
      });
  }
  return ranked
    .sort((left, right) => right.score - left.score)
    .map(({ item, nameIndices, pathIndices }) => ({
      item,
      nameIndices,
      pathIndices,
    }));
}
