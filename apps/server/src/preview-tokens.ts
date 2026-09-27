import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PreviewTokenResponse, ProjectConfig, ProjectId } from "@nautilus/types";

type PreviewTokenPayload = {
  projectId: ProjectId;
  expiresAt: number;
  tokenId: string;
};

export type RedeemedPreview = {
  projectId: ProjectId;
  sessionToken: string;
  expiresAt: string;
};

function digest(value: string): string {
  return createHmac("sha256", "nautilus-preview-token-id").update(value).digest("hex");
}

function sign(value: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(value).digest();
}

function signaturesMatch(actual: Buffer, expected: Buffer): boolean {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parsePayload(value: string): PreviewTokenPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const payload = parsed as Record<string, unknown>;
    if (
      typeof payload.projectId !== "string" ||
      typeof payload.expiresAt !== "number" ||
      !Number.isSafeInteger(payload.expiresAt) ||
      typeof payload.tokenId !== "string"
    ) {
      return undefined;
    }
    return {
      projectId: payload.projectId,
      expiresAt: payload.expiresAt,
      tokenId: payload.tokenId,
    };
  } catch {
    return undefined;
  }
}

export class PreviewTokens {
  constructor(
    private readonly secret: string,
    private readonly onIssue: (
      tokenIdHash: string,
      projectId: ProjectId,
      expiresAt: string,
    ) => void,
    private readonly onRedeem: (
      tokenIdHash: string,
      sessionTokenHash: string,
      projectId: ProjectId,
      expiresAt: string,
    ) => boolean,
    private readonly onFindSession: (sessionTokenHash: string) => ProjectId | undefined,
    private readonly sessionTtlSeconds = 3600,
  ) {
    if (secret.length < 32) {
      throw new Error("Preview token secret must be at least 32 characters");
    }
    if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds < 60) {
      throw new Error("Preview session TTL must be an integer of at least 60 seconds");
    }
  }

  issue(project: ProjectConfig, ttlSeconds = 120): PreviewTokenResponse {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 300) {
      throw new Error("Preview token TTL must be between 30 and 300 seconds");
    }
    const payload: PreviewTokenPayload = {
      projectId: project.id,
      expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
      tokenId: randomUUID(),
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = sign(encodedPayload, this.secret).toString("base64url");
    const expiresAt = new Date(payload.expiresAt * 1000).toISOString();
    this.onIssue(digest(payload.tokenId), project.id, expiresAt);
    return {
      token: `${encodedPayload}.${signature}`,
      projectId: project.id,
      previewPath: project.previewPath,
      expiresAt,
    };
  }

  verify(token: string): ProjectId | undefined {
    return this.parseValid(token)?.projectId;
  }

  redeem(token: string): RedeemedPreview | undefined {
    const payload = this.parseValid(token);
    if (!payload) {
      return undefined;
    }
    const now = Math.floor(Date.now() / 1000);
    const sessionToken = randomBytes(32).toString("base64url");

    const expiresAt = new Date((now + this.sessionTtlSeconds) * 1000).toISOString();
    const redeemed = this.onRedeem(
      digest(payload.tokenId),
      digest(sessionToken),
      payload.projectId,
      expiresAt,
    );
    return redeemed ? { projectId: payload.projectId, sessionToken, expiresAt } : undefined;
  }

  findSession(token: string): ProjectId | undefined {
    return this.onFindSession(digest(token));
  }

  private parseValid(token: string): PreviewTokenPayload | undefined {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return undefined;
    }
    const [encodedPayload, encodedSignature] = parts;
    let actualSignature: Buffer;
    try {
      actualSignature = Buffer.from(encodedSignature, "base64url");
    } catch {
      return undefined;
    }
    if (!signaturesMatch(actualSignature, sign(encodedPayload, this.secret))) {
      return undefined;
    }
    const payload = parsePayload(encodedPayload);
    const now = Math.floor(Date.now() / 1000);
    if (!payload || payload.expiresAt <= now) {
      return undefined;
    }
    return payload;
  }
}
