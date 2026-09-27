import { describe, expect, it } from "vitest";
import {
  detectLightningHost,
  readSettings,
  settingsDocument,
  validateSettings,
  type DesktopSettings,
} from "../src/lib/settings";

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
