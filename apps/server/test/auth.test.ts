import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
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

afterEach(() => {
  vi.useRealTimers();
});

test("a session outlasts idle time and is renewed once a day", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret,
    projects: [project],
    logger: new Logger(() => undefined),
  });
  const ports = await listen(app);

  try {
    const { cookie } = await pairDevice(ports, "Phone");

    vi.setSystemTime(Date.now() + 12 * 60 * 60 * 1000);
    const early = await request(ports, "GET", "/api/projects", { cookie });
    expect(early.status).toBe(200);
    expect(early.setCookie).toBeNull();

    vi.setSystemTime(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const later = await request(ports, "GET", "/api/projects", { cookie });
    expect(later.status).toBe(200);
    expect(later.setCookie).toContain(`Max-Age=${String(400 * 24 * 60 * 60)}`);

    const renewed = later.setCookie?.split(";", 1)[0] ?? "";
    vi.setSystemTime(Date.now() + 390 * 24 * 60 * 60 * 1000);
    expect((await request(ports, "GET", "/api/projects", { cookie: renewed })).status).toBe(200);
  } finally {
    await app.close();
  }
});

test("a linked phone stays signed in after the runner restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilus-restart-"));
  const options = {
    registryPath: join(root, "registry.sqlite"),
    authSecret,
    projects: [project],
    logger: new Logger(() => undefined),
  };
  try {
    const first = await createNautilusApp(options);
    const { cookie } = await pairDevice(await listen(first), "Phone");
    await first.close();

    const second = await createNautilusApp(options);
    try {
      const ports = await listen(second);
      expect((await request(ports, "GET", "/api/projects", { cookie })).status).toBe(200);
    } finally {
      await second.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
