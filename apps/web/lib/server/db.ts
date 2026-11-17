import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { databaseUrl } from "./config";

// Applied once per function instance. Every statement is idempotent, so two
// instances starting together cannot break each other.
const schema = [
  `CREATE TABLE IF NOT EXISTS nautilus_devices (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz,
    revoked_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS nautilus_pairing_codes (
    id uuid PRIMARY KEY,
    code_hash text NOT NULL UNIQUE,
    device_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    device_id uuid REFERENCES nautilus_devices (id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS nautilus_rate_limits (
    key text PRIMARY KEY,
    count integer NOT NULL,
    reset_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS nautilus_runner_lease (
    name text PRIMARY KEY,
    holder text NOT NULL,
    expires_at timestamptz NOT NULL
  )`,
];

let client: NeonQueryFunction<false, false> | undefined;
let ready: Promise<void> | undefined;

export async function sql(): Promise<NeonQueryFunction<false, false>> {
  client ??= neon(databaseUrl());
  const query = client;
  ready ??= (async () => {
    for (const statement of schema) await query.query(statement);
  })().catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  await ready;
  return query;
}
