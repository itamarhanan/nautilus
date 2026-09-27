import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { brand } from "@nautilus/brand";
import type { SyncFileChange, SyncResponse } from "@nautilus/types";
import { diffDisplay } from "../src/lib/diff";
import { AgentProcess, agentExitMessage, createLaunchKey } from "../src/lib/agent";
import { AgentApi, ApiError, ControlApi } from "../src/lib/api";
import { ControlChannel } from "../src/lib/control";
import { friendlyError } from "../src/lib/errors";
import {
  describeFolder,
  fuzzyMatch,
  inferDevCommand,
  rankFolders,
  scanFolders,
  type DirEntry,
  type FolderIo,
} from "../src/lib/folders";
import type { RunningProcess, SpawnHandlers, Spawner } from "../src/lib/process";
import {
  detectLightningHost,
  readSettings,
  settingsDocument,
  validateSettings,
  type DesktopSettings,
} from "../src/lib/settings";
import { controlArgs, resolveHomePath, SshForward, syncArgs } from "../src/lib/ssh";
import {
  emptyState,
  maxRecentFolders,
  projectIdForFolder,
  readState,
  touchRecent,
  withoutProject,
  withProject,
} from "../src/lib/state";
import { editablePath } from "../src/lib/editor";
import { SyncSession } from "../src/lib/sync";
import { createDesktopStore, type DesktopServices } from "../src/store";

const settings: DesktopSettings = {
  runnerUrl: "https://8080-studio.cloudspaces.litng.ai",
  ssh: {
    host: "ssh.lightning.ai",
    user: "s_01abc",
    keyPath: "~/.ssh/lightning_rsa",
  },
  projectRoots: ["~/code"],
};

function firstCall(mock: { mock: { calls: unknown[][] } }): [string, RequestInit | undefined] {
  const [input, init] = (mock.mock.calls[0] ?? []) as [
    string | URL | Request | undefined,
    RequestInit | undefined,
  ];
  const url =
    input instanceof URL ? input.href : input instanceof Request ? input.url : (input ?? "");
  return [url, init];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FakeChild = {
  program: string;
  args: string[];
  handlers: SpawnHandlers;
  written: string[];
  killed: boolean;
};

function fakeSpawner(behave: (child: FakeChild) => void = () => undefined): {
  spawn: Spawner;
  children: FakeChild[];
} {
  const children: FakeChild[] = [];
  const spawn: Spawner = (program, args, handlers) => {
    const child: FakeChild = {
      program,
      args,
      handlers,
      written: [],
      killed: false,
    };
    children.push(child);
    const running: RunningProcess = {
      write: (data) => {
        child.written.push(data);
        return Promise.resolve();
      },
      kill: () => {
        child.killed = true;
        handlers.onClose(null);
        return Promise.resolve();
      },
    };
    queueMicrotask(() => {
      behave(child);
    });
    return Promise.resolve(running);
  };
  return { spawn, children };
}

describe("settings", () => {
  it("migrates keys from older config files and writes only global settings", () => {
    const legacy = readSettings({
      runnerUrl: "https://runner.example",
      sshHost: "ssh.lightning.ai",
      sshUser: "s_old",
      sshKeyPath: "~/.ssh/id",
      credentialsPath: "~/.nautilus/credentials.json",
      localAgentPort: 4100,
      projects: [{ id: "demo" }],
    });
    expect(legacy).toEqual({
      runnerUrl: "https://runner.example",
      ssh: { host: "ssh.lightning.ai", user: "s_old", keyPath: "~/.ssh/id" },
      projectRoots: ["~"],
    });
    expect(Object.keys(settingsDocument(legacy)).sort()).toEqual([
      "projectRoots",
      "runnerUrl",
      "ssh",
    ]);
  });

  it("reports each invalid field", () => {
    const errors = validateSettings({
      runnerUrl: "http://runner.example/path",
      ssh: { host: "bad host", user: "", keyPath: "relative/key" },
      projectRoots: ["code"],
    });
    expect(Object.keys(errors).sort()).toEqual([
      "keyPath",
      "projectRoots",
      "runnerUrl",
      "sshHost",
      "sshUser",
    ]);
    expect(validateSettings(settings)).toEqual({});

    expect(
      validateSettings(
        {
          ...settings,
          runnerUrl: "",
          ssh: { host: "", user: "", keyPath: "" },
        },
        true,
      ),
    ).toEqual({});
  });

  it("finds the host block written by lightning ssh configure", () => {
    const config = [
      "Host github.com",
      "  HostName github.com",
      "  User git",
      "",
      "Host nautilus",
      "      User s_01m3bh0wj9rf3peqy978kv25d2",
      "      Hostname ssh.lightning.ai",
      "      IdentityFile ~/.ssh/lightning_rsa",
    ].join("\n");
    expect(detectLightningHost(config)).toEqual({
      host: "ssh.lightning.ai",
      user: "s_01m3bh0wj9rf3peqy978kv25d2",
    });
    expect(detectLightningHost("Host x\n  HostName example.com\n  User s_1")).toBeUndefined();
  });
});

describe("app state", () => {
  it("drops invalid entries and unknown last projects", () => {
    const state = readState({
      projects: [
        {
          id: "shop",
          name: "Shop",
          localPath: "~/code/shop",
          devCommand: "pnpm dev",
          addedAt: "2026-09-01",
        },
        { id: "../bad", localPath: "~/x" },
        { id: "nopath" },
      ],
      recentFolders: [{ path: "~/code/shop", lastUsedAt: "2026-09-01" }, { path: 1 }],
      lastProjectId: "missing",
    });
    expect(state.projects.map((project) => project.id)).toEqual(["shop"]);
    expect(state.recentFolders).toHaveLength(1);
    expect(state.lastProjectId).toBeNull();
  });

  it("keeps recent folders most recent first, capped, and after removal", () => {
    let state = emptyState;
    for (let index = 0; index < maxRecentFolders + 5; index += 1) {
      state = touchRecent(state, `~/code/p${String(index)}`, new Date(2026, 0, 1, 0, index));
    }
    state = touchRecent(state, "~/code/p3");
    expect(state.recentFolders).toHaveLength(maxRecentFolders);
    expect(state.recentFolders[0]?.path).toBe("~/code/p3");

    state = withProject(state, {
      id: "shop",
      name: "Shop",
      localPath: "~/code/shop",
      devCommand: "pnpm dev",
      addedAt: new Date().toISOString(),
      acknowledgedExclusions: [],
    });
    expect(state.lastProjectId).toBe("shop");
    state = withoutProject(state, "shop");
    expect(state.projects).toEqual([]);
    expect(state.recentFolders[0]?.path).toBe("~/code/shop");
  });

  it("derives unique project ids from folder names", () => {
    expect(projectIdForFolder("My Shop!", [])).toBe("my-shop");
    expect(projectIdForFolder("My Shop", ["my-shop", "my-shop-2"])).toBe("my-shop-3");
    expect(projectIdForFolder("_private", [])).toBe("project-_private");
    expect(projectIdForFolder("日本", [])).toBe("project-folder");
  });
});

describe("project folders", () => {
  const tree: Record<string, DirEntry[]> = {
    "/home/me": [
      { name: "code", isDirectory: true },
      { name: ".config", isDirectory: true },
      { name: "node_modules", isDirectory: true },
      { name: "notes.txt", isDirectory: false },
    ],
    "/home/me/code": [
      { name: "shop", isDirectory: true },
      { name: "tools", isDirectory: true },
    ],
    "/home/me/code/shop": [
      { name: ".git", isDirectory: true },
      { name: "package.json", isDirectory: false },
      { name: "pnpm-lock.yaml", isDirectory: false },
      { name: "packages", isDirectory: true },
    ],
    "/home/me/code/shop/packages": [{ name: "inner", isDirectory: true }],
    "/home/me/code/tools": [{ name: "cli", isDirectory: true }],
    "/home/me/code/tools/cli": [{ name: ".git", isDirectory: true }],
    "/home/me/.config": [{ name: "app", isDirectory: true }],
  };
  const io: FolderIo = {
    listDir: (path) => {
      const entries = tree[path];
      return entries ? Promise.resolve(entries) : Promise.reject(new Error(`no ${path}`));
    },
    readText: (path) =>
      path === "/home/me/code/shop/package.json"
        ? Promise.resolve(JSON.stringify({ scripts: { dev: "vite", start: "node ." } }))
        : Promise.reject(new Error("missing")),
  };

  it("finds projects, skips hidden and dependency folders, and stops at a project", async () => {
    const found = await scanFolders(["~"], io, "/home/me");
    expect(found).toEqual([
      {
        name: "shop",
        path: "~/code/shop",
        git: true,
        packageManager: "pnpm",
        devScript: "dev",
      },
      {
        name: "cli",
        path: "~/code/tools/cli",
        git: true,
        packageManager: null,
        devScript: null,
      },
    ]);
  });

  it("respects the depth limit", async () => {
    expect(await scanFolders(["~"], io, "/home/me", 2)).toHaveLength(1);
  });

  it("classifies a single folder chosen with Browse", async () => {
    expect(
      await describeFolder("/home/me/code", tree["/home/me/code"] ?? [], io, "/home/me"),
    ).toBeUndefined();
  });

  it("infers the dev command from the package manager and scripts", () => {
    expect(inferDevCommand("pnpm", "dev")).toBe("pnpm dev");
    expect(inferDevCommand("npm", "start")).toBe("npm start");
    expect(inferDevCommand(null, "dev")).toBe("npm run dev");
    expect(inferDevCommand("bun", "dev")).toBe("bun run dev");
    expect(inferDevCommand("yarn", null)).toBeNull();
  });

  it("ranks name matches first and prefers word starts", () => {
    const items = [
      { name: "nightshade", path: "~/games/nightshade" },
      { name: "nautilus-shop", path: "~/code/nautilus-shop" },
      { name: "blog", path: "~/code/nsh/blog" },
    ];
    const ranked = rankFolders("nsh", items).map((entry) => entry.item.name);
    expect(ranked).toEqual(["nautilus-shop", "nightshade", "blog"]);
    expect(fuzzyMatch("xyz", "nautilus")).toBeNull();
    expect(fuzzyMatch("ns", "nautilus-shop")?.indices).toEqual([0, 9]);
    expect(rankFolders("", items).map((entry) => entry.item.name)).toEqual(
      items.map((item) => item.name),
    );
  });
});

describe("ssh forwards", () => {
  const capability = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../src-tauri/capabilities/default.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    permissions: Array<
      | string
      | {
          identifier: string;
          allow?: Array<{
            name?: string;
            cmd?: string;
            sidecar?: boolean;
            args?: unknown[];
          }>;
        }
    >;
  };
  const spawnScope = capability.permissions.find(
    (
      permission,
    ): permission is {
      identifier: string;
      allow: Array<{
        name?: string;
        cmd?: string;
        sidecar?: boolean;
        args?: unknown[];
      }>;
    } => typeof permission === "object" && permission.identifier === "shell:allow-spawn",
  );

  function allowedBy(name: string, args: string[]): boolean {
    const scope = spawnScope?.allow.find((entry) => entry.name === name)?.args;
    if (!scope || scope.length !== args.length) return false;
    return scope.every((rule, index) => {
      const value = args[index] ?? "";
      return typeof rule === "string"
        ? rule === value
        : new RegExp((rule as { validator: string }).validator).test(value);
    });
  }

  const key = resolveHomePath(settings.ssh.keyPath, "/home/me");

  it("builds a local-only control forward the capability allows", () => {
    const args = controlArgs(settings, key, 47123);
    expect(args).toContain("-L");
    expect(args).not.toContain("-R");
    expect(args).toContain("127.0.0.1:47123:127.0.0.1:4001");
    expect(args).toContain("StrictHostKeyChecking=accept-new");
    expect(allowedBy("nautilus-ssh-control", args)).toBe(true);

    expect(
      allowedBy(
        "nautilus-ssh-control",
        args.map((arg) => arg.replace(":4001", ":22")),
      ),
    ).toBe(false);
  });

  it("builds a reverse-only sync forward the capability allows", () => {
    const args = syncArgs(settings, key);
    expect(args).toContain("-R");
    expect(args).not.toContain("-L");
    expect(args).toContain("127.0.0.1:4200:127.0.0.1:4100");
    expect(allowedBy("nautilus-ssh-sync", args)).toBe(true);
    expect(allowedBy("nautilus-ssh-control", args)).toBe(false);
  });

  it("allows the agent only as the shipped sidecar with a stdin key", () => {
    expect(allowedBy("binaries/nautilus-sync-agent", ["--launch-key-stdin"])).toBe(true);
    expect(allowedBy("binaries/nautilus-sync-agent", ["-e", "--launch-key-stdin"])).toBe(false);
    expect(allowedBy("binaries/nautilus-sync-agent", [])).toBe(false);
    const entry = spawnScope?.allow.find((scope) => scope.name === "binaries/nautilus-sync-agent");
    expect(entry?.sidecar).toBe(true);
    expect(spawnScope?.allow.some((scope) => scope.cmd === "node")).toBe(false);
  });

  it("rejects unsafe SSH targets and key paths", () => {
    expect(() =>
      controlArgs(
        { ...settings, ssh: { ...settings.ssh, user: "s_1 -oProxyCommand=x" } },
        key,
        47000,
      ),
    ).toThrow();
    expect(() => resolveHomePath("relative/key", "/home/me")).toThrow();
    expect(resolveHomePath("~/.ssh/k", "/home/me")).toBe("/home/me/.ssh/k");
  });

  it("connects once ready and reports ssh's reason when it exits first", async () => {
    const good = fakeSpawner();
    const forward = new SshForward("nautilus-ssh-sync", ["args"], good.spawn);
    await forward.start(() => Promise.resolve(true));
    expect(forward.state).toBe("connected");
    await forward.stop();
    expect(good.children[0]?.killed).toBe(true);

    const failing = fakeSpawner((child) => {
      child.handlers.onStderr?.("s_01abc@ssh.lightning.ai: Permission denied (publickey).");
      child.handlers.onClose(255);
    });
    const broken = new SshForward("nautilus-ssh-sync", ["args"], failing.spawn);
    await expect(broken.start(() => Promise.resolve(false), 2_000)).rejects.toThrow(
      /Permission denied/,
    );
    expect(friendlyError(new Error("ssh exited: Permission denied (publickey)")).message).toMatch(
      /rejected the SSH key/,
    );
  });
});

describe("control channel", () => {
  it("connects through the SSH forward and reconnects after it drops", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(jsonResponse({ service: "nautilus-server", version: "1.2.3" })),
        ),
    );
    const timers: Array<() => void> = [];
    const { spawn, children } = fakeSpawner();
    const channel = new ControlChannel({
      spawn,
      home: "/home/me",
      localMode: false,
      setTimer: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimer: () => undefined,
    });
    const phases: string[] = [];
    channel.subscribe((snapshot) => phases.push(snapshot.phase));
    await channel.connect(settings);
    expect(channel.current.phase).toBe("connected");
    expect(channel.current.info?.version).toBe("1.2.3");
    expect(children[0]?.program).toBe("nautilus-ssh-control");
    const [url, init] = firstCall(vi.mocked(fetch));
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:47\d{3}\/api\/control\/info$/);
    expect(new Headers(init?.headers).get("x-nautilus-control")).toBe("1");
    expect(new Headers(init?.headers).get("authorization")).toBeNull();

    children[0]?.handlers.onClose(255);
    expect(channel.current.phase).toBe("reconnecting");
    expect(timers).toHaveLength(1);
    timers[0]?.();
    await vi.waitFor(() => {
      expect(channel.current.phase).toBe("connected");
    });
    expect(children).toHaveLength(2);
    await channel.disconnect();
    expect(phases).toContain("connecting");
  });

  it("fails without retrying when validating new settings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const { spawn } = fakeSpawner((child) => {
      child.handlers.onStderr?.("ssh: Could not resolve hostname ssh.lightning.ai");
      child.handlers.onClose(255);
    });
    const channel = new ControlChannel({
      spawn,
      home: "/home/me",
      localMode: false,
      setTimer: () => 0,
    });
    await expect(channel.connect(settings, { retry: false })).rejects.toThrow(
      /could not be resolved/,
    );
    expect(channel.current.phase).toBe("offline");
  });
});

describe("sync agent process", () => {
  it("passes a fresh launch key on stdin and waits for ready", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ ok: true }))),
    );
    const { spawn, children } = fakeSpawner((child) => {
      child.handlers.onStdout?.('{"event":"ready","port":4100}');
    });
    const agent = new AgentProcess({ spawn });
    await agent.start();
    expect(agent.current.phase).toBe("running");
    expect(children[0]?.args).toEqual(["--launch-key-stdin"]);
    const written = children[0]?.written[0] ?? "";
    expect(written).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    await agent.stop();
    expect(children[0]?.killed).toBe(true);
  });

  it("shares one launch between concurrent starts and ignores a replaced child's exit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ ok: true }))),
    );
    const { spawn, children } = fakeSpawner((child) => {
      child.handlers.onStdout?.('{"event":"ready","port":4100}');
    });
    const agent = new AgentProcess({ spawn });
    const [first, second] = await Promise.all([agent.start(), agent.start()]);
    expect(first).toBe(second);
    expect(children).toHaveLength(1);
    expect(agent.current.phase).toBe("running");
  });

  it("stops an agent left running by a reloaded webview before starting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ ok: true }))),
    );
    const { spawn } = fakeSpawner((child) => {
      child.handlers.onStdout?.('{"event":"ready","port":4100}');
    });
    let stored: number | null = 4242;
    const killed: number[] = [];
    const agent = new AgentProcess({
      spawn: async (...args) => ({ ...(await spawn(...args)), pid: 5151 }),
      previous: {
        read: () => stored,
        write: (pid) => {
          stored = pid;
        },
        kill: (pid) => {
          killed.push(pid);
          return Promise.resolve();
        },
      },
    });
    await agent.start();
    expect(killed).toEqual([4242]);
    expect(stored).toBe(5151);
    await agent.stop();
    expect(stored).toBeNull();
  });

  it("explains a taken port", () => {
    expect(
      agentExitMessage(1, "Error: listen EADDRINUSE: address already in use 127.0.0.1:4100"),
    ).toMatch(/already in use/);
    expect(createLaunchKey()).not.toBe(createLaunchKey());
  });
});

describe("control API", () => {
  it("keeps structured conflict responses", async () => {
    const conflict = {
      version: 1,
      requestId: "request-1",
      status: "conflict",
      conflicts: [{ path: "src/app.ts", reason: "content_conflict" }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(conflict, 409)));
    const api = new ControlApi("http://127.0.0.1:47001");
    const error = await api
      .sync("demo", "push", { grant: "g.s" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).syncResponse).toEqual(conflict);
    expect((error as ApiError).conflicts).toEqual(conflict.conflicts);
  });

  it("sends the grant and never a bearer token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ version: 1, requestId: "r", status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    await new ControlApi("http://127.0.0.1:47001").sync("demo", "pull", {
      grant: "payload.sig",
      requestId: "req-12345678",
    });
    const [url, init] = firstCall(fetchMock);
    expect(url).toBe("http://127.0.0.1:47001/api/projects/demo/sync-requests");
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "{}")).toEqual({
      direction: "pull",
      grant: "payload.sig",
      requestId: "req-12345678",
    });
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });

  it("authenticates agent calls with the launch key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ grant: "a.b", claims: { grantId: "g" } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    await new AgentApi("http://127.0.0.1:4100", "launch-key").mintGrant("demo", "push");
    const [, init] = firstCall(fetchMock);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer launch-key");
  });
});

describe("sync session", () => {
  function fakes(preview: SyncResponse | Error) {
    const mocks = {
      mintGrant: vi.fn().mockResolvedValue({
        grant: "payload.sig",
        claims: { grantId: "grant-1" },
      }),
      revokeGrant: vi.fn().mockResolvedValue(undefined),
      tunnelHealth: vi.fn().mockResolvedValue(true),
      syncPreview:
        preview instanceof Error
          ? vi.fn().mockRejectedValue(preview)
          : vi.fn().mockResolvedValue(preview),
      sync: vi.fn().mockResolvedValue({ version: 1, requestId: "r", status: "ok" }),
    };
    const agent = {
      mintGrant: mocks.mintGrant,
      revokeGrant: mocks.revokeGrant,
    } as unknown as AgentApi;
    const control = {
      tunnelHealth: mocks.tunnelHealth,
      syncPreview: mocks.syncPreview,
      sync: mocks.sync,
    } as unknown as ControlApi;
    return { agent, control, mocks };
  }

  it("opens the reverse tunnel, forwards the grant, and cleans up", async () => {
    const { agent, control, mocks } = fakes({
      version: 1,
      requestId: "preview-1",
      status: "ok",
    });
    const { spawn, children } = fakeSpawner();
    const session = new SyncSession({
      projectId: "demo",
      direction: "pull",
      control,
      agent,
      settings,
      home: "/home/me",
      spawn,
      localMode: false,
    });
    await session.preview();
    expect(children[0]?.program).toBe("nautilus-ssh-sync");
    expect(mocks.syncPreview).toHaveBeenCalledWith(
      "demo",
      "pull",
      expect.objectContaining({ grant: "payload.sig" }),
    );
    await session.apply("preview-1");
    expect(mocks.sync).toHaveBeenCalledWith(
      "demo",
      "pull",
      expect.objectContaining({ grant: "payload.sig", requestId: "preview-1" }),
    );
    await session.close();
    expect(mocks.revokeGrant).toHaveBeenCalledWith("grant-1");
    expect(children[0]?.killed).toBe(true);
  });

  it("treats a 409 conflict as a result and still revokes on failure", async () => {
    const conflict: SyncResponse = {
      version: 1,
      requestId: "r",
      status: "conflict",
      conflicts: [{ path: "a", reason: "content_conflict" }],
    };
    const conflicted = fakes(new ApiError("conflict", "Conflict", 409, [], conflict));
    const local = {
      projectId: "demo",
      direction: "push" as const,
      settings,
      home: "/home/me",
      spawn: fakeSpawner().spawn,
      localMode: true,
    };
    const session = new SyncSession({
      ...local,
      agent: conflicted.agent,
      control: conflicted.control,
    });
    expect((await session.preview()).status).toBe("conflict");

    const { mocks: failingMocks, ...failing } = fakes(new Error("boom"));
    const broken = new SyncSession({ ...local, ...failing });
    await expect(broken.preview()).rejects.toThrow("boom");
    await broken.close();
    expect(failingMocks.revokeGrant).toHaveBeenCalledWith("grant-1");
  });
});

describe("desktop store", () => {
  function services(overrides: Partial<DesktopServices> = {}) {
    let savedState: unknown;
    const control = {
      projects: vi.fn().mockResolvedValue([]),
      devices: vi.fn().mockResolvedValue([]),
      registerProject: vi
        .fn()
        .mockImplementation((project: { projectId: string; name: string; devCommand: string }) =>
          Promise.resolve({
            id: project.projectId,
            name: project.name,
            devCommand: project.devCommand,
            state: "inactive",
          }),
        ),
      syncStatus: vi.fn().mockResolvedValue({
        projectId: "shop",
        neverSynced: true,
        changedFiles: 0,
        changedPaths: [],
      }),
      syncHistory: vi.fn().mockResolvedValue([]),
      rewindSyncBase: vi.fn().mockResolvedValue(undefined),
      syncPreview: vi.fn(),
      sync: vi.fn(),
      pairingCode: vi.fn().mockResolvedValue({
        id: "p",
        code: "ABCD2345",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    };
    const channel = {
      current: {
        phase: "connected",
        error: null,
        info: null,
        api: control,
        retryAt: null,
      },
      subscribe: vi.fn((listener: (snapshot: unknown) => void) => {
        listener({
          phase: "connected",
          error: null,
          info: null,
          api: control,
          retryAt: null,
        });
        return () => undefined;
      }),
      connect: vi.fn().mockResolvedValue(undefined),
      reconnect: vi.fn(),
    };
    const saveSettingsMock = vi.fn().mockResolvedValue(undefined);
    const agentClient = {
      status: vi.fn().mockResolvedValue({
        projectId: "shop",
        neverSynced: true,
        changedFiles: 0,
        changedPaths: [],
      }),
      mintGrant: vi.fn().mockResolvedValue({
        grant: "payload.sig",
        claims: { grantId: "grant-1" },
      }),
      revokeGrant: vi.fn().mockResolvedValue(undefined),
      undoPull: vi.fn().mockResolvedValue({
        projectId: "shop",
        neverSynced: false,
        changedFiles: 0,
        changedPaths: [],
        undoablePull: null,
      }),
    };
    const agent = {
      subscribe: vi.fn(() => () => undefined),
      start: vi.fn().mockResolvedValue(agentClient),
      client: agentClient,
    };
    const value: DesktopServices = {
      paths: () =>
        Promise.resolve({
          home: "/home/me",
          config: "c",
          state: "s",
          sshConfig: "k",
        }),
      loadSettings: () => Promise.resolve({ settings, exists: true }),
      saveSettings: saveSettingsMock,
      loadState: () => Promise.resolve(emptyState),
      saveState: vi.fn((_paths, state) => {
        savedState = state;
        return Promise.resolve();
      }),
      folderIo: {
        listDir: () => Promise.resolve([]),
        readText: () => Promise.resolve(""),
      },
      spawn: fakeSpawner().spawn,
      channel: channel as unknown as ControlChannel,
      agent: () => Promise.resolve(agent as unknown as AgentProcess),
      localMode: true,
      openFile: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    return {
      value,
      control,
      channel,
      agentClient,
      saveSettingsMock,
      savedState: () => savedState,
    };
  }

  it("adds a project on the runner and in state.json with its dev command", async () => {
    const { value, control, savedState } = services();
    const store = createDesktopStore(value);
    await store.getState().init();
    await store.getState().addProject({
      folder: {
        name: "Shop",
        path: "~/code/shop",
        git: true,
        packageManager: "pnpm",
        devScript: "dev",
      },
      name: "Shop",
      devCommand: "pnpm dev",
    });
    expect(control.registerProject).toHaveBeenCalledWith({
      projectId: "shop",
      name: "Shop",
      devCommand: "pnpm dev",
    });
    expect(savedState()).toMatchObject({
      projects: [
        {
          id: "shop",
          name: "Shop",
          localPath: "~/code/shop",
          devCommand: "pnpm dev",
        },
      ],
      recentFolders: [{ path: "~/code/shop" }],
      lastProjectId: "shop",
    });
    expect(store.getState().selectedProjectId).toBe("shop");
  });

  const twoProjects = {
    ...emptyState,
    lastProjectId: "blog",
    projects: ["shop", "blog"].map((id) => ({
      id,
      name: id,
      localPath: `/home/me/code/${id}`,
      devCommand: "pnpm dev",
      addedAt: "2026-01-01T00:00:00.000Z",
      acknowledgedExclusions: [],
    })),
  };

  it("undoes a pull on the runner before the PC, and refreshes afterwards", async () => {
    const { value, control, agentClient } = services({
      loadState: () => Promise.resolve(twoProjects),
    });
    control.projects.mockResolvedValue([{ id: "shop", name: "shop", state: "idle" }]);
    const pull = {
      requestId: "pull-1-apply",
      pulledAt: "2026-09-26T10:00:00.000Z",
      localHead: "a".repeat(40),
      remoteHead: "c".repeat(40),
      previousBaseHead: "b".repeat(40),
    };
    agentClient.status.mockResolvedValue({
      projectId: "shop",
      neverSynced: false,
      baseHead: pull.remoteHead,
      changedFiles: 0,
      changedPaths: [],
      undoablePull: pull,
    });
    const store = createDesktopStore(value);
    await store.getState().init();
    await store.getState().refreshStatus("shop");
    await store.getState().undoPull("shop");
    expect(control.rewindSyncBase).toHaveBeenCalledWith(
      "shop",
      pull.remoteHead,
      pull.previousBaseHead,
    );
    expect(agentClient.undoPull).toHaveBeenCalledWith("shop", "pull-1-apply");
    expect(control.rewindSyncBase.mock.invocationCallOrder[0]).toBeLessThan(
      agentClient.undoPull.mock.invocationCallOrder[0] ?? 0,
    );
    expect(store.getState().undoingPull).toBeNull();
    expect(store.getState().notices.at(-1)).toMatchObject({
      tone: "success",
      title: "Pull undone",
    });
  });

  it("leaves the PC alone when the runner refuses to rewind", async () => {
    const { value, control, agentClient } = services({
      loadState: () => Promise.resolve(twoProjects),
    });
    control.projects.mockResolvedValue([{ id: "shop", name: "shop", state: "idle" }]);
    control.rewindSyncBase.mockRejectedValue(
      new Error("The runner has synchronized since this pull"),
    );
    agentClient.status.mockResolvedValue({
      projectId: "shop",
      neverSynced: false,
      baseHead: "c".repeat(40),
      changedFiles: 0,
      changedPaths: [],
      undoablePull: {
        requestId: "pull-1-apply",
        pulledAt: "2026-09-26T10:00:00.000Z",
        localHead: "a".repeat(40),
        remoteHead: "c".repeat(40),
        previousBaseHead: "b".repeat(40),
      },
    });
    const store = createDesktopStore(value);
    await store.getState().init();
    await store.getState().refreshStatus("shop");
    await store.getState().undoPull("shop");
    expect(agentClient.undoPull).not.toHaveBeenCalled();
    expect(store.getState().notices.at(-1)).toMatchObject({
      tone: "error",
      title: "Could not undo the pull",
    });
  });

  describe("reviewing a sync", () => {
    const preview: SyncResponse = {
      version: 1,
      requestId: "preview-1",
      status: "ok",
      state: {
        projectId: "shop",
        head: "c".repeat(40),
        baseHead: "b".repeat(40),
        dirty: false,
        changes: { files: [], additions: 0, deletions: 0 },
      },
      diff: { files: [], additions: 0, deletions: 0 },
    };
    const conflict: SyncResponse = {
      version: 1,
      requestId: "pull-1",
      status: "conflict",
      conflicts: [
        {
          path: "a.ts",
          reason: "content_conflict",
          pc: "modified",
          runner: "modified",
        },
        {
          path: "b.ts",
          reason: "content_conflict",
          pc: "modified",
          runner: "modified",
        },
      ],
    };
    const applied: SyncResponse = {
      version: 1,
      requestId: "pull-2",
      status: "ok",
    };

    async function reviewing() {
      const harness = services({
        loadState: () => Promise.resolve(twoProjects),
      });
      harness.control.projects.mockResolvedValue([{ id: "shop", name: "shop", state: "idle" }]);
      harness.control.syncPreview.mockResolvedValue(preview);
      const store = createDesktopStore(harness.value);
      await store.getState().init();
      await store.getState().refreshRunner();
      await store.getState().startReview("pull", "shop");
      return { ...harness, store };
    }

    it("keeps the grant through a conflict and retries with the chosen sides", async () => {
      const { store, control, agentClient } = await reviewing();
      expect(store.getState().review).toMatchObject({
        phase: "ready",
        preview,
      });
      control.sync.mockResolvedValueOnce(conflict).mockResolvedValueOnce(applied);

      await store.getState().applyReview();
      expect(store.getState().review?.phase).toBe("resolving");
      expect(control.sync).toHaveBeenLastCalledWith(
        "shop",
        "pull",
        expect.objectContaining({
          grant: "payload.sig",
          requestId: "preview-1",
        }),
      );

      expect(agentClient.revokeGrant).not.toHaveBeenCalled();

      store.getState().resolveConflicts(["a.ts", "b.ts"], "runner");
      store.getState().resolveConflicts(["b.ts"], "pc");
      expect(store.getState().review?.resolutions).toEqual({
        "a.ts": "runner",
        "b.ts": "pc",
      });

      await store.getState().applyReview();

      const retry = control.sync.mock.calls[1]?.[2] as {
        requestId?: string;
        resolutions?: unknown;
      };
      expect(retry.requestId).toBeUndefined();
      expect(retry.resolutions).toEqual({ "a.ts": "runner", "b.ts": "pc" });
      expect(store.getState().review?.phase).toBe("done");
      expect(agentClient.revokeGrant).toHaveBeenCalledWith("grant-1");
    });

    it("finishes an apply after the sheet closes and reports it as a toast", async () => {
      const { store, control } = await reviewing();
      let finish: (result: SyncResponse) => void = () => undefined;
      control.sync.mockReturnValueOnce(
        new Promise<SyncResponse>((resolve) => {
          finish = resolve;
        }),
      );
      const applying = store.getState().applyReview();
      await store.getState().closeReview();
      expect(store.getState().review).toMatchObject({
        phase: "applying",
        background: true,
      });

      finish(applied);
      await applying;
      expect(store.getState().review).toBeNull();
      expect(store.getState().notices.at(-1)).toMatchObject({
        tone: "success",
        body: "shop",
      });
    });

    it("reopens the sheet when a background apply is blocked", async () => {
      const { store, control, agentClient } = await reviewing();
      let finish: (result: SyncResponse) => void = () => undefined;
      control.sync.mockReturnValueOnce(
        new Promise<SyncResponse>((resolve) => {
          finish = resolve;
        }),
      );
      const applying = store.getState().applyReview();
      await store.getState().closeReview();
      finish({
        version: 1,
        requestId: "pull-1",
        status: "stale",
        error: {
          code: "base_mismatch",
          message: "PC and runner synchronization bases differ",
        },
      });
      await applying;
      expect(store.getState().review).toMatchObject({
        phase: "blocked",
        background: false,
      });
      expect(store.getState().notices.at(-1)).toMatchObject({
        tone: "warning",
      });
      expect(agentClient.revokeGrant).toHaveBeenCalledWith("grant-1");
    });

    it("closing a review that is not applying revokes its grant", async () => {
      const { store, agentClient } = await reviewing();
      await store.getState().closeReview();
      expect(store.getState().review).toBeNull();
      expect(agentClient.revokeGrant).toHaveBeenCalledWith("grant-1");
    });
  });

  it("announces new runner work once, and stays quiet on the first look and when nothing moved", async () => {
    const alert = vi.fn();
    const { value, control } = services({
      loadState: () => Promise.resolve(twoProjects),
      alert,
    });
    control.projects.mockResolvedValue([{ id: "shop", name: "shop", state: "idle" }]);
    const status = (head: string, changedFiles: number) => ({
      projectId: "shop",
      neverSynced: false,
      head,
      baseHead: "b".repeat(40),
      changedFiles,
      changedPaths: [],
      excludedRepositories: [],
    });
    control.syncStatus.mockResolvedValue(status("1".repeat(40), 2));
    const store = createDesktopStore(value);
    await store.getState().init();

    await store.getState().refreshRunner();
    await store.getState().refreshStatus("shop");
    expect(alert).not.toHaveBeenCalled();

    control.syncStatus.mockResolvedValue(status("2".repeat(40), 3));
    await store.getState().refreshStatus("shop");
    expect(alert).toHaveBeenCalledOnce();
    expect(alert).toHaveBeenCalledWith(
      "New changes in shop",
      "3 files ready to pull from the runner.",
    );
  });

  it("opens on home, walks into a project, and goes back up one level at a time", async () => {
    const { value } = services({
      loadState: () => Promise.resolve(twoProjects),
    });
    const store = createDesktopStore(value);
    await store.getState().init();
    expect(store.getState().route).toEqual({ name: "home" });
    expect(store.getState().selectedProjectId).toBe("blog");

    store.getState().selectProject("shop", "settings");
    expect(store.getState().route).toEqual({
      name: "project",
      tab: "settings",
    });
    expect(store.getState().selectedProjectId).toBe("shop");

    store.getState().navigate({ name: "settings", section: "runner" });
    store.getState().navigate({ name: "settings", section: "phones" });
    store.getState().goUp();
    expect(store.getState().route).toEqual({
      name: "project",
      tab: "settings",
    });

    store.getState().goUp();
    expect(store.getState().route).toEqual({
      name: "project",
      tab: "overview",
    });
    store.getState().goUp();
    expect(store.getState().route).toEqual({ name: "home" });
  });

  it("opens settings first until the runner is configured", async () => {
    const { value } = services({
      loadSettings: () =>
        Promise.resolve({
          settings: { ...settings, runnerUrl: "" },
          exists: false,
        }),
      localMode: false,
    });
    const store = createDesktopStore(value);
    await store.getState().init();
    expect(store.getState().route).toEqual({
      name: "settings",
      section: "runner",
    });
  });

  it("loads every project's history for home and returns home after a removal", async () => {
    const { value, control } = services({
      loadState: () => Promise.resolve(twoProjects),
    });
    control.projects.mockResolvedValue(
      twoProjects.projects.map((project) => ({
        id: project.id,
        name: project.name,
        state: "inactive",
      })),
    );
    Object.assign(control, {
      deleteProject: vi.fn().mockResolvedValue(undefined),
    });
    const store = createDesktopStore(value);
    await store.getState().init();
    await store.getState().refreshRunner();
    expect(control.syncHistory).toHaveBeenCalledWith("shop");
    expect(control.syncHistory).toHaveBeenCalledWith("blog");

    store.getState().selectProject("shop", "settings");
    await store.getState().removeProject("shop");
    expect(store.getState().route).toEqual({ name: "home" });
    expect(store.getState().selectedProjectId).toBe("blog");
  });

  it("saves a project edit to state.json only once the runner accepts it", async () => {
    const { value, control, savedState } = services({
      loadState: () => Promise.resolve(twoProjects),
    });
    const updateProject = vi
      .fn()
      .mockRejectedValueOnce(new Error("Project devCommand cannot contain shell operators"))
      .mockImplementation((id: string, changes: { name: string; devCommand: string }) =>
        Promise.resolve({ id, ...changes, state: "inactive" }),
      );
    Object.assign(control, { updateProject });
    const store = createDesktopStore(value);
    await store.getState().init();

    expect(
      await store.getState().updateProject("shop", { name: "Shop", devCommand: "a && b" }),
    ).toMatch(/shell operators/);
    expect(store.getState().appState.projects[0]).toMatchObject({
      name: "shop",
    });

    expect(
      await store.getState().updateProject("shop", { name: " Shop ", devCommand: "npm start" }),
    ).toBeNull();
    expect(updateProject).toHaveBeenLastCalledWith("shop", {
      name: "Shop",
      devCommand: "npm start",
    });
    expect(savedState()).toMatchObject({
      projects: [{ id: "shop", name: "Shop", devCommand: "npm start" }, { id: "blog" }],
    });
  });

  it("creates a phone link without any project", async () => {
    const { value } = services();
    const store = createDesktopStore(value);
    await store.getState().init();
    store.getState().setLinkPhoneOpen(true);
    await vi.waitFor(() => {
      expect(store.getState().pairing?.code).toBe("ABCD2345");
    });
    expect(store.getState().pairing?.url).toBe("http://127.0.0.1:3000/?pair=ABCD2345");
  });

  it("does not save settings that fail to connect", async () => {
    const { value, channel, saveSettingsMock } = services();
    const store = createDesktopStore(value);
    await store.getState().init();
    channel.connect.mockRejectedValueOnce(new Error("Permission denied"));
    const next = { ...settings, ssh: { ...settings.ssh, user: "s_other" } };
    expect(await store.getState().saveSettings(next)).toBe("connection_failed");
    expect(saveSettingsMock).not.toHaveBeenCalled();
    const invalid = await store.getState().saveSettings({ ...next, projectRoots: ["relative"] });
    expect(
      typeof invalid === "object" && invalid !== null ? invalid.projectRoots : undefined,
    ).toMatch(/absolute/);
  });
});

describe("diff display", () => {
  const file = (
    additions: number,
    lines: number,
    extra: Partial<SyncFileChange> = {},
  ): SyncFileChange => ({
    path: "src/a.ts",
    status: "added",
    binary: false,
    additions,
    deletions: 0,
    hunks:
      lines === 0
        ? []
        : [
            {
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: lines,
              lines: Array.from({ length: lines }, (_, index) => ({
                type: "addition" as const,
                oldLine: null,
                newLine: index + 1,
                content: "x",
              })),
            },
          ],
    ...extra,
  });

  it("shows a complete small diff and holds back a large one, counted from the file", () => {
    expect(diffDisplay(file(104, 104))).toEqual({ kind: "shown" });
    expect(diffDisplay(file(900, 900))).toEqual({
      kind: "large",
      changed: 900,
    });
  });

  it("never shows a diff that arrived cut short or empty as if it were complete", () => {
    expect(diffDisplay(file(6458, 2676))).toEqual({
      kind: "omitted",
      reason: "limit",
    });
    expect(diffDisplay(file(6458, 0))).toEqual({
      kind: "omitted",
      reason: "limit",
    });
    expect(diffDisplay(file(6458, 0, { omitted: "large" }))).toEqual({
      kind: "omitted",
      reason: "large",
    });
  });

  it("has something to say for binary files and files with no line changes", () => {
    expect(diffDisplay(file(0, 0, { binary: true }))).toEqual({
      kind: "binary",
    });
    expect(diffDisplay(file(0, 0, { status: "renamed" }))).toEqual({
      kind: "empty",
    });
  });
});

describe("bundle metadata", () => {
  it("matches the brand package", () => {
    const config = JSON.parse(
      readFileSync(fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url)), "utf8"),
    ) as {
      productName: string;
      app: { windows: { title: string }[] };
      bundle: Record<string, unknown>;
    };
    expect(config.productName).toBe(brand.name);
    expect(config.app.windows[0]?.title).toBe(brand.name);
    expect(config.bundle).toMatchObject({
      publisher: brand.publisher,
      copyright: brand.copyright,
      shortDescription: brand.tagline,
      longDescription: brand.description,
    });
  });
});

describe("opening a conflicting file", () => {
  it("opens only files inside the project that do not run when opened", () => {
    expect(editablePath("/home/me/shop/", "src/app.ts")).toBe("/home/me/shop/src/app.ts");
    expect(editablePath("/home/me/shop", "README")).toBe("/home/me/shop/README");
    expect(editablePath("/home/me/shop", "../secrets.txt")).toBeNull();
    expect(editablePath("/home/me/shop", "/etc/passwd")).toBeNull();
    expect(editablePath("/home/me/shop", "src//app.ts")).toBeNull();
    expect(editablePath("/home/me/shop", "scripts/deploy.sh")).toBeNull();
    expect(editablePath("/home/me/shop", "Launch.DESKTOP")).toBeNull();
    expect(editablePath("/home/me/shop", "setup.exe")).toBeNull();
  });
});
