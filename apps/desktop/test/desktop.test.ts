import { describe, expect, it } from "vitest";
import {
  describeFolder,
  fuzzyMatch,
  inferDevCommand,
  rankFolders,
  scanFolders,
  type DirEntry,
  type FolderIo,
} from "../src/lib/folders";
import {
  detectLightningHost,
  readSettings,
  settingsDocument,
  validateSettings,
  type DesktopSettings,
} from "../src/lib/settings";
import {
  emptyState,
  maxRecentFolders,
  projectIdForFolder,
  readState,
  touchRecent,
  withoutProject,
  withProject,
} from "../src/lib/state";

const settings: DesktopSettings = {
  runnerUrl: "https://8080-studio.cloudspaces.litng.ai",
  ssh: {
    host: "ssh.lightning.ai",
    user: "s_01abc",
    keyPath: "~/.ssh/lightning_rsa",
  },
  projectRoots: ["~/code"],
};

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
