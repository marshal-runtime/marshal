import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TelemetryPath_Model,
  SimplePropertyMonitor_ModelName,
  InteractiveElementMonitor_Switch,
} from "@/services/telemetry/schema";
import {
  useDefaultContextTier,
  useDefaultModel,
  useDefaultReasoningEffort,
  useModels,
} from "@/shared/hooks/useModels";
import { formatContextTier, isContextTier, supportsLongContext } from "@/shared/utils/context-tier";
import {
  formatReasoningEffort,
  getAutomaticReasoningEffort,
  getSupportedReasoningEfforts,
  isReasoningEffort,
} from "@/shared/utils/reasoning-effort";
import type { ContextTier, ReasoningEffort } from "@/types/electron";

import { ModelSelectItems } from "./ModelSelectItems";
import { SettingsRow } from "./SettingsRow";

/**
 * Dropdown for selecting the default model used by new sessions.
 * Self-contained: fetches model list and current default on mount.
 */
export function DefaultModelPicker({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();

  const { data: models = [] } = useModels({ enabled });
  const { data: defaultModel = "" } = useDefaultModel({ enabled });
  const selectedModel = models.find((model) => model.id === defaultModel);
  const supportedReasoningEfforts = getSupportedReasoningEfforts(selectedModel);
  const hasLongContext = supportsLongContext(selectedModel);
  const { data: defaultReasoningEffort } = useDefaultReasoningEffort(defaultModel, {
    enabled: enabled && supportedReasoningEfforts.length > 0,
  });
  const { data: defaultContextTier } = useDefaultContextTier(defaultModel, {
    enabled: enabled && hasLongContext,
  });

  const setDefaultMutation = useMutation({
    mutationFn: async (modelId: string) => {
      if (!window.modelsAPI) throw new Error("Models API not available");
      const result = await window.modelsAPI.setDefault(modelId);
      if (result && !result.success) {
        throw new Error(result.error || "Model is disabled by policy");
      }
    },
    onMutate: async (modelId) => {
      await queryClient.cancelQueries({ queryKey: ["models", "default"] });
      const previous = queryClient.getQueryData<string>(["models", "default"]);
      queryClient.setQueryData(["models", "default"], modelId);
      return { previous };
    },
    onError: (_err, _modelId, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(["models", "default"], context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["models", "default"] });
    },
  });

  const setReasoningEffortMutation = useMutation({
    mutationFn: async (value: "auto" | ReasoningEffort) => {
      if (!window.modelsAPI) throw new Error("Models API not available");
      const result = await window.modelsAPI.setDefaultReasoningEffort(
        defaultModel,
        value === "auto" ? undefined : value,
      );
      if (result && !result.success) {
        throw new Error(result.error || "Failed to set reasoning effort");
      }
    },
    onMutate: async (value) => {
      await queryClient.cancelQueries({ queryKey: ["models", "reasoning", defaultModel] });
      const previous = queryClient.getQueryData<ReasoningEffort | null | undefined>([
        "models",
        "reasoning",
        defaultModel,
      ]);
      queryClient.setQueryData(
        ["models", "reasoning", defaultModel],
        value === "auto" ? null : value,
      );
      return { previous };
    },
    onError: (_err, _value, context) => {
      queryClient.setQueryData(["models", "reasoning", defaultModel], context?.previous ?? null);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["models", "reasoning", defaultModel] });
    },
  });

  const setContextTierMutation = useMutation({
    mutationFn: async (contextTier: ContextTier) => {
      if (!window.modelsAPI) throw new Error("Models API not available");
      const result = await window.modelsAPI.setDefaultContextTier(defaultModel, contextTier);
      if (result && !result.success) {
        throw new Error(result.error || "Failed to set context window");
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["models", "context-tier", defaultModel] });
    },
  });

  const handleChange = (modelId: string) => setDefaultMutation.mutate(modelId);
  const handleReasoningEffortChange = (value: string) => {
    if (value === "auto" || isReasoningEffort(value)) {
      setReasoningEffortMutation.mutate(value);
    }
  };

  if (models.length === 0) return null;

  const modelName = selectedModel?.name || defaultModel;
  const reasoningValue = defaultReasoningEffort ?? "auto";
  // Reflect the model-aware automatic effort in the label rather than implying
  // that Auto disables reasoning.
  const effectiveDefaultEffort = getAutomaticReasoningEffort(selectedModel);
  const defaultReasoningLabel = effectiveDefaultEffort
    ? `Auto (${formatReasoningEffort(effectiveDefaultEffort)})`
    : "Auto";

  return (
    <TelemetryPath_Model>
      <SimplePropertyMonitor_ModelName value={modelName} />
      <div className="flex flex-col">
        <SettingsRow label="Model for new chats">
          <InteractiveElementMonitor_Switch callback={handleChange}>
            {(cb) => (
              <Select value={defaultModel} onValueChange={cb}>
                <SelectTrigger className="w-[228px] rounded-xl" data-testid="default-model-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <ModelSelectItems models={models} />
                </SelectContent>
              </Select>
            )}
          </InteractiveElementMonitor_Switch>
        </SettingsRow>
        {supportedReasoningEfforts.length > 0 ? (
          <SettingsRow label="Reasoning effort">
            <Select value={reasoningValue} onValueChange={handleReasoningEffortChange}>
              <SelectTrigger
                className="w-[228px] rounded-xl"
                data-testid="default-reasoning-effort-select"
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
              value={defaultContextTier ?? "default"}
              onValueChange={(value) => {
                if (isContextTier(value)) setContextTierMutation.mutate(value);
              }}
            >
              <SelectTrigger className="w-[228px] rounded-xl" data-testid="default-context-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">
                  {formatContextTier(selectedModel, "default")}
                </SelectItem>
                <SelectItem value="long_context">
                  {formatContextTier(selectedModel, "long_context")}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        ) : null}
      </div>
    </TelemetryPath_Model>
  );
}
