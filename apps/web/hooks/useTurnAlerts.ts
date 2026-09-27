"use client";

import { useEffect } from "react";
import type { SessionEvent } from "@nautilus/types";
import { clearAlerts, showAlert } from "@/lib/alerts";
import type { Alert } from "@/lib/alerts";
import { formatLocation } from "@/lib/location";
import { useWorkspace } from "@/store";
import type { WorkspaceState } from "@/store/state";

function alertFor(event: SessionEvent, projectName: string): Omit<Alert, "tag" | "url"> | null {
  switch (event.type) {
    case "session.completed":
      return { title: "The agent finished", body: projectName };
    case "session.error":
      return { title: "The agent's turn failed", body: projectName };
    case "session.interrupted":
      return { title: "The agent's turn stopped", body: projectName };
    case "session.permission":
      return event.payload.response === undefined
        ? { title: "The agent needs your approval", body: projectName }
        : null;
    default:
      return null;
  }
}

export function useTurnAlerts() {
  useEffect(() => {
    let watched: { sessionId: string; sequence: number } | null = null;
    const onChange = (state: WorkspaceState) => {
      const session = state.session;
      if (!session?.isSnapshotLoaded) return;
      const latest = session.events.at(-1)?.sequence ?? 0;
      if (watched?.sessionId !== session.id) {
        watched = { sessionId: session.id, sequence: latest };
        return;
      }
      const since = watched.sequence;
      if (latest <= since) return;
      watched.sequence = latest;
      const project = state.projects.find((entry) => entry.id === state.project?.id);
      for (const event of session.events) {
        if (event.sequence <= since) continue;
        const alert = alertFor(event, project?.name ?? "Nautilus");
        if (!alert) continue;
        showAlert({
          ...alert,
          tag: session.id,
          url: `/${formatLocation({
            projectId: event.projectId,
            sessionId: session.id,
            view: "chat",
            isInfoOpen: false,
          })}`,
        });
      }
    };
    const unsubscribe = useWorkspace.subscribe(onChange);
    const onVisible = () => {
      if (document.visibilityState === "visible") clearAlerts();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
