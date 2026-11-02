import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment } from "react";
import { toast } from "sonner";

import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { sortModels } from "@/runtime-ui/models/sort-models";
import { useDefaultContextTier, useSessionContextTier } from "@/shared/hooks/useModels";
import { formatContextTier, isContextTier, supportsLongContext } from "@/shared/utils/context-tier";
import { groupModelsByRuntime, type ModelGroup } from "@/shared/utils/model-groups";
import type { ContextTier, ModelInfo } from "@/types/electron";

import { useCurrentModelSelection } from "./useCurrentModelSelection";

/** A peer group lists its models inline up to this size; larger catalogs fold into "Other models". */
const INLINE_GROUP_LIMIT = 8;

interface ModelPickerProps {
  sessionId?: string | null;
  disabled?: boolean;
}

/** Compact label for the picker's trigger: the selected model, plus its runtime when several are available. */
export function ModelSelectionLabel({ sessionId }: { sessionId?: string | null }) {
  const { models, currentModel, currentModelInfo } = useCurrentModelSelection(sessionId);
  if (!currentModel) return null;
  const modelName = currentModelInfo?.name || currentModel;
  const runtimeLabel =
    groupModelsByRuntime(models).length > 1 ? currentModelInfo?.runtime?.label : undefined;
  return (
    <span
      className="flex min-w-0 flex-col items-start text-left leading-tight"
      data-testid="model-selection-label"
      title={runtimeLabel ? `${modelName} · ${runtimeLabel}` : modelName}
    >
      <span className="max-w-48 truncate text-sm font-medium">{modelName}</span>
      {runtimeLabel && (
        <span className="max-w-48 truncate text-[11px] text-muted-foreground">{runtimeLabel}</span>
      )}
    </span>
  );
}

/**
 * Content-only component — renders DropdownMenu items.
 * Must be placed inside a DropdownMenuContent.
 */
export function ModelPicker({ sessionId, disabled }: ModelPickerProps) {
  const queryClient = useQueryClient();

  const { models, modelsLoading, currentModel, currentModelInfo } =
    useCurrentModelSelection(sessionId);
  const hasLongContext = supportsLongContext(currentModelInfo);
  const { data: inheritedContextTier } = useDefaultContextTier(currentModel, {
    enabled: hasLongContext,
  });

  const selectMutation = useMutation({
    mutationFn: async (modelId: string) => {
      if (sessionId && window.sessionsAPI?.setModel) {
        const result = await window.sessionsAPI.setModel(sessionId, modelId);
        if (!result.success) {
          throw new Error(result.error || "Failed to set model");
        }
      } else if (window.modelsAPI) {
        const result = await window.modelsAPI.setDefault(modelId);
        if (result && !result.success) {
          throw new Error(result.error || "Failed to set model");
        }
      }
    },
    onMutate: async (modelId) => {
      await queryClient.cancelQueries({ queryKey: ["models", "session", sessionId] });
      const previous = queryClient.getQueryData<string>(["models", "session", sessionId]);
      queryClient.setQueryData(["models", "session", sessionId], modelId);
      return { previous };
    },
    onError: (err, _modelId, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(["models", "session", sessionId], context.previous);
      }
      toast.error(err instanceof Error ? err.message : "Failed to set model");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });

  const handleSelect = (modelId: string) => {
    if (disabled) return;
    selectMutation.mutate(modelId);
  };

  const { data: sessionContextTier } = useSessionContextTier(sessionId, {
    enabled: !!sessionId,
  });

  const contextTierMutation = useMutation({
    mutationFn: async (contextTier: ContextTier) => {
      if (!sessionId || !window.modelsAPI) return;
      const result = await window.modelsAPI.setSessionContextTier(sessionId, contextTier);
      if (result && !result.success) {
        throw new Error(result.error || "Failed to set context window");
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["models", "session-context-tier", sessionId],
      });
    },
  });

  const getDisplayName = (model: ModelInfo): string => {
    return model.name || model.id;
  };

  const getPremiumLabel = (model: ModelInfo): string | null => {
    if (!model.billing?.isPremium) return null;
    const mult = model.billing.premiumMultiplier || 1;
    if (mult >= 1) return `${mult}x`;
    return null;
  };

  if (modelsLoading) {
    return (
      <div className="p-3 text-xs text-muted-foreground" data-testid="model-picker">
        Loading models...
      </div>
    );
  }

  const groups = groupModelsByRuntime(models);
  const showGroupLabels = groups.length > 1;
  const currentGroup = currentModelInfo?.runtime;
  const runsOnOtherRuntime =
    showGroupLabels && !!currentGroup && currentGroup.label !== groups[0]?.label;

  const renderModelItem = (model: ModelInfo) => {
    const premium = getPremiumLabel(model);
    return (
      <DropdownMenuRadioItem key={model.id} value={model.id} disabled={disabled}>
        <span className="flex-1 truncate">{getDisplayName(model)}</span>
        {premium && <span className="ml-auto text-xs text-muted-foreground">{premium}</span>}
      </DropdownMenuRadioItem>
    );
  };

  const renderGroup = (group: ModelGroup, index: number) => {
    const featuredModels = sortModels(group.models.filter((m) => m.featured));
    const otherModels = sortModels(group.models.filter((m) => !m.featured));
    // Surface a selected non-featured model at the top level so its selected state
    // is visible without opening the "Other models" submenu.
    const inlineAll = index > 0 && group.models.length <= INLINE_GROUP_LIMIT;
    const selectedOtherModel = inlineAll
      ? undefined
      : otherModels.find((m) => m.id === currentModel);
    const submenuModels = inlineAll
      ? []
      : selectedOtherModel
        ? otherModels.filter((m) => m.id !== selectedOtherModel.id)
        : otherModels;
    return (
      <Fragment key={group.key}>
        {showGroupLabels && (
          <>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel
              className="text-xs font-normal text-muted-foreground"
              data-testid="model-group-label"
            >
              {group.label ?? "Other"}
            </DropdownMenuLabel>
          </>
        )}
        {featuredModels.map((model) => renderModelItem(model))}
        {inlineAll && otherModels.map((model) => renderModelItem(model))}
        {selectedOtherModel && renderModelItem(selectedOtherModel)}
        {submenuModels.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Other models</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-[60vh] overflow-y-auto">
              {submenuModels.map((model) => renderModelItem(model))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </Fragment>
    );
  };

  const showContextTier = !!sessionId && hasLongContext;

  return (
    <>
      <DropdownMenuLabel data-testid="model-picker">Models</DropdownMenuLabel>
      {runsOnOtherRuntime && (
        <div
          className="px-2 pb-1 text-xs text-muted-foreground"
          data-testid="model-picker-current-runtime"
        >
          Running on {currentGroup.label}
        </div>
      )}
      <DropdownMenuRadioGroup value={currentModel} onValueChange={handleSelect}>
        {groups.map((group, index) => renderGroup(group, index))}
      </DropdownMenuRadioGroup>
      {showContextTier && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel data-testid="context-tier-picker">Context window</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sessionContextTier ?? inheritedContextTier ?? "default"}
            onValueChange={(value) => {
              if (isContextTier(value)) contextTierMutation.mutate(value);
            }}
          >
            <DropdownMenuRadioItem value="default" disabled={disabled}>
              {formatContextTier(currentModelInfo, "default")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="long_context" disabled={disabled}>
              {formatContextTier(currentModelInfo, "long_context")}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </>
      )}
      {models.length === 0 && (
        <div className="px-3 py-4 text-center text-sm text-muted-foreground">
          No models available
        </div>
      )}
    </>
  );
}
