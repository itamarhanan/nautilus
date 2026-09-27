"use client";

import { useEffect } from "react";
import { onOffline, onResume } from "@/lib/activity";
import { connectSessionStream, idleStream } from "@/lib/stream/session-stream";
import { useActions, useWorkspace } from "@/store";
import { openSessionId } from "@/store/selectors";

export function useSessionStream() {
  const sessionId = useWorkspace(openSessionId);
  const { applySnapshot, applyEvent, setConnection, signOutLocally } = useActions();

  useEffect(() => {
    if (!sessionId) {
      setConnection(idleStream);
      return;
    }
    const stream = connectSessionStream({
      sessionId,
      onSnapshot: applySnapshot,
      onEvent: applyEvent,
      onState: setConnection,
      onUnauthorized: signOutLocally,
    });
    const stopResume = onResume(stream.wake);
    const stopOffline = onOffline(stream.dropConnection);
    return () => {
      stopResume();
      stopOffline();
      stream.disconnect();
    };
  }, [sessionId, applySnapshot, applyEvent, setConnection, signOutLocally]);
}
