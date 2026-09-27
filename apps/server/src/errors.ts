import { SyncCoordinatorError, SyncOfflineError } from "./sync";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const sessionErrorStatus = {
  session_not_found: 404,
  session_busy: 409,
  session_not_retryable: 409,
  session_prompt_not_found: 409,
  project_not_configured: 400,
  permission_not_found: 404,
  checkpoint_not_found: 404,
  checkpoints_unavailable: 503,
} as const;

export type SessionErrorCode = keyof typeof sessionErrorStatus;

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }

  get statusCode(): number {
    return sessionErrorStatus[this.code];
  }
}

export function toHttpError(error: unknown): HttpError | undefined {
  if (error instanceof HttpError) return error;
  if (error instanceof SessionError)
    return new HttpError(error.statusCode, error.code, error.message);
  if (error instanceof SyncOfflineError) return new HttpError(503, error.code, error.message);
  if (error instanceof SyncCoordinatorError) {
    const status = error.status === "conflict" || error.status === "stale" ? 409 : 400;
    return new HttpError(status, error.code, error.message);
  }
  return undefined;
}
