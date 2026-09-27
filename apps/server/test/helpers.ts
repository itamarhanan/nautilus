import type { Server } from "node:http";
import type { NautilusApp } from "../src/index";

export const testSecret = "s".repeat(32);

async function bind(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }
  return address.port;
}

export type Ports = { port: number; controlPort: number };

export async function listen(app: NautilusApp): Promise<Ports> {
  return {
    port: await bind(app.server),
    controlPort: await bind(app.controlServer),
  };
}

export type RequestOptions = {
  control?: boolean;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

export const controlHeaders = { "x-nautilus-control": "1" } as const;

export async function request(
  ports: Ports,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<{
  status: number;
  body: Record<string, unknown>;
  setCookie: string | null;
}> {
  const port = options.control ? ports.controlPort : ports.port;
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method,
    headers: {
      ...(options.control ? controlHeaders : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? null : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    setCookie: response.headers.get("set-cookie"),
  };
}

export async function pairDevice(
  ports: Ports,
  deviceName = "Test phone",
): Promise<{
  cookie: string;
  deviceId: string;
}> {
  const pairing = await request(ports, "POST", "/api/pairing-codes", {
    control: true,
    body: { deviceName },
  });
  if (pairing.status !== 201) throw new Error(`pairing failed with ${String(pairing.status)}`);
  const redeemed = await request(ports, "POST", "/api/pairing-codes/redeem", {
    body: { code: pairing.body.code, deviceName },
  });
  if (!redeemed.setCookie) throw new Error("Pairing did not issue a session cookie");
  return {
    cookie: redeemed.setCookie.split(";", 1)[0] ?? "",
    deviceId: (redeemed.body.device as { id: string }).id,
  };
}
