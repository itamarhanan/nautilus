import { openPath } from "@tauri-apps/plugin-opener";

const runnable = new Set([
  "app",
  "bat",
  "cmd",
  "com",
  "command",
  "cpl",
  "desktop",
  "exe",
  "jar",
  "lnk",
  "msi",
  "ps1",
  "scr",
  "sh",
  "vbs",
]);

export function editablePath(projectPath: string, path: string): string | null {
  const parts = path.split("/");
  if (path.startsWith("/") || path.includes("\\") || parts.some((part) => !part || part === ".."))
    return null;
  const name = parts.at(-1) ?? "";
  const extension = name.includes(".") ? (name.split(".").at(-1) ?? "").toLowerCase() : "";
  if (runnable.has(extension)) return null;
  return `${projectPath.replace(/\/+$/, "")}/${path}`;
}

export async function openInEditor(projectPath: string, path: string): Promise<void> {
  const absolute = editablePath(projectPath, path);
  if (!absolute) throw new Error("This kind of file is not opened from Nautilus");
  await openPath(absolute);
}
