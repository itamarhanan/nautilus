import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (platform() === "linux") {
  const tauri = resolve(dirname(fileURLToPath(import.meta.url)), "../src-tauri");
  const binary = "nautilus-desktop";
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  const file = join(dataHome, "applications", `${binary}-dev.desktop`);
  const entry = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Nautilus (dev)",
    `Exec=${join(tauri, "target/debug", binary)}`,
    `Icon=${join(tauri, "icons/icon.png")}`,
    `StartupWMClass=${binary}`,
    "Terminal=false",
    "",
  ].join("\n");

  const current = await readFile(file, "utf8").catch(() => null);
  if (current !== entry) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, entry);
    console.log(`installed dev desktop entry at ${file}`);
  }
}
