import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  platform: "node",
  // `platform: "node"` otherwise implies a fixed `.mjs` extension, which would
  // break the `node dist/main.js` that `start` runs.
  fixedExtension: false,
  target: "node24",
  // Node runs this bundle directly, so a stack trace without a source map is
  // unreadable in production.
  sourcemap: true,
  dts: false,
});
