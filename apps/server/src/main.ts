import { createNautilusApp } from "./app";
import { loadProjects, loadServerOptions } from "./config";
import { createNautilusGateway } from "./gateway";
import { Logger, loggerOptionsFromEnv } from "./logger";
import { OpenCodeProcess } from "./opencode";
import { SyncCoordinator, TunnelSyncClient } from "./sync";

async function main(): Promise<void> {
  const options = loadServerOptions();
  const logger = new Logger(undefined, loggerOptionsFromEnv());
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
      endpoint: options.syncAgentUrl,
      timeoutMs: options.syncRequestTimeoutMs,
      maxBundleBytes: options.syncMaxTotalBytes,
    }),
  });
  const openCode = new OpenCodeProcess(logger, {
    host: options.openCodeHost,
    port: options.openCodePort,
    dataDir: options.openCodeDataDir,
    startupTimeoutMs: options.openCodeStartupTimeoutMs,
  });
  const app = await createNautilusApp({ logger, projects, openCode, sync });
  await new Promise<void>((resolve) => app.server.listen(options.port, options.host, resolve));
  logger.info("server_started", { host: options.host, port: options.port });
  await new Promise<void>((resolve) =>
    app.controlServer.listen(options.controlPort, options.controlHost, resolve),
  );
  logger.info("control_started", { host: options.controlHost, port: options.controlPort });
  await app.lifecycle.recordService("server", "start");
  const gateway = createNautilusGateway({
    apiTarget: `http://127.0.0.1:${String(options.port)}`,
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
