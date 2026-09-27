"use client";

import { useEffect, useRef } from "react";
import { currentLocation, writeLocation } from "@/lib/location";
import { rememberedProjectId } from "@/lib/storage";
import { useActions, useWorkspace } from "@/store";

export function useLocationSync() {
  const projects = useWorkspace((state) => state.projects);
  const { navigate } = useActions();
  const isRestored = useRef(false);

  useEffect(() => {
    if (isRestored.current || projects.length === 0) return;
    isRestored.current = true;
    const isKnown = (id: string | null) => projects.some((project) => project.id === id);
    let location = currentLocation();
    if (!isKnown(location.projectId)) {
      const remembered = rememberedProjectId();
      const fallback = isKnown(remembered)
        ? remembered
        : projects.length === 1
          ? (projects[0]?.id ?? null)
          : null;
      location = {
        ...location,
        projectId: fallback,
        sessionId: null,
        view: fallback ? location.view : "chat",
      };
    }
    navigate(location);
    writeLocation(location, "replace");
  }, [projects, navigate]);

  useEffect(() => {
    const handlePopState = () => {
      navigate(currentLocation());
    };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [navigate]);
}
