import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  // `platform: "node"` otherwise implies a fixed `.mjs` extension, which would
  // break the `./dist/index.js` that this package's `exports` map points at.
  fixedExtension: false,
  target: "node24",
  sourcemap: true,
});
