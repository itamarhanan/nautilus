import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  platform: "node",
  // `platform: "node"` otherwise implies a fixed `.mjs` extension, which would
  // break the `node dist/cli.js` that `start`, the docs, and the dev scripts run.
  fixedExtension: false,
  target: "node24",
  // Node runs this bundle directly, so a stack trace without a source map is
  // unreadable in production.
  sourcemap: true,
  dts: false,
});
