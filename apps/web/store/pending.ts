import { errorMessage, isUnauthorized } from "@/lib/api/client";
import { idlePending } from "./state";
import type { GetState, Pending, SetState } from "./state";

export async function runPending<K extends keyof Pending>(
  set: SetState,
  get: GetState,
  slot: K,
  value: Pending[K],
  work: () => Promise<void>,
  fallback: string,
): Promise<boolean> {
  set((state) => ({ pending: { ...state.pending, [slot]: value }, error: null }));
  try {
    await work();
    return true;
  } catch (error) {
    if (isUnauthorized(error)) get().actions.signOutLocally();
    else set({ error: errorMessage(error, fallback) });
    return false;
  } finally {
    set((state) => ({ pending: { ...state.pending, [slot]: idlePending[slot] } }));
  }
}
