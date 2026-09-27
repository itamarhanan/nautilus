"use client";

import { useEffect } from "react";
import { emitOffline, emitResume } from "@/lib/activity";
import { setUpServiceWorker } from "@/lib/service-worker";
import { useActions, useWorkspace } from "@/store";

const POLL_MS = 15_000;
const EMPTY_POLL_MS = 10_000;

function isActive(): boolean {
  return document.visibilityState === "visible" && navigator.onLine;
}

export function useAppLifecycle() {
  const auth = useWorkspace((state) => state.auth);
  const hasProjects = useWorkspace((state) => state.projects.length > 0);
  const { bootstrap, refresh, setOnline } = useActions();

  useEffect(() => {
    void bootstrap();
    setUpServiceWorker();
  }, [bootstrap]);

  useEffect(() => {
    setOnline(navigator.onLine);
    const resume = () => {
      if (!isActive()) return;
      emitResume();

      void refresh();
    };
    const handleOnline = () => {
      setOnline(true);
      resume();
    };
    const handleOffline = () => {
      setOnline(false);
      emitOffline();
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [refresh, setOnline]);

  useEffect(() => {
    if (auth !== "authenticated") return;
    const timer = window.setInterval(
      () => {
        if (isActive()) void refresh();
      },
      hasProjects ? POLL_MS : EMPTY_POLL_MS,
    );
    return () => {
      window.clearInterval(timer);
    };
  }, [auth, hasProjects, refresh]);
}
