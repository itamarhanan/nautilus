import { createHmac } from "node:crypto";

// Everything the gateway reads from its environment, checked once per use so
// a missing variable answers with a clear error instead of a crash at import.

export class ConfigError extends Error {}

function required(name: string, minLength = 1): string {
  const value = process.env[name];
  if (!value || value.length < minLength) {
    throw new ConfigError(
      minLength > 1
        ? `${name} must be set to at least ${String(minLength)} characters`
        : `${name} must be set`,
    );
  }
  return value;
}

export function authSecret(): string {
  return required("NAUTILUS_AUTH_SECRET", 32);
}

export function adminToken(): string {
  return required("NAUTILUS_ADMIN_TOKEN", 32);
}

export function databaseUrl(): string {
  const value = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!value) throw new ConfigError("DATABASE_URL must be set");
  return value;
}

export function secureCookies(): boolean {
  return process.env.NAUTILUS_SECURE_COOKIES !== "false";
}

// The runner trusts the principal header only next to this key. It is derived
// from the auth secret so there is one secret to manage, and can be set
// directly for a runner started by hand during development.
export function runnerKey(): string {
  const explicit = process.env.NAUTILUS_RUNNER_KEY;
  if (explicit) return explicit;
  return createHmac("sha256", authSecret()).update("nautilus-runner-key").digest("base64url");
}

// Development only: a runner already listening here is used as it is, and no
// sandbox is created.
export function localRunnerUrl(): string | undefined {
  const value = process.env.NAUTILUS_RUNNER_URL;
  return value ? value.replace(/\/+$/, "") : undefined;
}

export function openCodeAuthJson(): string | undefined {
  return process.env.NAUTILUS_OPENCODE_AUTH_JSON || undefined;
}
