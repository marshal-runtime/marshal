import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useDefaultContextTier,
  useDefaultModel,
  useModels,
  useTierDefaults,
} from "@/shared/hooks/useModels";
import { formatContextTier, isContextTier, supportsLongContext } from "@/shared/utils/context-tier";
import {
  formatReasoningEffort,
  getAutomaticReasoningEffort,
  getSupportedReasoningEfforts,
  isReasoningEffort,
} from "@/shared/utils/reasoning-effort";
import type { ContextTier, ModelTier, ReasoningEffort } from "@/types/electron";

import { ModelSelectItems } from "./ModelSelectItems";
import { SettingsRow } from "./SettingsRow";

const INHERIT_VALUE = "inherit";

/**
 * Default model + reasoning picker for the `subagent` and `workflow` tiers.
 * The model defaults to "Same as chat" (inherits the chat default) until the
 * user picks a concrete model. Reasoning and context inherit model-aware
 * defaults unless the user stores a tier override.
 */
export function TierModelPicker({
  tier,
  label,
  enabled,
}: {
  tier: ModelTier;
  label: string;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();

  const { data: models = [] } = useModels({ enabled });
  const { data: tierDefaults } = useTierDefaults(tier, { enabled });
  const { data: chatDefaultModel = "" } = useDefaultModel({ enabled });

  const tierModel = tierDefaults?.model ?? "";
  const effectiveModelId = tierModel || chatDefaultModel;
  const selectedModel = models.find((model) => model.id === effectiveModelId);
  const supportedReasoningEfforts = getSupportedReasoningEfforts(selectedModel);
  const hasLongContext = supportsLongContext(selectedModel);
  const { data: inheritedContextTier } = useDefaultContextTier(effectiveModelId, {
    enabled: enabled && hasLongContext,
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["models", "tier", tier] });

  const setModelMutation = useMutation({
    mutationFn: async (value: string) => {
      if (!window.modelsAPI) throw new Error("Models API not available");
      const model = value === INHERIT_VALUE ? undefined : value;
      const result = await window.modelsAPI.setTierDefaultModel(tier, model);
      if (result && !result.success) {
        throw new Error(result.error || "Failed to set model");
      }
    },
    onSettled: invalidate,
  });

  const setReasoningMutation = useMutation({
    mutationFn: async (value: "auto" | ReasoningEffort) => {
      if (!window.modelsAPI) throw new Error("Models API not available");
      const result = await window.modelsAPI.setTierDefaultReasoningEffort(
        tier,
        value === "auto" ? undefined : value,
      );
      if (result && !result.success) {
        throw new Error(result.error || "Failed to set reasoning effort");
      }
    },
    onSettled: invalidate,
  });

  const setContextTierMutation = useMutation({
    mutationFn: async (contextTier: ContextTier) => {
      if (!window.modelsAPI) throw new Error("Models API not available");
      const result = await window.modelsAPI.setTierDefaultContextTier(tier, contextTier);
      if (result && !result.success) {
        throw new Error(result.error || "Failed to set context window");
      }
    },
    onSettled: invalidate,
  });

  const handleReasoningChange = (value: string) => {
    if (value === "auto" || isReasoningEffort(value)) {
      setReasoningMutation.mutate(value);
    }
  };

  if (models.length === 0) return null;

  const modelValue = tierModel || INHERIT_VALUE;
  const reasoningStored = tierDefaults?.reasoningEffort;
  const reasoningValue =
    reasoningStored && supportedReasoningEfforts.includes(reasoningStored)
      ? reasoningStored
      : "auto";
  const effectiveDefaultEffort = getAutomaticReasoningEffort(selectedModel);
  const defaultReasoningLabel = effectiveDefaultEffort
    ? `Auto (${formatReasoningEffort(effectiveDefaultEffort)})`
    : "Auto";
  const chatDefaultModelName =
    models.find((model) => model.id === chatDefaultModel)?.name || chatDefaultModel;

  return (
    <div className="flex flex-col">
      <SettingsRow label={`Model for ${label}`}>
        <Select value={modelValue} onValueChange={(value) => setModelMutation.mutate(value)}>
          <SelectTrigger className="w-[228px] rounded-xl" data-testid={`${tier}-model-select`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT_VALUE}>Same as chat ({chatDefaultModelName})</SelectItem>
            <ModelSelectItems models={models} />
          </SelectContent>
        </Select>
      </SettingsRow>
      {supportedReasoningEfforts.length > 0 ? (
        <SettingsRow label="Reasoning effort">
          <Select value={reasoningValue} onValueChange={handleReasoningChange}>
            <SelectTrigger
              className="w-[228px] rounded-xl"
              data-testid={`${tier}-reasoning-effort-select`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{defaultReasoningLabel}</SelectItem>
              {supportedReasoningEfforts.map((effort) => (
                <SelectItem key={effort} value={effort}>
                  {formatReasoningEffort(effort)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      ) : null}
      {hasLongContext ? (
        <SettingsRow label="Context window">
          <Select
            value={tierDefaults?.contextTier ?? inheritedContextTier ?? "default"}
            onValueChange={(value) => {
              if (isContextTier(value)) setContextTierMutation.mutate(value);
            }}
          >
            <SelectTrigger className="w-[228px] rounded-xl" data-testid={`${tier}-context-select`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{formatContextTier(selectedModel, "default")}</SelectItem>
              <SelectItem value="long_context">
                {formatContextTier(selectedModel, "long_context")}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
      ) : null}
    </div>
  );
}
