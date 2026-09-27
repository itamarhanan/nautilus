import type { IncomingMessage } from "node:http";
import type { ModelRef } from "@nautilus/types";
import { commitPattern } from "@nautilus/shadow-git";
import { validateProjectId } from "../config";
import { HttpError } from "../errors";

export type JsonBody = Record<string, unknown>;

const maxBodyBytes = 1_048_576;

export async function readJson(request: IncomingMessage): Promise<JsonBody> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const rawChunk: unknown = chunk;
    const buffer =
      typeof rawChunk === "string" || rawChunk instanceof Uint8Array
        ? Buffer.from(rawChunk)
        : Buffer.from(String(rawChunk));
    size += buffer.length;
    if (size > maxBodyBytes) {
      throw new HttpError(413, "request_too_large", "Request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("body must be an object");
    }
    return parsed as JsonBody;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object");
  }
}

export function bodyString(body: JsonBody, key: string, maxLength: number): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new HttpError(400, "invalid_request", `${key} must be a non-empty string`);
  }
  return value.trim();
}

export function bodyModel(body: JsonBody): ModelRef | undefined {
  const value = body.model;
  if (value === undefined || value === null) {
    return undefined;
  }
  const { providerId, modelId, variant } = (typeof value === "object" ? value : {}) as JsonBody;
  if (
    typeof providerId !== "string" ||
    typeof modelId !== "string" ||
    !providerId ||
    !modelId ||
    providerId.length > 200 ||
    modelId.length > 200
  ) {
    throw new HttpError(400, "invalid_request", "model must name a providerId and a modelId");
  }
  if (variant === undefined || variant === null) return { providerId, modelId };
  if (typeof variant !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(variant)) {
    throw new HttpError(400, "invalid_request", "model variant must be a short name");
  }
  return { providerId, modelId, variant };
}

export function requestAfterSequence(request: IncomingMessage): number {
  const rawHeader = request.headers["last-event-id"];
  const header =
    typeof rawHeader === "string" && rawHeader.length > 0 ? Number(rawHeader) : undefined;
  const rawQuery = new URL(request.url ?? "/", "http://localhost").searchParams.get("after");
  const query = rawQuery === null ? undefined : Number(rawQuery);
  const value = header ?? query;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function requestIdValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new HttpError(400, "invalid_request_id", "requestId is invalid");
  }
  return value;
}

export function requestProjectId(value: unknown): string {
  try {
    return validateProjectId(value);
  } catch {
    throw new HttpError(400, "invalid_project_id", "Project id is invalid");
  }
}

export function checkpointValue(value: unknown): string {
  if (typeof value !== "string" || !commitPattern.test(value)) {
    throw new HttpError(400, "invalid_checkpoint", "commit must be a checkpoint id");
  }
  return value;
}

export function requestGrant(
  value: unknown,
  projectId: string,
  direction: "pull" | "push",
): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new HttpError(400, "invalid_grant", "A sync grant from the PC is required");
  }
  let claims: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value.split(".", 1)[0] ?? "", "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) throw new Error("invalid");
    claims = parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_grant", "Sync grant is malformed");
  }
  if (
    claims.version !== 1 ||
    claims.projectId !== projectId ||
    claims.direction !== direction ||
    typeof claims.expiresAt !== "string" ||
    Date.parse(claims.expiresAt) <= Date.now()
  ) {
    throw new HttpError(400, "invalid_grant", "Sync grant does not match this sync or has expired");
  }
  return value;
}
