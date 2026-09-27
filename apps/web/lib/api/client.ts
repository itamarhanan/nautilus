export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function responseError(response: Response, fallback: string): Promise<ApiError> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
  };
  return new ApiError(
    body.message ?? `${fallback} (${String(response.status)})`,
    response.status,
    body.error,
  );
}

type ApiInit = RequestInit & {
  acceptStatuses?: readonly number[];
};

export async function apiRequest<T>(
  path: string,
  { acceptStatuses = [], ...init }: ApiInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (init.method && init.method !== "GET") {
    headers.set("x-nautilus-request", "1");
  }
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "include",
    headers,
  });
  if (!response.ok && !acceptStatuses.includes(response.status)) {
    throw await responseError(response, "Request failed");
  }
  if (response.status === 204) return undefined as T;
  return (await response.json().catch(() => ({}))) as T;
}

export function apiPost<T>(path: string, body: unknown = {}, init: ApiInit = {}): Promise<T> {
  return apiRequest<T>(path, {
    ...init,
    method: "POST",
    body: JSON.stringify(body),
  });
}
