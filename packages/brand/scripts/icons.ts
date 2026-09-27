import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appIconSvg } from "../src/index.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(packageDir, "../..");
const tauri = join(packageDir, "node_modules/.bin/tauri");

const icon = join(packageDir, "assets/icon.svg");
const maskable = join(packageDir, "assets/icon-maskable.svg");
writeFileSync(icon, appIconSvg());
writeFileSync(maskable, appIconSvg({ maskable: true }));

function rasterize(source: string, output: string, sizes: number[] = []) {
  execFileSync(
    tauri,
    ["icon", source, "-o", output, ...sizes.flatMap((size) => ["-p", String(size)])],
    {
      stdio: "inherit",
    },
  );
}

rasterize(icon, join(root, "apps/desktop/src-tauri/icons"));

const scratch = mkdtempSync(join(tmpdir(), "nautilus-icons-"));
try {
  rasterize(icon, join(scratch, "tile"), [192, 512]);

  rasterize(maskable, join(scratch, "bleed"), [180, 512]);
  const web = join(root, "apps/web");
  copyFileSync(icon, join(web, "public/icon.svg"));
  copyFileSync(join(scratch, "tile/192x192.png"), join(web, "public/icon-192.png"));
  copyFileSync(join(scratch, "tile/512x512.png"), join(web, "public/icon-512.png"));
  copyFileSync(join(scratch, "bleed/512x512.png"), join(web, "public/icon-maskable-512.png"));
  copyFileSync(join(scratch, "bleed/180x180.png"), join(web, "app/apple-icon.png"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
