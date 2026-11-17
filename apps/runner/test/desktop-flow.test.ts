import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { SyncGrantResponse, SyncStatusResponse } from "@nautilus/types";
import { GrantAuthority } from "../../sync-agent/src/grants";
import { createSyncAgentServer } from "../../sync-agent/src/index";
import { createNautilusApp } from "../src/index";
import { Logger } from "../src/logger";
import { SyncCoordinator, TunnelSyncClient } from "../src/sync";
import { controlHeaders, listen, request, testSecret } from "./helpers";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("desktop flow: push, see agent changes in sync-status, pull them back", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilus-desktop-flow-"));
  roots.push(root);
  const home = join(root, "home");
  const localPath = join(home, "code", "shop");
  const remotePath = join(root, "runner", "projects", "shop");
  await mkdir(localPath, { recursive: true });
  await mkdir(remotePath, { recursive: true });
  await writeFile(join(localPath, "README.md"), "hello from the pc\n");

  await mkdir(join(home, ".nautilus"), { recursive: true });
  await writeFile(
    join(home, ".nautilus", "state.json"),
    JSON.stringify({
      version: 1,
      projects: [{ id: "shop", name: "Shop", localPath: "~/code/shop" }],
      recentFolders: [],
    }),
  );

  const launchKey = "L".repeat(43);
  const grants = new GrantAuthority(Buffer.from(launchKey, "utf8"));
  const agentServer = await createSyncAgentServer(
    {
      host: "127.0.0.1",
      port: 0,
      home,
      transactionPath: join(home, ".nautilus", "transactions"),
      backupPath: join(home, ".nautilus", "backups"),
      statePath: join(home, ".nautilus", "state.json"),
      projects: [],
      maxFileBytes: 10_000_000,
      maxTotalBytes: 100_000_000,
      maxFileCount: 10_000,
      maxBundleBytes: 100_000_000,
      requestTimeoutMs: 30_000,
    },
    grants,
  );
  await new Promise<void>((resolve) => agentServer.server.listen(0, "127.0.0.1", resolve));
  const agentAddress = agentServer.server.address();
  if (!agentAddress || typeof agentAddress === "string") throw new Error("agent did not bind");
  const agentBase = `http://127.0.0.1:${String(agentAddress.port)}`;

  const project = {
    id: "shop",
    name: "Shop",
    remotePath,
    devCommand: "pnpm dev",
    devPort: 3190,
    previewPath: "/preview/shop/",
  };
  const sync = new SyncCoordinator({
    projects: [project],
    shadowRoot: join(root, "runner", "shadow"),
    statePath: join(root, "runner", "sync-state"),
    client: new TunnelSyncClient({ endpoint: `${agentBase}/v1/sync` }),
  });
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [project],
    sync,
    tunnelHealthUrl: `${agentBase}/v1/sync`,
    logger: new Logger(() => undefined),
  });
  const ports = await listen(app);

  const mint = async (direction: "pull" | "push"): Promise<SyncGrantResponse> => {
    const response = await fetch(`${agentBase}/v1/grants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${launchKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectId: "shop", direction }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as SyncGrantResponse;
  };
  const control = (method: string, path: string, body?: unknown) =>
    request(ports, method, path, { control: true, body });
  const localStatus = async () =>
    (await (
      await fetch(`${agentBase}/v1/status?projectId=shop`, {
        headers: { authorization: `Bearer ${launchKey}` },
      })
    ).json()) as { changedFiles: number; neverSynced: boolean };

  try {
    expect((await control("GET", "/api/tunnel-health")).body).toEqual({
      ready: true,
    });
    expect(await localStatus()).toMatchObject({ neverSynced: true });

    const push = await mint("push");
    const preview = await control("POST", "/api/projects/shop/sync-requests/preview", {
      direction: "push",
      grant: push.grant,
    });
    expect(preview.status).toBe(200);
    const pushed = await control("POST", "/api/projects/shop/sync-requests", {
      direction: "push",
      grant: push.grant,
      requestId: "desktop-push-0001",
    });
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect(await readFile(join(remotePath, "README.md"), "utf8")).toBe("hello from the pc\n");

    grants.revoke(push.claims.grantId);
    const reused = await control("POST", "/api/projects/shop/sync-requests", {
      direction: "push",
      grant: push.grant,
      requestId: "desktop-push-0002",
    });
    expect(reused.status).toBe(403);

    await writeFile(join(remotePath, "README.md"), "hello from the agent\n");
    await writeFile(join(remotePath, "feature.ts"), "export const feature = true;\n");
    await sync.checkpoint("shop", "session-1");
    const status = (await control("GET", "/api/projects/shop/sync-status"))
      .body as unknown as SyncStatusResponse;
    expect(status).toMatchObject({ neverSynced: false, changedFiles: 2 });
    expect(status.changedPaths).toEqual(["README.md", "feature.ts"]);
    expect(status.lastCheckpointAt).not.toBeNull();
    expect(await localStatus()).toMatchObject({
      neverSynced: false,
      changedFiles: 0,
    });

    const wrong = await control("POST", "/api/projects/shop/sync-requests", {
      direction: "pull",
      grant: (await mint("push")).grant,
    });
    expect(wrong.status).toBe(400);

    const forged = new GrantAuthority(Buffer.alloc(32, 1)).mint("shop", "pull").grant;
    const forgedPull = await control("POST", "/api/projects/shop/sync-requests", {
      direction: "pull",
      grant: forged,
      requestId: "desktop-pull-forged",
    });
    expect(forgedPull.status).toBe(403);
    expect(await readFile(join(localPath, "README.md"), "utf8")).toBe("hello from the pc\n");

    const pull = await mint("pull");
    const pulled = await control("POST", "/api/projects/shop/sync-requests", {
      direction: "pull",
      grant: pull.grant,
      requestId: "desktop-pull-0001",
    });
    expect(pulled.status, JSON.stringify(pulled.body)).toBe(200);
    expect(await readFile(join(localPath, "README.md"), "utf8")).toBe("hello from the agent\n");
    expect(await readFile(join(localPath, "feature.ts"), "utf8")).toBe(
      "export const feature = true;\n",
    );
    expect(
      (
        (await control("GET", "/api/projects/shop/sync-status"))
          .body as unknown as SyncStatusResponse
      ).changedFiles,
    ).toBe(0);
    expect(controlHeaders["x-nautilus-control"]).toBe("1");
  } finally {
    await app.close();
    await agentServer.close();
  }
});
