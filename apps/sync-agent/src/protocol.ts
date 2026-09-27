import type { SyncRequest } from "@nautilus/types";

export type { SyncRequest } from "@nautilus/types";

const operations = new Set([
  "health",
  "state",
  "preview",
  "create_bundle",
  "import_bundle",
  "preflight",
  "apply",
  "history",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHead(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value));
}

export function validateSyncRequest(value: unknown): SyncRequest {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("invalid_protocol_version");
  }
  if (
    typeof value.requestId !== "string" ||
    value.requestId.length < 8 ||
    value.requestId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value.requestId)
  ) {
    throw new Error("invalid_request_id");
  }
  if (typeof value.operation !== "string" || !operations.has(value.operation)) {
    throw new Error("invalid_operation");
  }
  if (typeof value.projectId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.projectId)) {
    throw new Error("invalid_project_id");
  }
  if (
    typeof value.grant !== "string" ||
    value.grant.length < 16 ||
    value.grant.length > 4096 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.grant)
  ) {
    throw new Error("invalid_grant");
  }
  if (typeof value.issuedAt !== "string" || typeof value.expiresAt !== "string") {
    throw new Error("invalid_request_timestamps");
  }
  if (
    typeof value.nonce !== "string" ||
    value.nonce.length < 16 ||
    value.nonce.length > 256 ||
    !/^[A-Za-z0-9._:-]+$/.test(value.nonce)
  ) {
    throw new Error("invalid_nonce");
  }
  if (
    !isHead(value.baseHead) ||
    !isHead(value.expectedLocalHead) ||
    !isHead(value.expectedRemoteHead)
  ) {
    throw new Error("invalid_expected_head");
  }
  if (!isRecord(value.payload)) {
    throw new Error("invalid_payload");
  }
  return value as unknown as SyncRequest;
}
