import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
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
