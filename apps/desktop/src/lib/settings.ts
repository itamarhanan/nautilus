export type DesktopSettings = {
  runnerUrl: string;
  ssh: {
    host: string;
    user: string;
    keyPath: string;
  };
  projectRoots: string[];
};

const defaultSettings: DesktopSettings = {
  runnerUrl: "",
  ssh: { host: "ssh.lightning.ai", user: "", keyPath: "~/.ssh/lightning_rsa" },
  projectRoots: ["~"],
};

export type SettingsErrors = Partial<
  Record<"runnerUrl" | "sshHost" | "sshUser" | "keyPath" | "projectRoots", string>
>;

const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isHomePath(path: string): boolean {
  return (
    (path === "~" || path.startsWith("~/") || path.startsWith("/")) &&
    !path.includes("\0") &&
    !path.includes("\n") &&
    !path.includes("\r")
  );
}

export function readSettings(value: unknown): DesktopSettings {
  const input =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const ssh =
    typeof input.ssh === "object" && input.ssh !== null
      ? (input.ssh as Record<string, unknown>)
      : {};
  const roots = Array.isArray(input.projectRoots)
    ? input.projectRoots.map(text).filter(Boolean)
    : [];
  return {
    runnerUrl: text(input.runnerUrl ?? input.runner_url),
    ssh: {
      host: text(ssh.host ?? input.sshHost ?? input.ssh_host) || defaultSettings.ssh.host,
      user: text(ssh.user ?? input.sshUser ?? input.ssh_user),
      keyPath:
        text(ssh.keyPath ?? input.sshKeyPath ?? input.ssh_key_path) || defaultSettings.ssh.keyPath,
    },
    projectRoots: roots.length > 0 ? roots : defaultSettings.projectRoots,
  };
}

export function validateSettings(settings: DesktopSettings, localMode = false): SettingsErrors {
  const errors: SettingsErrors = {};
  if (!localMode) {
    try {
      const url = new URL(settings.runnerUrl);
      const secure =
        url.protocol === "https:" || (url.protocol === "http:" && loopback.has(url.hostname));
      if (
        !secure ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        errors.runnerUrl = "Use the runner's https:// origin, with no path";
      }
    } catch {
      errors.runnerUrl = "Enter the runner's public URL";
    }
    if (!/^[A-Za-z0-9._-]+$/.test(settings.ssh.host)) errors.sshHost = "Enter a host name";
    if (!/^[A-Za-z0-9._-]+$/.test(settings.ssh.user)) {
      errors.sshUser = "Enter the Studio SSH user, like s_01abc…";
    }
    if (!isHomePath(settings.ssh.keyPath) || settings.ssh.keyPath.length > 4096) {
      errors.keyPath = "Use an absolute path or one starting with ~/";
    }
  }
  if (settings.projectRoots.length === 0 || !settings.projectRoots.every(isHomePath)) {
    errors.projectRoots = "Each folder must be absolute or start with ~";
  }
  return errors;
}

export function settingsComplete(settings: DesktopSettings, localMode = false): boolean {
  return Object.keys(validateSettings(settings, localMode)).length === 0;
}

function normalizeRunnerUrl(value: string): string {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return value.trim();
  }
}

export function settingsDocument(settings: DesktopSettings): DesktopSettings {
  return {
    runnerUrl: normalizeRunnerUrl(settings.runnerUrl),
    ssh: { ...settings.ssh },
    projectRoots: [...settings.projectRoots],
  };
}

export function detectLightningHost(sshConfig: string): { host: string; user: string } | undefined {
  let current: { host?: string; user?: string } | undefined;
  const blocks: Array<{ host?: string; user?: string }> = [];
  for (const rawLine of sshConfig.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [keyword = "", ...rest] = line.split(/\s+|=/).filter(Boolean);
    const value = rest.join(" ");
    if (keyword.toLowerCase() === "host") {
      current = {};
      blocks.push(current);
    } else if (current && keyword.toLowerCase() === "hostname") {
      current.host = value;
    } else if (current && keyword.toLowerCase() === "user") {
      current.user = value;
    }
  }
  const match = blocks.find(
    (block) =>
      block.host === "ssh.lightning.ai" && block.user && /^s_[A-Za-z0-9]+$/.test(block.user),
  );
  return match?.host && match.user ? { host: match.host, user: match.user } : undefined;
}
