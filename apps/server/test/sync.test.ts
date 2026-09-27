import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ProjectConfig, SyncRequest, SyncResponse } from "@nautilus/types";
import { GrantAuthority } from "../../sync-agent/src/grants";
import { createSyncAgentServer } from "../../sync-agent/src/index";
import { SyncAgent } from "../../sync-agent/src/operations";
import { ShadowGit } from "@nautilus/shadow-git";
import { SyncCoordinator, SyncOfflineError, TunnelSyncClient } from "../src/sync";

const roots: string[] = [];

const testGrant = "test-grant-payload.test-grant-signature";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(
  name: string,
): Promise<{ root: string; workTree: string; shadowPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "nautilus-server-sync-test-"));
  roots.push(root);
  const workTree = join(root, name);
  await mkdir(workTree);
  return { root, workTree, shadowPath: join(root, "shadow", `${name}.git`) };
}

function request(
  operation: SyncRequest["operation"],
  values: Partial<SyncRequest> = {},
): SyncRequest {
  return {
    version: 1,
    requestId: `server-request-${operation}-${String(Math.random()).slice(2)}`,
    operation,
    projectId: "demo",
    grant: testGrant,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    nonce: `server-nonce-${String(Math.random()).slice(2)}`,
    baseHead: null,
    expectedLocalHead: null,
    expectedRemoteHead: null,
    payload: {},
    ...values,
  };
}

function agentClient(agent: SyncAgent): TunnelSyncClient {
  type Values = {
    baseHead?: string | null;
    expectedLocalHead?: string | null;
    expectedRemoteHead?: string | null;
    payload?: Record<string, unknown>;
    requestId?: string;
  };
  const requestClient = async (
    operation: SyncRequest["operation"],
    projectId: string,
    values: Values = {},
  ): Promise<SyncResponse> =>
    agent.handle(
      request(operation, {
        projectId,
        requestId: values.requestId ?? `agent-${operation}-${String(Math.random()).slice(2)}`,
        baseHead: values.baseHead ?? null,

        expectedLocalHead: values.expectedLocalHead ?? null,
        expectedRemoteHead: values.expectedRemoteHead ?? null,
        payload: values.payload ?? {},
      }),
    );
  const bundleClient = async (
    bundle: { head: string; sha256: string; bytes: Uint8Array },
    projectId: string,
    values: Values = {},
  ): Promise<SyncResponse> =>
    requestClient("import_bundle", projectId, {
      ...values,
      payload: {
        head: bundle.head,
        sha256: bundle.sha256,
        bytesBase64: Buffer.from(bundle.bytes).toString("base64"),
      },
    });
  return {
    request: requestClient,
    requestWithBundle: bundleClient,
  } as unknown as TunnelSyncClient;
}

function projectConfig(remotePath: string): ProjectConfig {
  return {
    id: "demo",
    name: "Demo",
    remotePath,
    devCommand: "node dev.js",
    devPort: 3000,
    previewPath: "/preview/demo/",
  };
}

describe("runner synchronization", () => {
  test("pushes a clean local snapshot into the remote shadow worktree", async () => {
    const local = await project("local");
    const remote = await project("remote");
    await writeFile(join(local.workTree, "README.md"), "from pc\n");
    const config = {
      host: "127.0.0.1",
      port: 4100,
      home: local.root,
      transactionPath: join(local.root, "transactions"),
      backupPath: join(local.root, "backups"),
      projects: [
        {
          id: "demo",
          name: "Demo",
          localPath: local.workTree,
          shadowPath: local.shadowPath,
        },
      ],
      maxFileBytes: 10_000_000,
      maxTotalBytes: 100_000_000,
      maxFileCount: 10_000,
      maxBundleBytes: 100_000_000,
      requestTimeoutMs: 30_000,
    };
    const agent = new SyncAgent(config, () => undefined);
    const remoteGit = new ShadowGit({
      gitDir: remote.shadowPath,
      workTree: remote.workTree,
    });
    await remoteGit.baseline();
    const coordinator = new SyncCoordinator({
      projects: [projectConfig(remote.workTree)],
      shadowRoot: join(remote.root, "state-shadow"),
      statePath: join(remote.root, "sync-state"),
      client: agentClient(agent),
    });
    const requestId = "push-retry-123456";
    const result = await coordinator.push("demo", testGrant, requestId);
    expect(result.status).toBe("ok");
    const retry = await coordinator.push("demo", testGrant, requestId);
    expect(retry.replayed).toBe(true);
    expect(await readFile(join(remote.workTree, "README.md"), "utf8")).toBe("from pc\n");
    const synced = await coordinator.status("demo");
    expect(synced).toMatchObject({ neverSynced: false, changedFiles: 0 });
    expect(synced.lastSyncAt).not.toBeNull();
    await writeFile(join(remote.workTree, "README.md"), "agent edit\n");
    await writeFile(join(remote.workTree, "added.txt"), "new\n");
    expect(await coordinator.status("demo")).toMatchObject({
      changedFiles: 2,
      changedPaths: ["README.md", "added.txt"],
    });
    await writeFile(join(remote.workTree, "README.md"), "from pc\n");
    await rm(join(remote.workTree, "added.txt"));
    const appliedGit = new ShadowGit({
      gitDir: join(remote.root, "state-shadow", "demo.git"),
      workTree: remote.workTree,
    });
    expect(await appliedGit.isClean()).toBe(true);
    const previous = (await appliedGit.head()) as string;
    await writeFile(join(remote.workTree, "README.md"), "from pc\nwith detail\n");
    const changed = await appliedGit.snapshot("diff detail");
    const diff = await appliedGit.diff(previous, changed);
    expect(diff).toMatchObject({ additions: 1, deletions: 0 });
    expect(diff.files[0]).toMatchObject({
      path: "README.md",
      status: "modified",
      binary: false,
      additions: 1,
      deletions: 0,
    });
    expect(diff.files[0]?.hunks[0]?.lines).toContainEqual({
      type: "addition",
      oldLine: null,
      newLine: 2,
      content: "with detail",
    });
  });

  test("previews a first push as every file, without transferring or applying any", async () => {
    const local = await project("preview-local");
    const remote = await project("preview-remote");
    await writeFile(join(local.workTree, "README.md"), "preview\n");
    const agent = new SyncAgent(
      {
        host: "127.0.0.1",
        port: 4100,
        home: local.root,
        transactionPath: join(local.root, "transactions"),
        backupPath: join(local.root, "backups"),
        projects: [
          {
            id: "demo",
            name: "Demo",
            localPath: local.workTree,
            shadowPath: local.shadowPath,
          },
        ],
        maxFileBytes: 10_000_000,
        maxTotalBytes: 100_000_000,
        maxFileCount: 10_000,
        maxBundleBytes: 100_000_000,
        requestTimeoutMs: 30_000,
      },
      () => undefined,
    );
    const coordinator = new SyncCoordinator({
      projects: [projectConfig(remote.workTree)],
      shadowRoot: join(remote.root, "state-shadow"),
      statePath: join(remote.root, "sync-state"),
      client: agentClient(agent),
    });
    const preview = await coordinator.preview("demo", "push", testGrant, "preview-request-123");
    expect(preview.status).toBe("ok");

    expect(preview.state?.baseHead).toBeNull();
    expect(preview.diff?.files.map((file) => [file.path, file.status])).toEqual([
      ["README.md", "added"],
    ]);
    expect(await readFile(join(local.workTree, "README.md"), "utf8")).toBe("preview\n");
    await expect(readFile(join(remote.workTree, "README.md"), "utf8")).rejects.toThrow();
  });

  test("upserts offline failure events by request id", async () => {
    const remote = await project("offline-remote");
    const statePath = join(remote.root, "sync-state");
    const coordinator = new SyncCoordinator({
      projects: [projectConfig(remote.workTree)],
      shadowRoot: join(remote.root, "state-shadow"),
      statePath,
      client: {
        request: () => {
          throw new SyncOfflineError();
        },
      } as unknown as TunnelSyncClient,
    });
    await expect(coordinator.push("demo", testGrant, "offline-request-123")).rejects.toBeInstanceOf(
      SyncOfflineError,
    );
    await expect(coordinator.push("demo", testGrant, "offline-request-123")).rejects.toBeInstanceOf(
      SyncOfflineError,
    );
    const events = await coordinator.history("demo");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      requestId: "offline-request-123",
      status: "offline",
    });
  });

  test("checkpoints the remote worktree and returns its commit", async () => {
    const remote = await project("remote");
    await writeFile(join(remote.workTree, "agent.txt"), "checkpoint\n");
    const config = projectConfig(remote.workTree);
    const coordinator = new SyncCoordinator({
      projects: [config],
      shadowRoot: join(remote.root, "state-shadow"),
      statePath: join(remote.root, "sync-state"),
      client: agentClient(
        new SyncAgent(
          {
            host: "127.0.0.1",
            port: 4100,
            home: remote.root,
            transactionPath: join(remote.root, "transactions"),
            backupPath: join(remote.root, "backups"),
            projects: [
              {
                id: "demo",
                name: "Demo",
                localPath: remote.workTree,
                shadowPath: join(remote.root, "pc-shadow"),
              },
            ],
            maxFileBytes: 10_000_000,
            maxTotalBytes: 100_000_000,
            maxFileCount: 10_000,
            maxBundleBytes: 100_000_000,
            requestTimeoutMs: 30_000,
          },
          () => undefined,
        ),
      ),
    });
    const { commit } = await coordinator.checkpoint("demo", "session-1");
    expect(commit).toMatch(/^[0-9a-f]{40,64}$/);
    const git = new ShadowGit({
      gitDir: join(remote.root, "state-shadow", "demo.git"),
      workTree: remote.workTree,
    });
    expect(await git.head()).toBe(commit);
  });

  test("recovers an incomplete runner transaction", async () => {
    const remote = await project("recovery");
    await writeFile(join(remote.workTree, "agent.txt"), "unfinished\n");
    const statePath = join(remote.root, "sync-state");
    const shadowRoot = join(remote.root, "state-shadow");
    const coordinator = new SyncCoordinator({
      projects: [projectConfig(remote.workTree)],
      shadowRoot,
      statePath,
      client: agentClient(
        new SyncAgent(
          {
            host: "127.0.0.1",
            port: 4100,
            home: remote.root,
            transactionPath: join(remote.root, "transactions"),
            backupPath: join(remote.root, "backups"),
            projects: [
              {
                id: "demo",
                name: "Demo",
                localPath: remote.workTree,
                shadowPath: join(remote.root, "pc-shadow"),
              },
            ],
            maxFileBytes: 10_000_000,
            maxTotalBytes: 100_000_000,
            maxFileCount: 10_000,
            maxBundleBytes: 100_000_000,
            requestTimeoutMs: 30_000,
          },
          () => undefined,
        ),
      ),
    });
    const git = new ShadowGit({
      gitDir: join(shadowRoot, "demo.git"),
      workTree: remote.workTree,
    });
    const baseline = await git.baseline();
    await git.snapshot("incomplete");
    const recoveryPath = join(statePath, "demo", "recovery", "recover-test.json");
    const transactionPath = join(statePath, "demo", "transactions", "recover-test.json");
    await mkdir(join(statePath, "demo", "recovery"), { recursive: true });
    await mkdir(join(statePath, "demo", "transactions"), { recursive: true });
    await writeFile(recoveryPath, JSON.stringify({ head: baseline }));
    await writeFile(
      transactionPath,
      JSON.stringify({
        requestId: "recover-test",
        projectId: "demo",
        direction: "push",
        status: "prepared",
        baseHead: baseline,
        expectedLocalHead: baseline,
        expectedRemoteHead: baseline,
        preflight: "tree",
        recoveryPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    await coordinator.recover("demo");
    expect(await git.head()).toBe(baseline);
    expect(await readFile(transactionPath, "utf8")).toContain("rolled_back");
  });

  test("uses raw bundle streaming through the tunnel client", async () => {
    const local = await project("local-stream");
    const remote = await project("remote-stream");
    const config = {
      host: "127.0.0.1",
      port: 4100,
      home: local.root,
      transactionPath: join(local.root, "transactions"),
      backupPath: join(local.root, "backups"),
      projects: [
        {
          id: "demo",
          name: "Demo",
          localPath: local.workTree,
          shadowPath: local.shadowPath,
        },
      ],
      maxFileBytes: 10_000_000,
      maxTotalBytes: 100_000_000,
      maxFileCount: 10_000,
      maxBundleBytes: 100_000_000,
      requestTimeoutMs: 30_000,
    };

    const grants = GrantAuthority.random();
    const instance = await createSyncAgentServer(config, grants);
    await new Promise<void>((resolveListen) => {
      instance.server.listen(0, "127.0.0.1", () => {
        resolveListen();
      });
    });
    try {
      const address = instance.server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      const client = new TunnelSyncClient({
        endpoint: `http://127.0.0.1:${String(address.port)}/v1/sync`,
      });
      const push = grants.mint("demo", "push").grant;
      const pull = grants.mint("demo", "pull").grant;
      const created = await client.request("create_bundle", "demo", {
        grant: push,
      });
      expect(created.bundle?.bytesBase64).toBeTruthy();
      const refused = await client.request("create_bundle", "demo", {
        grant: pull,
      });
      expect(refused.error?.code).toBe("grant_wrong_direction");

      const state = await client.request("state", "demo", {
        grant: pull,
        payload: { runnerBase: created.bundle?.head ?? null },
      });
      expect(state.state?.baseHead).toBe(created.bundle?.head);
      const remoteGit = new ShadowGit({
        gitDir: remote.shadowPath,
        workTree: remote.workTree,
      });
      const remoteHead = await remoteGit.snapshot("remote checkpoint");
      const bundle = await remoteGit.createBundle(remoteHead, join(remote.root, "bundles"), null);
      const imported = await client.requestWithBundle(bundle, "demo", {
        grant: pull,
        baseHead: state.state?.baseHead ?? null,
      });
      expect(imported.status).toBe("ok");
    } finally {
      await instance.close();
    }
  });

  test("pushes a first snapshot whose diff is far larger than an HTTP header", async () => {
    const local = await project("local-large");
    const remote = await project("remote-large");

    for (let index = 0; index < 100; index += 1) {
      const lines = Array.from(
        { length: 100 },
        (_, line) => `file ${String(index)} line ${String(line)}`,
      );
      await writeFile(
        join(local.workTree, `file-${String(index).padStart(3, "0")}.txt`),
        `${lines.join("\n")}\n`,
      );
    }
    const config = {
      host: "127.0.0.1",
      port: 4100,
      home: local.root,
      transactionPath: join(local.root, "transactions"),
      backupPath: join(local.root, "backups"),
      projects: [
        {
          id: "demo",
          name: "Demo",
          localPath: local.workTree,
          shadowPath: local.shadowPath,
        },
      ],
      maxFileBytes: 10_000_000,
      maxTotalBytes: 100_000_000,
      maxFileCount: 10_000,
      maxBundleBytes: 100_000_000,
      requestTimeoutMs: 30_000,
    };
    const grants = GrantAuthority.random();
    const instance = await createSyncAgentServer(config, grants);
    await new Promise<void>((resolveListen) => {
      instance.server.listen(0, "127.0.0.1", () => {
        resolveListen();
      });
    });
    try {
      const address = instance.server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      const coordinator = new SyncCoordinator({
        projects: [projectConfig(remote.workTree)],
        shadowRoot: join(remote.root, "state-shadow"),
        statePath: join(remote.root, "sync-state"),
        client: new TunnelSyncClient({
          endpoint: `http://127.0.0.1:${String(address.port)}/v1/sync`,
        }),
      });
      const result = await coordinator.push("demo", grants.mint("demo", "push").grant);
      expect(result.status).toBe("ok");
      expect(result.diff?.files).toHaveLength(100);
      expect(result.diff?.additions).toBe(10_000);
      expect(result.diff?.files[0]?.hunks[0]?.lines[0]).toMatchObject({
        type: "addition",
        content: "file 0 line 0",
      });
      expect(await readFile(join(remote.workTree, "file-099.txt"), "utf8")).toContain(
        "file 99 line 99",
      );
    } finally {
      await instance.close();
    }
  });

  test("reports PC offline without returning a partial result", async () => {
    const client = new TunnelSyncClient({
      endpoint: "http://127.0.0.1:1/v1/sync",
      timeoutMs: 1000,
    });
    await expect(client.request("state", "demo", { grant: testGrant })).rejects.toBeInstanceOf(
      SyncOfflineError,
    );
  });
});
