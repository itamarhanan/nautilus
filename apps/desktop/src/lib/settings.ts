export type DesktopSettings = {
  // The Nautilus web app on Vercel. It serves the phone and is the gateway
  // the desktop talks to.
  runnerUrl: string;
  // NAUTILUS_ADMIN_TOKEN from the deployment. It opens the admin routes, so
  // the settings file is written readable by this user only.
  adminToken: string;
  projectRoots: string[];
};

const defaultSettings: DesktopSettings = {
  runnerUrl: "",
  adminToken: "",
  projectRoots: ["~"],
};

export type SettingsErrors = Partial<Record<"runnerUrl" | "adminToken" | "projectRoots", string>>;

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
  const roots = Array.isArray(input.projectRoots)
    ? input.projectRoots.map(text).filter(Boolean)
    : [];
  return {
    runnerUrl: text(input.gatewayUrl ?? input.runnerUrl ?? input.runner_url),
    adminToken: text(input.adminToken ?? input.admin_token),
    projectRoots: roots.length > 0 ? roots : defaultSettings.projectRoots,
  };
}

export function validateSettings(settings: DesktopSettings): SettingsErrors {
  const errors: SettingsErrors = {};
  try {
    const url = new URL(settings.runnerUrl);
    const secure =
      url.protocol === "https:" || (url.protocol === "http:" && loopback.has(url.hostname));
    if (!secure || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      errors.runnerUrl = "Use the app's https:// address, with no path";
    }
  } catch {
    errors.runnerUrl = "Enter the address of your Nautilus deployment";
  }
  if (!/^[\x21-\x7e]{32,512}$/.test(settings.adminToken)) {
    errors.adminToken = "Paste the deployment's NAUTILUS_ADMIN_TOKEN (32 characters or more)";
  }
  if (settings.projectRoots.length === 0 || !settings.projectRoots.every(isHomePath)) {
    errors.projectRoots = "Each folder must be absolute or start with ~";
  }
  return errors;
}

export function settingsComplete(settings: DesktopSettings): boolean {
  return Object.keys(validateSettings(settings)).length === 0;
}

function normalizeUrl(value: string): string {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return value.trim();
  }
}

export function settingsDocument(settings: DesktopSettings): Record<string, unknown> {
  return {
    gatewayUrl: normalizeUrl(settings.runnerUrl),
    adminToken: settings.adminToken,
    projectRoots: [...settings.projectRoots],
  };
}
