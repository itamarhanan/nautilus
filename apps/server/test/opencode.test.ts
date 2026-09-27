import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Logger } from "../src/logger";
import { OpenCodeProcess } from "../src/opencode";

const fakeOpenCode = `#!/usr/bin/env node
const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice(7));
require("node:http")
  .createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/session")) {
      response.end(JSON.stringify({ id: "ses_fake", title: "First turn" }));
      return;
    }
    response.end(JSON.stringify({ healthy: true }));
  })
  .listen(port, "127.0.0.1", () => console.log("opencode server listening on " + port));
`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  if (!address || typeof address === "string") throw new Error("No port");
  return address.port;
}

async function fixture(): Promise<{
  root: string;
  binary: string;
  dataDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "nautilus-opencode-"));
  const binary = join(root, "opencode");
  await writeFile(binary, fakeOpenCode, { mode: 0o755 });
  return { root, binary, dataDir: join(root, "state") };
}

test("createSession returns the session OpenCode created", async () => {
  const { root, binary, dataDir } = await fixture();
  const openCode = new OpenCodeProcess(new Logger(() => undefined), {
    binary,
    dataDir,
    port: await freePort(),
  });
  try {
    const session = await openCode.createSession(root, "First turn");
    expect(session.id).toBe("ses_fake");
  } finally {
    await openCode.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a port held by a server the runner did not start is refused", async () => {
  const { root, binary, dataDir } = await fixture();
  const foreign = createServer((_, response) => response.end("{}"));
  await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  const address = foreign.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const openCode = new OpenCodeProcess(new Logger(() => undefined), {
    binary,
    dataDir,
    port,
  });
  try {
    await expect(openCode.start()).rejects.toThrow(/already in use/);
  } finally {
    await openCode.close();
    await new Promise<void>((resolve) =>
      foreign.close(() => {
        resolve();
      }),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test("an OpenCode left behind by a previous runner is stopped and replaced", async () => {
  const { root, binary, dataDir } = await fixture();
  const port = await freePort();
  const leftover = spawn(binary, ["serve", `--port=${String(port)}`], {
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve) =>
    leftover.once("exit", () => {
      resolve();
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "opencode.pid"), `${String(leftover.pid)}\n`);
  const openCode = new OpenCodeProcess(new Logger(() => undefined), {
    binary,
    dataDir,
    port,
  });
  try {
    await openCode.start();
    await exited;
    expect(leftover.exitCode !== null || leftover.signalCode !== null).toBe(true);
    expect((await openCode.createSession(root, "After restart")).id).toBe("ses_fake");
  } finally {
    await openCode.close();
    leftover.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("stopping OpenCode stops the server a launcher shim started, not just the shim", async () => {
  const { root, binary: server, dataDir } = await fixture();

  const shim = join(root, "opencode-shim");
  await writeFile(shim, `#!/bin/sh\n"${server}" "$@"\nexit $?\n`, {
    mode: 0o755,
  });
  const port = await freePort();
  const openCode = new OpenCodeProcess(new Logger(() => undefined), {
    binary: shim,
    dataDir,
    port,
  });
  const health = () =>
    fetch(`http://127.0.0.1:${String(port)}/global/health`, {
      signal: AbortSignal.timeout(500),
    }).then(
      () => true,
      () => false,
    );
  try {
    await openCode.start();
    expect(await health()).toBe(true);
    await openCode.close();
    expect(await health()).toBe(false);
  } finally {
    await openCode.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing binary fails start with a reason instead of crashing the server", async () => {
  const { root, dataDir } = await fixture();
  const openCode = new OpenCodeProcess(new Logger(() => undefined), {
    binary: join(root, "not-installed", "opencode"),
    dataDir,
    port: await freePort(),
  });
  try {
    await expect(openCode.start()).rejects.toThrow(/OpenCode was not found at .*not-installed/);
  } finally {
    await openCode.close();
    await rm(root, { recursive: true, force: true });
  }
});
