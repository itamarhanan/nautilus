import { useEffect, useMemo } from "react";
import type { AgentModel } from "@nautilus/types";
import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import type { SelectorOptionType } from "@astryxdesign/core/Selector";
import { RotateCcw } from "lucide-react";
import { contextTokens } from "@/lib/transcript";
import type { Usage } from "@/lib/transcript";
import { formatTokens } from "@/lib/usage";
import { useActions, useWorkspace } from "@/store";
import { currentModel } from "@/store/models";

const SEARCH_AFTER = 8;

function modelKey(model: { providerId: string; modelId: string }): string {
  return `${model.providerId}/${model.modelId}`;
}

function modelDescription(model: AgentModel): string | undefined {
  const details = [
    model.isReasoning ? "Reasoning" : null,
    model.variants.length > 0 ? `${String(model.variants.length)} effort levels` : null,
    model.contextLimit ? `${formatTokens(model.contextLimit)} context` : null,
  ].filter((detail) => detail !== null);
  return details.length > 0 ? details.join(" · ") : undefined;
}

function modelOptions(models: AgentModel[]): SelectorOptionType[] {
  const byProvider = new Map<string, AgentModel[]>();
  for (const model of models) {
    const group = byProvider.get(model.providerName) ?? [];
    group.push(model);
    byProvider.set(model.providerName, group);
  }
  return [...byProvider].map(([providerName, group]) => ({
    type: "section" as const,
    title: providerName,
    options: group.map((model) => ({
      value: modelKey(model),
      label: model.name,
      description: modelDescription(model),
    })),
  }));
}

type ModelPickerProps = {
  isDisabled: boolean;

  lastModelId: string | null;
};

export function ModelPicker({ isDisabled, lastModelId }: ModelPickerProps) {
  const catalog = useWorkspace((state) => state.models);
  const picked = useWorkspace((state) => state.model);
  const { loadModels, setModel } = useActions();

  useEffect(() => {
    if (catalog.status === "idle") void loadModels();
  }, [catalog.status, loadModels]);

  const options = useMemo(() => modelOptions(catalog.models), [catalog.models]);

  if (catalog.status === "error") {
    return (
      <Button
        label="Models unavailable"
        size="sm"
        variant="ghost"
        icon={<RotateCcw className="size-3.5" aria-hidden />}
        tooltip="Turns use the runner's default model. Tap to load the list again."
        clickAction={loadModels}
      />
    );
  }

  const current = currentModel(catalog, picked, lastModelId);
  const isReady = catalog.status === "ready" && catalog.models.length > 0;

  return (
    <Selector
      label="Model"
      isLabelHidden
      size="sm"
      variant="ghost"
      placement="above"
      isLoading={catalog.status === "loading" || catalog.status === "idle"}
      isDisabled={isDisabled || !isReady}
      placeholder={catalog.status === "ready" ? "Default model" : "Loading models"}
      options={options}
      value={current ? modelKey(current) : ""}
      hasSearch={catalog.models.length > SEARCH_AFTER}
      searchPlaceholder="Search models"
      renderValue={(option) => option.label ?? option.value}
      onChange={(value) => {
        const model = catalog.models.find((candidate) => modelKey(candidate) === value);

        const variant =
          picked?.variant && model?.variants.includes(picked.variant) ? picked.variant : null;
        setModel(
          model
            ? {
                providerId: model.providerId,
                modelId: model.modelId,
                ...(variant ? { variant } : {}),
              }
            : null,
        );
      }}
    />
  );
}

export function EffortPicker({ isDisabled, lastModelId }: ModelPickerProps) {
  const catalog = useWorkspace((state) => state.models);
  const picked = useWorkspace((state) => state.model);
  const { setModel } = useActions();
  const current = currentModel(catalog, picked, lastModelId);
  if (!current || current.variants.length === 0) return null;
  const variant =
    picked && picked.modelId === current.modelId && picked.providerId === current.providerId
      ? (picked.variant ?? "")
      : "";
  return (
    <Selector
      label="Effort"
      isLabelHidden
      size="sm"
      variant="ghost"
      placement="above"
      isDisabled={isDisabled}
      options={[
        { value: "", label: "Default effort" },
        ...current.variants.map((name) => ({
          value: name,
          label: capitalize(name),
        })),
      ]}
      value={variant}
      renderValue={(option) => option.label ?? option.value}
      onChange={(value) => {
        setModel({
          providerId: current.providerId,
          modelId: current.modelId,
          ...(value ? { variant: value } : {}),
        });
      }}
    />
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type ContextMeterProps = {
  lastModelId: string | null;

  usage: Usage | null;
};

export function ContextMeter({ lastModelId, usage }: ContextMeterProps) {
  const catalog = useWorkspace((state) => state.models);
  const picked = useWorkspace((state) => state.model);
  const limit = currentModel(catalog, picked, lastModelId)?.contextLimit ?? null;
  if (!usage || !limit) return null;
  const used = contextTokens(usage);
  const percent = Math.min(100, Math.round((used / limit) * 100));
  const tone = percent >= 85 ? "text-error" : percent >= 60 ? "text-warning" : "text-secondary";
  return (
    <span
      className={`shrink-0 px-1 font-mono text-xs ${tone}`}
      title={`${formatTokens(used)} of ${formatTokens(limit)} tokens in context`}
      aria-label={`Context ${String(percent)} percent full`}
    >
      {String(percent)}%
    </span>
  );
}
