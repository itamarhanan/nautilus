import { homeDir } from "@tauri-apps/api/path";
import { mkdir, readDir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { FolderIo } from "./folders";
import { readSettings, settingsDocument, type DesktopSettings } from "./settings";
import { emptyState, readState, type AppState } from "./state";

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readTextFile(path);
  } catch (error) {
    if (String(error).match(/not found|no such file|os error 2/i)) return undefined;
    throw error;
  }
}

async function writeJson(path: string, value: unknown, home: string): Promise<void> {
  await mkdir(`${home}/.nautilus`, { recursive: true }).catch(() => undefined);
  await writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export type DesktopPaths = {
  home: string;
  config: string;
  state: string;
  sshConfig: string;
};

export async function desktopPaths(): Promise<DesktopPaths> {
  const home = (await homeDir()).replace(/\/+$/, "");
  return {
    home,
    config: `${home}/.nautilus/config.json`,
    state: `${home}/.nautilus/state.json`,
    sshConfig: `${home}/.ssh/config`,
  };
}

export async function loadSettings(
  paths: DesktopPaths,
): Promise<{ settings: DesktopSettings; exists: boolean }> {
  const content = await readOptional(paths.config);
  if (content === undefined) return { settings: readSettings({}), exists: false };
  try {
    return { settings: readSettings(JSON.parse(content)), exists: true };
  } catch {
    throw new Error(`${paths.config} is not valid JSON`);
  }
}

export async function saveSettings(paths: DesktopPaths, settings: DesktopSettings): Promise<void> {
  await writeJson(paths.config, settingsDocument(settings), paths.home);
}

export async function loadState(paths: DesktopPaths): Promise<AppState> {
  const content = await readOptional(paths.state);
  if (content === undefined) return emptyState;
  try {
    return readState(JSON.parse(content));
  } catch {
    return emptyState;
  }
}

export async function saveState(paths: DesktopPaths, state: AppState): Promise<void> {
  await writeJson(paths.state, state, paths.home);
}

export async function readSshConfig(paths: DesktopPaths): Promise<string | undefined> {
  return readOptional(paths.sshConfig).catch(() => undefined);
}

export const folderIo: FolderIo = {
  listDir: async (path) =>
    (await readDir(path)).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
    })),
  readText: (path) => readTextFile(path),
};
