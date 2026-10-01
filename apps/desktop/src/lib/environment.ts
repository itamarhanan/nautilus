import { invoke } from "@tauri-apps/api/core";

export type ScannedEnvFile = {
  path: string;

  // Template files such as .env.example list keys without values.
  keys: { name: string; value: string | null }[];
};

export type StoredEnvironment = {
  variables: Record<string, string>;

  // A digest per variable the runner last accepted.
  sent: Record<string, string>;

  // False when the OS keychain was unavailable and the variables live in
  // ~/.nautilus/env/<project>.json instead.
  keychain: boolean;
};

export type EnvironmentStore = {
  load: (projectId: string) => Promise<StoredEnvironment>;
  save: (
    projectId: string,
    variables: Record<string, string>,
    sent: Record<string, string>,
  ) => Promise<{ keychain: boolean }>;
  remove: (projectId: string) => Promise<void>;
  scan: (projectPath: string) => Promise<ScannedEnvFile[]>;
};

export const tauriEnvironment: EnvironmentStore = {
  load: (projectId) => invoke("env_load", { projectId }),
  save: (projectId, variables, sent) => invoke("env_save", { projectId, variables, sent }),
  remove: (projectId) => invoke("env_delete", { projectId }),
  scan: (projectPath) => invoke("env_scan", { projectPath }),
};

const keyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const maxKeys = 200;
const maxTotalBytes = 64 * 1024;

// Mirrors the runner's limits so a save fails here, before anything leaves
// the PC.
export function environmentError(variables: Record<string, string>): string | null {
  const entries = Object.entries(variables);
  if (entries.length > maxKeys) return `A project can have at most ${String(maxKeys)} variables.`;
  let total = 0;
  for (const [key, value] of entries) {
    if (!keyPattern.test(key)) return `${key || "An empty name"} is not a valid variable name.`;
    if (value.includes("\0")) return `${key} contains a null character.`;
    total += new TextEncoder().encode(key + value).length;
  }
  if (total > maxTotalBytes) return "The variables add up to more than 64 KB.";
  return null;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function environmentDigests(
  variables: Record<string, string>,
): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(variables).map(async ([key, value]) => [key, await digest(value)] as const),
    ),
  );
}

// The keys a push would add, change or remove on the runner. `runnerKeys` is
// what the runner reports holding; `sent` is what this PC last sent it. A key
// the runner lost counts as changed even if this PC thinks it was sent.
export async function changedVariables(
  stored: Pick<StoredEnvironment, "variables" | "sent">,
  runnerKeys: readonly string[],
): Promise<string[]> {
  const current = await environmentDigests(stored.variables);
  const held = new Set(runnerKeys);
  const changed = new Set<string>();
  for (const [key, hash] of Object.entries(current)) {
    if (!held.has(key) || stored.sent[key] !== hash) changed.add(key);
  }
  for (const key of held) if (!(key in current)) changed.add(key);
  return [...changed].sort();
}

export type FoundVariable = {
  key: string;
  value: string;
  path: string;

  // Whether the import starts with it ticked: it comes from a file the dev
  // command itself loads.
  importable: boolean;
};

// The files a dev server reads, highest precedence first, the way Vite and
// Next order them in development (Cloudflare's .dev.vars plays .env.local's
// part). Files for other modes, such as .env.production or .env.test, are
// still offered but start unticked, since a preview runs the dev command and
// production values are what should stay behind.
const developmentFiles = [
  ".env.development.local",
  ".env.local",
  ".dev.vars",
  ".env.development",
  ".env",
];

function developmentRank(path: string): number {
  const index = developmentFiles.indexOf(path.split("/").at(-1) ?? "");
  return index === -1 ? 0 : developmentFiles.length - index;
}

// One entry per key not already taken. A key with no value, such as one a
// template only names, is left out: there is nothing to send. Otherwise the
// file the dev server would read the key from wins, then the file nearer the
// project root.
export function foundVariables(
  files: readonly ScannedEnvFile[],
  taken: ReadonlySet<string>,
): FoundVariable[] {
  const score = (path: string): [number, number] => [
    developmentRank(path),
    -path.split("/").length,
  ];
  const better = (a: FoundVariable, b: FoundVariable): boolean => {
    const [left, right] = [score(a.path), score(b.path)];
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return (left[index] ?? 0) > (right[index] ?? 0);
    }
    return a.path < b.path;
  };
  const found = new Map<string, FoundVariable>();
  for (const file of files) {
    for (const { name, value } of file.keys) {
      if (taken.has(name) || !value) continue;
      const candidate: FoundVariable = {
        key: name,
        value,
        path: file.path,
        importable: developmentRank(file.path) > 0,
      };
      const existing = found.get(name);
      if (!existing || better(candidate, existing)) found.set(name, candidate);
    }
  }
  return [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
}
