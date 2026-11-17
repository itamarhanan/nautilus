// Copies the built runner into runner-dist/, where the gateway's functions
// find it and write it into the sandbox. Only the runner's own npm
// dependencies are listed, since the workspace packages are bundled into it.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const runner = join(web, "..", "runner");
const target = join(web, "runner-dist");

const manifest = JSON.parse(await readFile(join(runner, "package.json"), "utf8"));
const dependencies = Object.fromEntries(
  Object.entries(manifest.dependencies ?? {}).filter(
    ([, version]) => !version.startsWith("workspace:"),
  ),
);

await rm(target, { recursive: true, force: true });
await mkdir(join(target, "dist"), { recursive: true });
await cp(join(runner, "dist"), join(target, "dist"), { recursive: true });
await cp(join(runner, "dev-port-shim.mjs"), join(target, "dev-port-shim.mjs"));
await writeFile(
  join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "nautilus-runner",
      private: true,
      type: "module",
      version: manifest.version,
      dependencies,
    },
    null,
    2,
  )}\n`,
);
console.log(`runner bundled into ${target}`);
