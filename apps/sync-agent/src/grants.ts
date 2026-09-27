import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  SyncDirection,
  SyncGrant,
  SyncGrantResponse,
  SyncOperation,
  SyncRequest,
} from "@nautilus/types";

export const maxGrantLifetimeMs = 10 * 60 * 1000;

const allowedOperations: Record<SyncDirection, ReadonlySet<SyncOperation>> = {
  pull: new Set(["state", "preview", "import_bundle", "preflight", "apply", "history"]),
  push: new Set(["state", "preview", "create_bundle", "history"]),
};

export class GrantError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GrantError";
  }
}

export class GrantAuthority {
  private readonly revoked = new Set<string>();

  constructor(
    private readonly key: Buffer,
    private readonly now: () => number = Date.now,
  ) {
    if (key.length < 32) throw new Error("grant key must be at least 32 bytes");
  }

  static random(): GrantAuthority {
    return new GrantAuthority(randomBytes(32));
  }

  matchesLaunchKey(candidate: string): boolean {
    const actual = Buffer.from(candidate, "utf8");
    return actual.length === this.key.length && timingSafeEqual(actual, this.key);
  }

  mint(
    projectId: string,
    direction: SyncDirection,
    lifetimeMs = maxGrantLifetimeMs,
  ): SyncGrantResponse {
    const issued = this.now();
    const claims: SyncGrant = {
      version: 1,
      grantId: randomUUID(),
      projectId,
      direction,
      issuedAt: new Date(issued).toISOString(),
      expiresAt: new Date(
        issued + Math.min(Math.max(lifetimeMs, 1_000), maxGrantLifetimeMs),
      ).toISOString(),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return { grant: `${payload}.${this.sign(payload)}`, claims };
  }

  revoke(grantId: string): void {
    this.revoked.add(grantId);
  }

  verify(grant: string, projectId: string, operation: SyncOperation): SyncGrant {
    const parts = grant.split(".");
    const [payload, signature] = parts;
    if (parts.length !== 2 || !payload || !signature) {
      throw new GrantError("grant_invalid", "Sync grant is malformed");
    }
    const expected = Buffer.from(this.sign(payload), "base64url");
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new GrantError("grant_invalid", "Sync grant was not issued by this PC");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw new GrantError("grant_invalid", "Sync grant is malformed");
    }
    const claims = parsed as Partial<Record<keyof SyncGrant, unknown>> | null;
    if (
      claims === null ||
      typeof claims !== "object" ||
      claims.version !== 1 ||
      typeof claims.grantId !== "string" ||
      typeof claims.expiresAt !== "string"
    ) {
      throw new GrantError("grant_invalid", "Sync grant is malformed");
    }
    if (claims.projectId !== projectId) {
      throw new GrantError("grant_wrong_project", "Sync grant is for another project");
    }
    if (
      (claims.direction !== "pull" && claims.direction !== "push") ||
      !allowedOperations[claims.direction].has(operation)
    ) {
      throw new GrantError("grant_wrong_direction", `Sync grant does not allow ${operation}`);
    }
    if (Date.parse(claims.expiresAt) <= this.now()) {
      throw new GrantError("grant_expired", "Sync grant has expired");
    }
    if (this.revoked.has(claims.grantId)) {
      throw new GrantError("grant_revoked", "Sync grant was revoked");
    }
    return claims as SyncGrant;
  }

  authenticate = (request: SyncRequest): void => {
    this.verify(request.grant, request.projectId, request.operation);
  };

  private sign(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest("base64url");
  }
}
