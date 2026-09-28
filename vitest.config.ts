import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineConfig } from "vitest/config";

const workspaceRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: workspaceRoot,
  resolve: {
    alias: [{ find: /^@\/(.*)$/, replacement: `${workspaceRoot}/apps/web/$1` }],
  },
  test: {
    clearMocks: true,
    environment: "node",
    // Tests that build a server without a journal path would otherwise append
    // to the developer's real ~/nautilus/journal.jsonl.
    env: { NAUTILUS_LIFECYCLE_PATH: join(tmpdir(), "nautilus-test", "journal.jsonl") },
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    include: ["apps/**/test/**/*.test.ts", "packages/**/test/**/*.test.ts"],
    mockReset: true,
    passWithNoTests: false,
    restoreMocks: true,

    testTimeout: 20_000,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
