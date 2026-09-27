export type ProjectView = "chat" | "preview" | "history";

export type AppLocation = {
  projectId: string | null;
  sessionId: string | null;
  view: ProjectView;
  isInfoOpen: boolean;
};

export const VIEWS: readonly ProjectView[] = ["chat", "preview", "history"];

export function parseLocation(search: string): AppLocation {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  const projectId = params.get("project");
  return {
    projectId,

    sessionId: projectId ? params.get("session") : null,
    view: VIEWS.find((candidate) => candidate === view) ?? "chat",
    isInfoOpen: params.has("info"),
  };
}

export function formatLocation(location: AppLocation): string {
  const params = new URLSearchParams();
  if (location.projectId) {
    params.set("project", location.projectId);
    if (location.sessionId) params.set("session", location.sessionId);
    if (location.view !== "chat") params.set("view", location.view);
  }

  const query = [params.toString(), location.isInfoOpen ? "info" : ""].filter(Boolean).join("&");
  return query ? `?${query}` : "";
}

export function writeLocation(location: AppLocation, mode: "push" | "replace") {
  if (typeof window === "undefined") return;
  const search = formatLocation(location);
  if (search === window.location.search) return;
  const url = `${window.location.pathname}${search}${window.location.hash}`;
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

export function currentLocation(): AppLocation {
  return parseLocation(typeof window === "undefined" ? "" : window.location.search);
}
