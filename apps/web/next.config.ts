import { randomUUID } from "node:crypto";
import type { NextConfig } from "next";

const serverOrigin = `http://127.0.0.1:${process.env.NAUTILUS_SERVER_PORT ?? "4000"}`;

const buildId = process.env.NAUTILUS_BUILD_ID ?? randomUUID();

const nextConfig = {
  generateBuildId: () => buildId,
  env: { NAUTILUS_BUILD_ID: buildId },

  rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${serverOrigin}/api/:path*`,
      },
      {
        source: "/health/:path*",
        destination: `${serverOrigin}/health/:path*`,
      },
    ];
  },
} satisfies NextConfig;

export default nextConfig;
