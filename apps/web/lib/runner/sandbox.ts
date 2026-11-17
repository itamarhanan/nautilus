import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { localRunnerUrl, openCodeAuthJson, runnerKey } from "../server/config";
import { sql } from "../server/db";
import { GatewayError, logEvent } from "../server/http";
import { runnerBundle } from "./bundle";

// The runner lives in one named, persistent sandbox. A session ends after at
// most 45 minutes on the Hobby plan; the filesystem survives as a snapshot and
// the processes do not, so every wake checks the runner and starts it again
// when it is gone or out of date.

const SANDBOX_NAME = "nautilus-runner";
const PORT = 4000;
const DIRECTORY = "/vercel/sandbox/nautilus-runner";
const SESSION_MS = 45 * 60 * 1000;
const HEALTHY_FOR_MS = 20_000;
const LEASE_SECONDS = 120;

type Health = { version?: unknown; lifecycle?: { state?: unknown } };

let lastHealthy: { url: string; at: number } | undefined;
let waking: Promise<string> | undefined;

async function health(url: string, timeoutMs = 3_000): Promise<Health | undefined> {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    return response.ok ? ((await response.json()) as Health) : undefined;
  } catch {
    return undefined;
  }
}

function serving(found: Health | undefined, version: string): boolean {
  const state = found?.lifecycle?.state;
  return found?.version === version && (state === "ready" || state === "degraded");
}

async function sandbox(): Promise<Sandbox> {
  return Sandbox.getOrCreate({
    name: SANDBOX_NAME,
    persistent: true,
    ports: [PORT],
    image: "vercel/sandbox/node:24",
    timeout: SESSION_MS,
    resources: { vcpus: 2 },
  });
}

// Only one function at a time starts the runner; the others wait for it.
async function takeLease(holder: string): Promise<boolean> {
  const query = await sql();
  const rows = await query.query(
    `INSERT INTO nautilus_runner_lease (name, holder, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
     WHERE nautilus_runner_lease.expires_at < now()
     RETURNING holder`,
    [SANDBOX_NAME, holder, LEASE_SECONDS],
  );
  return rows.length > 0;
}

async function dropLease(holder: string): Promise<void> {
  const query = await sql();
  await query.query("DELETE FROM nautilus_runner_lease WHERE name = $1 AND holder = $2", [
    SANDBOX_NAME,
    holder,
  ]);
}

async function output(box: Sandbox, command: string, args: string[]): Promise<string> {
  const finished = await box.runCommand(command, args);
  return (await finished.stdout()).trim();
}

async function start(box: Sandbox): Promise<void> {
  const bundle = await runnerBundle();
  // Resumes the sandbox when its session has ended.
  const installed = await output(box, "sh", [
    "-c",
    `cat ${DIRECTORY}/.version ${DIRECTORY}/.packages 2>/dev/null || true`,
  ]);
  const [installedVersion, installedPackages] = installed.split("\n");
  if (installedVersion !== bundle.version) {
    await box.runCommand("mkdir", ["-p", `${DIRECTORY}/dist`]);
    await box.writeFiles(
      bundle.files.map((entry) => ({
        path: `${DIRECTORY}/${entry.path}`,
        content: entry.content,
      })),
    );
  }
  if (installedPackages !== bundle.packageHash) {
    const install = await box.runCommand({
      cmd: "npm",
      args: ["install", "--omit=dev", "--no-audit", "--no-fund"],
      cwd: DIRECTORY,
    });
    if (install.exitCode !== 0) {
      throw new Error(`npm install failed: ${(await install.stderr()).slice(-500)}`);
    }
  }
  await box.writeFiles([
    {
      path: `${DIRECTORY}/.version`,
      content: Buffer.from(`${bundle.version}\n${bundle.packageHash}\n`),
    },
  ]);
  await box.runCommand("sh", ["-c", "pkill -f 'nautilus-runner/dist/main.js' || true"]);
  const authJson = openCodeAuthJson();
  await box.runCommand({
    cmd: "node",
    args: ["--enable-source-maps", `${DIRECTORY}/dist/main.js`],
    cwd: DIRECTORY,
    detached: true,
    env: {
      NODE_ENV: "production",
      NAUTILUS_PORT: String(PORT),
      NAUTILUS_RUNNER_KEY: runnerKey(),
      NAUTILUS_RUNNER_VERSION: bundle.version,
      NAUTILUS_SECURE_COOKIES: "true",
      ...(authJson ? { NAUTILUS_OPENCODE_AUTH_JSON: authJson } : {}),
    },
  });
}

async function waitForVersion(url: string, version: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (serving(await health(url), version)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

async function wake(): Promise<string> {
  const bundle = await runnerBundle();
  const box = await sandbox();
  const url = box.domain(PORT).replace(/\/+$/, "");
  if (serving(await health(url), bundle.version)) return url;
  const holder = randomUUID();
  if (!(await takeLease(holder))) {
    if (await waitForVersion(url, bundle.version, Date.now() + 90_000)) return url;
    throw new GatewayError(503, "runner_starting", "The runner is starting. Try again shortly.");
  }
  try {
    logEvent("runner_starting", { version: bundle.version });
    await start(box);
    if (!(await waitForVersion(url, bundle.version, Date.now() + 90_000))) {
      throw new GatewayError(503, "runner_starting", "The runner is starting. Try again shortly.");
    }
    logEvent("runner_ready", { version: bundle.version });
    return url;
  } finally {
    await dropLease(holder).catch(() => undefined);
  }
}

// The runner's base URL, starting the runner first when it is not serving.
export async function ensureRunner(): Promise<string> {
  const local = localRunnerUrl();
  if (local) return local;
  if (lastHealthy && Date.now() - lastHealthy.at < HEALTHY_FOR_MS) return lastHealthy.url;
  waking ??= wake()
    .then((url) => {
      lastHealthy = { url, at: Date.now() };
      return url;
    })
    .finally(() => {
      waking = undefined;
    });
  return waking;
}

// Answers without starting anything: whether the runner serves right now.
export async function runnerIfReady(): Promise<string | undefined> {
  const local = localRunnerUrl();
  if (local) return local;
  if (lastHealthy && Date.now() - lastHealthy.at < HEALTHY_FOR_MS) return lastHealthy.url;
  const [bundle, box] = await Promise.all([runnerBundle(), sandbox()]);
  const url = box.domain(PORT).replace(/\/+$/, "");
  if (!serving(await health(url, 2_000), bundle.version)) return undefined;
  lastHealthy = { url, at: Date.now() };
  return url;
}

export function forgetRunner(): void {
  lastHealthy = undefined;
}
