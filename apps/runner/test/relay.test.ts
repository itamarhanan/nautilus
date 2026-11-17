import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RelayPoller } from "../../sync-agent/src/relay";
import { createNautilusApp, type NautilusApp } from "../src/index";
import { Logger } from "../src/logger";
import { RelayHub } from "../src/relay";
import { createRelayToken } from "../src/runner-access";
import { testSecret } from "./helpers";

const runnerKey = "k".repeat(43);
const deviceId = "6f1c2a52-6a4b-4c1e-9d8e-0d3c6c1f2b7a";

async function bind(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function read(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function gatewayRunner(): Promise<{ app: NautilusApp; url: string; relay: RelayHub }> {
  const relay = new RelayHub(runnerKey, 10_000_000, 1_000);
  const app = await createNautilusApp({
    registryPath: ":memory:",
    authSecret: testSecret,
    projects: [],
    logger: new Logger(() => undefined),
    runnerKey,
    relay,
    version: "test-version",
  });
  cleanups.push(() => app.close());
  return { app, url: await bind(app.server), relay };
}

function asGateway(principal: string, key = runnerKey): Record<string, string> {
  return { "x-nautilus-runner-key": key, "x-nautilus-principal": principal };
}

describe("runner behind the gateway", () => {
  it("answers /health without credentials and everything else only with the runner key", async () => {
    const { url } = await gatewayRunner();
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", version: "test-version" });

    const bare = await fetch(`${url}/api/bootstrap`);
    expect(bare.status).toBe(401);
    expect(await bare.json()).toMatchObject({ error: "runner_unauthorized" });

    const wrongKey = await fetch(`${url}/api/bootstrap`, {
      headers: asGateway("admin", "x".repeat(43)),
    });
    expect(wrongKey.status).toBe(401);

    const forged = await fetch(`${url}/api/bootstrap`, {
      headers: asGateway("device:not-a-uuid"),
    });
    expect(forged.status).toBe(401);

    const phone = await fetch(`${url}/api/bootstrap`, { headers: asGateway(`device:${deviceId}`) });
    expect(phone.status).toBe(200);
    expect(await phone.json()).toMatchObject({ projects: [], device: null });

    const phoneAdmin = await fetch(`${url}/api/control/info`, {
      headers: asGateway(`device:${deviceId}`),
    });
    expect(phoneAdmin.status).toBe(404);

    const admin = await fetch(`${url}/api/control/info`, { headers: asGateway("admin") });
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({ version: "test-version" });
  });

  it("refuses relay polls without a valid relay token", async () => {
    const { url } = await gatewayRunner();
    const none = await fetch(`${url}/relay/next`);
    expect(none.status).toBe(401);
    const expired = createRelayToken(runnerKey, Date.now() - 16 * 60 * 1000).token;
    const old = await fetch(`${url}/relay/next`, {
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(old.status).toBe(401);
    const otherKey = createRelayToken("o".repeat(43)).token;
    const forged = await fetch(`${url}/relay/next`, {
      headers: { authorization: `Bearer ${otherKey}` },
    });
    expect(forged.status).toBe(401);
    const tunnel = await fetch(`${url}/api/tunnel-health`, { headers: asGateway("admin") });
    expect(await tunnel.json()).toEqual({ ready: false });
  });

  it("carries sync requests to the PC's agent and back through the relay", async () => {
    const { url, relay } = await gatewayRunner();
    const seen: Array<{ path: string; headers: IncomingMessage["headers"]; body: Buffer }> = [];
    const agent = createServer((request, response) => {
      void read(request).then((body) => {
        seen.push({ path: request.url ?? "", headers: request.headers, body });
        if (request.headers["content-type"] === "application/octet-stream") {
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "x-nautilus-digest": "abc",
          });
          response.end(Buffer.concat([body, Buffer.from([0, 255])]));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ echoed: JSON.parse(body.toString("utf8")) as unknown }));
      });
    });
    const agentUrl = await bind(agent);
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          agent.closeAllConnections();
          agent.close(() => {
            resolve();
          });
        }),
    );
    await expect(relay.fetch("http://relay.invalid/v1/sync", { method: "POST" })).rejects.toThrow(
      /relay_offline/,
    );

    const poller = new RelayPoller(agentUrl);
    cleanups.push(() => {
      poller.stop();
    });
    poller.start({ url, token: createRelayToken(runnerKey).token });
    await expect
      .poll(async () => {
        const tunnel = await fetch(`${url}/api/tunnel-health`, { headers: asGateway("admin") });
        return tunnel.status;
      })
      .toBe(200);

    const json = await relay.fetch("http://relay.invalid/v1/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "state" }),
    });
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual({ echoed: { operation: "state" } });

    const bytes = Buffer.from([1, 2, 3, 250]);
    const binary = await relay.fetch("http://relay.invalid/v1/sync", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-nautilus-request": "meta" },
      body: bytes,
    });
    expect(binary.headers.get("x-nautilus-digest")).toBe("abc");
    expect(Buffer.from(await binary.arrayBuffer())).toEqual(
      Buffer.concat([bytes, Buffer.from([0, 255])]),
    );
    expect(seen[1]?.headers["x-nautilus-request"]).toBe("meta");

    const refused = await relay.fetch("http://relay.invalid/v1/grants", { method: "POST" });
    expect(refused.status).toBe(404);
    expect(seen.map((entry) => entry.path)).toEqual(["/v1/sync", "/v1/sync"]);
  });
});
