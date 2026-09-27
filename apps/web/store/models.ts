import type { AgentModel, ModelRef } from "@nautilus/types";
import { isUnauthorized } from "@/lib/api/client";
import * as api from "@/lib/api/endpoints";
import { rememberedModel, rememberModel } from "@/lib/storage";
import type { GetState, ModelCatalog, SetState, WorkspaceActions } from "./state";

type ModelActions = Pick<WorkspaceActions, "loadModels" | "setModel">;

function sameModel(left: ModelRef | null, right: ModelRef | null): boolean {
  return left?.providerId === right?.providerId && left?.modelId === right?.modelId;
}

function findModel(models: AgentModel[], ref: ModelRef | null): AgentModel | null {
  return (ref && models.find((model) => sameModel(model, ref))) ?? null;
}

export function currentModel(
  catalog: ModelCatalog,
  picked: ModelRef | null,
  lastModelId: string | null,
): AgentModel | null {
  return (
    findModel(catalog.models, picked) ??
    findModel(catalog.models, catalog.default) ??
    catalog.models.find((model) => model.modelId === lastModelId) ??
    null
  );
}

export function modelActions(set: SetState, get: GetState): ModelActions {
  return {
    loadModels: async () => {
      if (get().models.status === "loading") return;
      set((state) => ({ models: { ...state.models, status: "loading" } }));
      try {
        const { models, default: fallback } = await api.listModels();

        const picked = rememberedModel();
        const remembered = findModel(models, picked);

        const variant =
          picked?.variant && remembered?.variants.includes(picked.variant) ? picked.variant : null;
        set({
          models: { status: "ready", models, default: fallback },
          model: remembered && {
            providerId: remembered.providerId,
            modelId: remembered.modelId,
            ...(variant ? { variant } : {}),
          },
        });
      } catch (error) {
        if (isUnauthorized(error)) {
          get().actions.signOutLocally();
          return;
        }

        set((state) => ({ models: { ...state.models, status: "error" } }));
      }
    },

    setModel: (model) => {
      set({ model });
      rememberModel(model);
    },
  };
}
