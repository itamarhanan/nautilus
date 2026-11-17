import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DeviceResponse, PairingCodeResponse } from "@nautilus/types";
import { sql } from "./db";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type DeviceRow = {
  id: string;
  name: string;
  created_at: string | Date;
  last_seen_at: string | Date | null;
  revoked_at: string | Date | null;
};

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function device(row: DeviceRow): DeviceResponse {
  return {
    id: row.id,
    name: row.name,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    lastSeenAt: iso(row.last_seen_at),
    revokedAt: iso(row.revoked_at),
  };
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

// Codes are read aloud and typed on a phone, so case, spaces and dashes are
// forgiven.
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]+/g, "");
}

function generateCode(): string {
  return Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join("");
}

export async function createPairingCode(
  deviceName: string,
  ttlSeconds: number,
): Promise<PairingCodeResponse> {
  const query = await sql();
  const id = randomUUID();
  const code = generateCode();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await query.query(
    "DELETE FROM nautilus_pairing_codes WHERE expires_at < now() - interval '1 day'",
  );
  await query.query(
    "INSERT INTO nautilus_pairing_codes (id, code_hash, device_name, expires_at) VALUES ($1, $2, $3, $4)",
    [id, hashCode(code), deviceName, expiresAt],
  );
  return { id, code, expiresAt };
}

// One statement, so a code can be used once even when two phones race for it.
export async function redeemPairingCode(
  code: string,
  deviceName: string,
): Promise<DeviceResponse | undefined> {
  const query = await sql();
  const rows = (await query.query(
    `WITH pairing AS (
       UPDATE nautilus_pairing_codes SET used_at = now(), device_id = $2
       WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING id
     )
     INSERT INTO nautilus_devices (id, name, last_seen_at)
     SELECT $2, $3, now() FROM pairing
     RETURNING id, name, created_at, last_seen_at, revoked_at`,
    [hashCode(normalizeCode(code)), randomUUID(), deviceName],
  )) as DeviceRow[];
  const row = rows[0];
  return row ? device(row) : undefined;
}

export async function listDevices(): Promise<DeviceResponse[]> {
  const query = await sql();
  const rows = (await query.query(
    "SELECT id, name, created_at, last_seen_at, revoked_at FROM nautilus_devices ORDER BY created_at DESC",
  )) as DeviceRow[];
  return rows.map(device);
}

export async function findDevice(id: string): Promise<DeviceResponse | undefined> {
  const query = await sql();
  const rows = (await query.query(
    "SELECT id, name, created_at, last_seen_at, revoked_at FROM nautilus_devices WHERE id = $1",
    [id],
  )) as DeviceRow[];
  const row = rows[0];
  return row ? device(row) : undefined;
}

// Marks a phone as seen at most every few minutes, so polling does not write
// on every request.
export async function touchDevice(id: string): Promise<void> {
  const query = await sql();
  await query.query(
    `UPDATE nautilus_devices SET last_seen_at = now()
     WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')`,
    [id],
  );
}

export async function revokeDevice(id: string): Promise<boolean> {
  const query = await sql();
  const rows = await query.query(
    "UPDATE nautilus_devices SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id",
    [id],
  );
  return rows.length > 0;
}

// A fixed window per key, kept in Postgres because function instances share
// no memory.
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const query = await sql();
  const rows = (await query.query(
    `INSERT INTO nautilus_rate_limits (key, count, reset_at)
     VALUES ($1, 1, now() + make_interval(secs => $2))
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN nautilus_rate_limits.reset_at <= now() THEN 1
                    ELSE nautilus_rate_limits.count + 1 END,
       reset_at = CASE WHEN nautilus_rate_limits.reset_at <= now() THEN EXCLUDED.reset_at
                       ELSE nautilus_rate_limits.reset_at END
     RETURNING count`,
    [key, windowSeconds],
  )) as { count: number }[];
  return (rows[0]?.count ?? limit + 1) <= limit;
}

export const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
