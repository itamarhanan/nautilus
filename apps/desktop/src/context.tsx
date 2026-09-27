import { createContext, useContext, type ReactNode } from "react";
import type { StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import type { DesktopStore } from "./store";

const StoreContext = createContext<StoreApi<DesktopStore> | null>(null);

export function StoreProvider({
  store,
  children,
}: {
  store: StoreApi<DesktopStore>;
  children: ReactNode;
}) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useApp<T>(selector: (state: DesktopStore) => T): T {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useApp must be used inside StoreProvider");
  return useStore(store, selector);
}
