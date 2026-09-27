import type { ModelRef } from "@nautilus/types";

const LAST_PROJECT_KEY = "nautilus:last-project";

export function rememberedProjectId(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function rememberProject(id: string) {
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, id);
  } catch {
    // Every write here is best-effort. localStorage throws when storage is
    // unavailable or full (private browsing, blocked cookies, exhausted quota),
    // and what this file stores is a convenience: the last project, the last
    // model, unsent drafts. The readers above already degrade to null on a
    // throw, so a failed write costs the user a preference, not a session.
  }
}

const MODEL_KEY = "nautilus:model";

export function rememberedModel(): ModelRef | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(MODEL_KEY) ?? "null") as unknown;
    if (typeof value !== "object" || value === null) return null;
    const { providerId, modelId, variant } = value as Record<string, unknown>;
    if (typeof providerId !== "string" || typeof modelId !== "string") return null;
    return typeof variant === "string" ? { providerId, modelId, variant } : { providerId, modelId };
  } catch {
    return null;
  }
}

export function rememberModel(model: ModelRef | null) {
  try {
    if (model) window.localStorage.setItem(MODEL_KEY, JSON.stringify(model));
    else window.localStorage.removeItem(MODEL_KEY);
  } catch {
    // Best-effort, for the reason given on `rememberProject` above.
  }
}

const DRAFTS_KEY = "nautilus:drafts";

const maxDrafts = 20;

export function rememberedDrafts(): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(DRAFTS_KEY) ?? "{}") as unknown;
    if (typeof value !== "object" || value === null) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function rememberDrafts(drafts: Record<string, string>) {
  try {
    const kept = Object.entries(drafts)
      .filter(([, text]) => text.trim().length > 0)
      .slice(-maxDrafts);
    if (kept.length === 0) window.localStorage.removeItem(DRAFTS_KEY);
    else window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Best-effort, for the reason given on `rememberProject` above. A draft that
    // cannot be stored is lost on reload, which is the cost of a full or
    // blocked quota and not a reason to interrupt the user mid-sentence.
  }
}
