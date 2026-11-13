import { randomUUID } from "node:crypto";
import type { NextConfig } from "next";

const buildId = process.env.NAUTILUS_BUILD_ID ?? randomUUID();

const nextConfig = {
  generateBuildId: () => buildId,
  env: { NAUTILUS_BUILD_ID: buildId },
  rewrites() {
    return [
      {
        source: "/api/cloud/:path*",
        destination: "/api/cloud/:path*",
      },
      {
        source: "/api/:path*",
        destination: "/api/cloud/:path*",
      },
    ];
  },
} satisfies NextConfig;

export default nextConfig;
