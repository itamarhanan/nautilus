import { expect, test } from "vitest";
import type { ProjectConfig } from "@nautilus/types";
import { createNautilusApp } from "../src/index";
import { Logger } from "../src/logger";
import { listen, pairDevice, request } from "./helpers";

const authSecret = "d".repeat(48);
const project: ProjectConfig = {
  id: "secure",
  name: "Secure",
  remotePath: "/tmp/secure",
  devCommand: "node server.js",
  devPort: 3216,
  previewPath: "/preview/secure/",
};

test("JWT cookies reject tampering, revoked devices, and logout clears the session", async () => {
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret,
    projects: [project],
    logger: new Logger(() => undefined),
  });
  const ports = await listen(app);

  try {
    const { cookie, deviceId } = await pairDevice(ports, "Phone");
    const parts = cookie.split("=");
    const tampered = `${parts.at(0) ?? ""}=x`;
    expect((await request(ports, "GET", "/api/projects", { cookie: tampered })).status).toBe(401);
    expect((await request(ports, "GET", "/api/projects", { cookie })).status).toBe(200);

    await request(ports, "POST", `/api/devices/${deviceId}/revoke`, {
      control: true,
    });
    expect((await request(ports, "GET", "/api/projects", { cookie })).status).toBe(401);

    const loggedOut = await request(ports, "POST", "/api/session/logout", {
      cookie,
    });
    expect(loggedOut.setCookie).toContain("Max-Age=0");
  } finally {
    await app.close();
  }
});

test("a bearer token no longer authenticates on the public listener", async () => {
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret,
    projects: [project],
    logger: new Logger(() => undefined),
  });
  const ports = await listen(app);
  try {
    const response = await request(ports, "GET", "/api/projects", {
      headers: { authorization: `Bearer ${authSecret}` },
    });
    expect(response.status).toBe(401);
  } finally {
    await app.close();
  }
});

test("failed authentication is rate limited per source", async () => {
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret,
    projects: [project],
    logger: new Logger(() => undefined),
  });
  const ports = await listen(app);

  try {
    let status = 401;
    for (let attempt = 0; attempt < 35; attempt += 1) {
      const result = await request(ports, "GET", "/api/projects", {
        cookie: "nautilus_session=invalid",
      });
      status = result.status;
    }
    expect(status).toBe(429);
  } finally {
    await app.close();
  }
});
