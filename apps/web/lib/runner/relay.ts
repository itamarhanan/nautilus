import { createHmac } from "node:crypto";

// Opens only the runner's relay routes, for fifteen minutes. The runner checks
// it with the same key, so the gateway and the runner never exchange it.
export function relayToken(
  runnerKey: string,
  now = Date.now(),
): { token: string; expiresAt: string } {
  const expiresAtMs = now + 15 * 60 * 1000;
  const signature = createHmac("sha256", runnerKey)
    .update(`relay.${String(expiresAtMs)}`)
    .digest("base64url");
  return {
    token: `${String(expiresAtMs)}.${signature}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}
