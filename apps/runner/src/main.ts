import { chmod, mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createNautilusApp } from "./app";
import { loadProjects, loadServerOptions } from "./config";
import { createNautilusGateway } from "./gateway";
import { Logger, loggerOptionsFromEnv } from "./logger";
import { OpenCodeProcess } from "./opencode";
import { RelayHub } from "./relay";
import { SyncCoordinator, TunnelSyncClient } from "./sync";

// The gateway hands the runner its key and, optionally, OpenCode's provider
// credentials through the environment. Both are taken out of it before
// anything starts, so OpenCode and the dev servers never inherit them.
function takeSecret(name: string): string | undefined {
  const value = process.env[name];
  Reflect.deleteProperty(process.env, name);
  return value || undefined;
}

async function writeOpenCodeAuth(dataDir: string, authJson: string): Promise<void> {
  const directory = join(dataDir, "opencode");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "auth.json");
  await writeFile(path, authJson, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function main(): Promise<void> {
  const options = loadServerOptions();
  const logger = new Logger(undefined, loggerOptionsFromEnv());
  const runnerKey = takeSecret("NAUTILUS_RUNNER_KEY");
  const openCodeAuth = takeSecret("NAUTILUS_OPENCODE_AUTH_JSON");
  if (openCodeAuth) await writeOpenCodeAuth(options.openCodeDataDir, openCodeAuth);
  if (runnerKey !== undefined && runnerKey.length < 32) {
    throw new Error("NAUTILUS_RUNNER_KEY must be at least 32 characters");
  }
  const relay = runnerKey ? new RelayHub(runnerKey, options.syncMaxTotalBytes) : undefined;
  const projects = await loadProjects();
  const sync = new SyncCoordinator({
    projects,
    shadowRoot: options.syncShadowRoot,
    statePath: options.syncStatePath,
    limits: {
      maxFileBytes: options.syncMaxFileBytes,
      maxTotalBytes: options.syncMaxTotalBytes,
      maxFileCount: options.syncMaxFileCount,
    },
    client: new TunnelSyncClient({
      endpoint: relay ? "http://relay.invalid/v1/sync" : options.syncAgentUrl,
      timeoutMs: options.syncRequestTimeoutMs,
      maxBundleBytes: options.syncMaxTotalBytes,
      ...(relay ? { fetch: relay.fetch } : {}),
    }),
  });
  const openCode = new OpenCodeProcess(logger, {
    host: options.openCodeHost,
    port: options.openCodePort,
    dataDir: options.openCodeDataDir,
    startupTimeoutMs: options.openCodeStartupTimeoutMs,
    hiddenPaths: [options.secretsPath],
  });
  const app = await createNautilusApp({
    logger,
    projects,
    openCode,
    sync,
    runnerKey,
    relay,
    version: process.env.NAUTILUS_RUNNER_VERSION,
  });
  if (runnerKey) {
    // In the sandbox the gateway reaches the runner through the sandbox's
    // public domain, so it listens on every interface and is the only server.
    await new Promise<void>((resolve) => app.server.listen(options.port, "0.0.0.0", resolve));
    logger.info("runner_started", { port: options.port });
    await app.lifecycle.recordService("server", "start");
    const stop = async () => {
      await app.lifecycle.recordService("server", "stop");
      await app.close();
      process.exit(0);
    };
    process.once("SIGINT", () => {
      void stop();
    });
    process.once("SIGTERM", () => {
      void stop();
    });
    return;
  }
  await new Promise<void>((resolve) => app.server.listen(options.port, options.host, resolve));
  // A runner hosted by another runner may be moved off its port, so the
  // gateway follows the one it got.
  const { port: apiPort } = app.server.address() as AddressInfo;
  logger.info("server_started", { host: options.host, port: apiPort });
  await new Promise<void>((resolve) =>
    app.controlServer.listen(options.controlPort, options.controlHost, resolve),
  );
  logger.info("control_started", { host: options.controlHost, port: options.controlPort });
  await app.lifecycle.recordService("server", "start");
  const gateway = createNautilusGateway({
    apiTarget: `http://127.0.0.1:${String(apiPort)}`,
    auth: app.auth,
    heartbeatMs: options.sseHeartbeatMs,
    logger,
    previewTokens: app.previewTokens,
    registry: app.registry,
    secureCookies: options.secureCookies,
    webTarget: `http://127.0.0.1:${String(options.webPort)}`,
  });
  await gateway.listen(options.gatewayPort, options.gatewayHost);
  logger.info("gateway_started", { host: options.gatewayHost, port: options.gatewayPort });
  if (options.previewPort !== undefined) {
    await gateway.listenPreview(options.previewPort, options.previewHost);
    logger.info("preview_gateway_started", {
      host: options.previewHost,
      port: options.previewPort,
    });
  }
  await app.lifecycle.recordService("gateway", "start");

  const shutdown = async () => {
    await app.lifecycle.recordService("gateway", "stop");
    await gateway.close();
    await app.lifecycle.recordService("server", "stop");
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error: unknown) => {
  new Logger(undefined, loggerOptionsFromEnv()).error("server_start_failed", {
    error: error instanceof Error ? error.message : "unknown_error",
  });
  process.exitCode = 1;
});
