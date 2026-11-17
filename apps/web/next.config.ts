import { randomUUID } from "node:crypto";
import type { NextConfig } from "next";

const buildId = process.env.NAUTILUS_BUILD_ID ?? randomUUID();

const nextConfig = {
  generateBuildId: () => buildId,
  env: { NAUTILUS_BUILD_ID: buildId },
  // The runner bundle is written into the sandbox by the functions that wake
  // it, so it has to ship with them.
  outputFileTracingIncludes: {
    "/api/**/*": ["./runner-dist/**/*"],
  },
  serverExternalPackages: ["@vercel/sandbox"],
} satisfies NextConfig;

export default nextConfig;
