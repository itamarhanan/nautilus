"use client";

import { useAppLifecycle } from "@/hooks/useAppLifecycle";
import { useTurnAlerts } from "@/hooks/useTurnAlerts";
import { useActions, useWorkspace } from "@/store";
import { StatusScreen } from "../common/StatusScreen";
import { PairingScreen } from "../pairing/PairingScreen";
import { Workspace } from "./Workspace";

export function NautilusApp() {
  useAppLifecycle();
  useTurnAlerts();
  const auth = useWorkspace((state) => state.auth);
  const error = useWorkspace((state) => state.error);
  const online = useWorkspace((state) => state.online);
  const { bootstrap } = useActions();

  switch (auth) {
    case "loading":
      return <StatusScreen title="Checking this device" isLoading />;
    case "unavailable":
      return online ? (
        <StatusScreen
          title="The runner is unavailable"
          description={error ?? "Nautilus could not reach the runner."}
          onRetry={bootstrap}
        />
      ) : (
        <StatusScreen
          title="You are offline"
          description="Nautilus reconnects on its own when this device is back online."
          onRetry={bootstrap}
        />
      );
    case "unauthenticated":
      return <PairingScreen />;
    case "authenticated":
      return <Workspace />;
  }
}
