import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type {
  DeviceResponse,
  LocalSyncStatusResponse,
  PairingCodeResponse,
  ProjectEnvironment,
  ProjectEnvironmentUpdate,
  ProjectRecord,
  RecoverySummary,
  SyncConflict,
  SyncDirection,
  SyncEvent,
  SyncFileChange,
  SyncGrantResponse,
  SyncResolutions,
  SyncResponse,
  SyncStatusResponse,
} from "@nautilus/types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly conflicts: SyncConflict[] = [],
    readonly syncResponse?: SyncResponse,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;

  timeoutMessage?: string;
};

type SyncOptions = RequestOptions & {
  grant: string;
  requestId?: string;

  resolutions?: SyncResolutions;
};

export type RunnerInfo = {
  service: string;
  version: string;
  lifecycle: RecoverySummary;
  activeProject: ProjectRecord | null;
};

export type NewProject = {
  projectId: string;
  name: string;
  devCommand: string;
};

function isSyncResponse(value: unknown): value is SyncResponse {
  if (typeof value !== "object" || value === null) return false;
  const object = value as Record<string, unknown>;
  return (
    object.version === 1 &&
    typeof object.status === "string" &&
    typeof object.requestId === "string"
  );
}

function conflictList(value: unknown): SyncConflict[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is SyncConflict =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>).path === "string" &&
          typeof (item as Record<string, unknown>).reason === "string",
      )
    : [];
}

function errorFrom(status: number, value: unknown): ApiError {
  const object =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const syncResponse = isSyncResponse(value) ? value : undefined;
  const nested =
    typeof object.error === "object" && object.error !== null
      ? (object.error as Record<string, unknown>)
      : undefined;
  const code =
    typeof object.error === "string"
      ? object.error
      : typeof nested?.code === "string"
        ? nested.code
        : (syncResponse?.status ?? "request_failed");
  const message =
    typeof object.message === "string"
      ? object.message
      : typeof nested?.message === "string"
        ? nested.message
        : `Request failed with status ${String(status)}`;
  return new ApiError(
    code,
    message,
    status,
    conflictList(object.conflicts ?? nested?.conflicts),
    syncResponse,
  );
}

const httpFetch: typeof fetch = (input, init) =>
  typeof window !== "undefined" && window.__TAURI_INTERNALS__
    ? tauriFetch(input, init)
    : fetch(input, init);

async function requestJson<T>(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: unknown,
  options: RequestOptions,
  offlineCode: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? 30_000);
  const abort = () => {
    controller.abort(options.signal?.reason);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  let response: Response;
  let text: string;
  try {
    response = await httpFetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    // The body is read under the same timeout, so a response whose headers
    // arrived but whose body never ends cannot leave the caller waiting.
    text = await response.text();
  } catch {
    if (options.signal?.aborted) throw new ApiError("cancelled", "Cancelled", 0);
    if (controller.signal.aborted && options.timeoutMessage) {
      throw new ApiError("timeout", options.timeoutMessage, 0);
    }
    throw new ApiError(offlineCode, "Not reachable", 0);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
  let value: unknown;
  if (text) {
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new ApiError("invalid_response", "Response was not JSON", response.status);
    }
  }
  if (!response.ok) throw errorFrom(response.status, value);
  return value as T;
}

export class ControlApi {
  constructor(readonly baseUrl: string) {}

  info(options: RequestOptions = {}): Promise<RunnerInfo> {
    return this.request("GET", "/api/control/info", undefined, options);
  }

  async projects(): Promise<ProjectRecord[]> {
    return (await this.request<{ projects: ProjectRecord[] }>("GET", "/api/projects")).projects;
  }

  async registerProject(project: NewProject): Promise<ProjectRecord> {
    return (await this.request<{ project: ProjectRecord }>("POST", "/api/projects", project))
      .project;
  }

  async updateProject(
    projectId: string,
    changes: { name?: string; devCommand?: string },
  ): Promise<ProjectRecord> {
    return (
      await this.request<{ project: ProjectRecord }>(
        "PUT",
        `/api/projects/${encodeURIComponent(projectId)}`,
        changes,
      )
    ).project;
  }

  environment(projectId: string): Promise<ProjectEnvironment> {
    return this.request("GET", `/api/projects/${encodeURIComponent(projectId)}/env`);
  }

  // Replaces the runner's whole set. The runner restarts a running preview
  // when the set changed.
  updateEnvironment(
    projectId: string,
    variables: Record<string, string>,
  ): Promise<ProjectEnvironment> {
    const body: ProjectEnvironmentUpdate = { variables };
    return this.request("PUT", `/api/projects/${encodeURIComponent(projectId)}/env`, body);
  }

  async deleteProject(projectId: string): Promise<void> {
    // Deleting cleans up the project's folders and shadow repository on the
    // runner, which can take a few seconds.
    await this.request("DELETE", `/api/projects/${encodeURIComponent(projectId)}`, undefined, {
      timeoutMs: 60_000,
      timeoutMessage: "The runner did not answer. The project was not removed there.",
    });
  }

  pairingCode(deviceName = "Phone"): Promise<PairingCodeResponse> {
    return this.request("POST", "/api/pairing-codes", {
      deviceName,
      ttlSeconds: 300,
    });
  }

  async devices(): Promise<DeviceResponse[]> {
    return (await this.request<{ devices: DeviceResponse[] }>("GET", "/api/devices")).devices;
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.request("POST", `/api/devices/${encodeURIComponent(deviceId)}/revoke`);
  }

  async tunnelHealth(): Promise<boolean> {
    try {
      return (await this.request<{ ready: boolean }>("GET", "/api/tunnel-health")).ready;
    } catch {
      return false;
    }
  }

  async syncHistory(projectId: string): Promise<SyncEvent[]> {
    return (
      await this.request<{ events: SyncEvent[] }>(
        "GET",
        `/api/projects/${encodeURIComponent(projectId)}/sync-history`,
      )
    ).events;
  }

  syncStatus(projectId: string): Promise<SyncStatusResponse> {
    return this.request("GET", `/api/projects/${encodeURIComponent(projectId)}/sync-status`);
  }

  async rewindSyncBase(projectId: string, from: string, to: string): Promise<void> {
    await this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/sync-rewind`, {
      from,
      to,
    });
  }

  syncPreview(
    projectId: string,
    direction: SyncDirection,
    options: SyncOptions,
  ): Promise<SyncResponse> {
    return this.request(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/sync-requests/preview`,
      {
        direction,
        grant: options.grant,
        ...(options.requestId ? { requestId: options.requestId } : {}),
      },
      { ...options, timeoutMs: 120_000 },
    );
  }

  sync(projectId: string, direction: SyncDirection, options: SyncOptions): Promise<SyncResponse> {
    return this.request(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/sync-requests`,
      {
        direction,
        grant: options.grant,
        ...(options.requestId ? { requestId: options.requestId } : {}),
        ...(options.resolutions && Object.keys(options.resolutions).length > 0
          ? { resolutions: options.resolutions }
          : {}),
      },
      { ...options, timeoutMs: 300_000 },
    );
  }

  private request<T>(
    method: string,
    pathname: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    return requestJson<T>(
      new URL(pathname, `${this.baseUrl}/`),
      method,
      { "x-nautilus-control": "1" },
      body,
      options,
      "runner_offline",
    );
  }
}

export class AgentApi {
  constructor(
    readonly baseUrl: string,
    private readonly launchKey: string,
  ) {}

  async healthy(): Promise<boolean> {
    try {
      await requestJson(
        new URL("/health", `${this.baseUrl}/`),
        "GET",
        {},
        undefined,
        { timeoutMs: 2_000 },
        "agent_offline",
      );
      return true;
    } catch {
      return false;
    }
  }

  mintGrant(projectId: string, direction: SyncDirection): Promise<SyncGrantResponse> {
    return this.request("POST", "/v1/grants", { projectId, direction });
  }

  async revokeGrant(grantId: string): Promise<void> {
    await this.request("POST", "/v1/grants/revoke", { grantId });
  }

  status(projectId: string): Promise<LocalSyncStatusResponse> {
    return this.request("GET", `/v1/status?projectId=${encodeURIComponent(projectId)}`);
  }

  compare(projectId: string, remoteHead: string, path: string): Promise<SyncFileChange> {
    const query = new URLSearchParams({ projectId, remoteHead, path });
    return this.request("GET", `/v1/compare?${query.toString()}`);
  }

  undoPull(projectId: string, requestId: string): Promise<LocalSyncStatusResponse> {
    return this.request("POST", "/v1/pull/undo", { projectId, requestId });
  }

  private request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    return requestJson<T>(
      new URL(pathname, `${this.baseUrl}/`),
      method,
      { authorization: `Bearer ${this.launchKey}` },
      body,
      {},
      "agent_offline",
    );
  }
}
