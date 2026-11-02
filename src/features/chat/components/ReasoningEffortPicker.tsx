import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Lightbulb } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSessionReasoningEffort } from "@/shared/hooks/useModels";
import {
  formatReasoningEffort,
  getAutomaticReasoningEffort,
  getSupportedReasoningEfforts,
  isReasoningEffort,
} from "@/shared/utils/reasoning-effort";
import type { ReasoningEffort } from "@/types/electron";

import { useCurrentModelSelection } from "./useCurrentModelSelection";

interface ReasoningEffortPickerProps {
  sessionId?: string | null;
  disabled?: boolean;
}

/**
 * Compose-bar knob for the chat's reasoning effort. Renders nothing until the
 * chat has a session whose current model exposes reasoning-effort levels.
 */
export function ReasoningEffortPicker({ sessionId, disabled }: ReasoningEffortPickerProps) {
  const queryClient = useQueryClient();
  const { currentModelInfo } = useCurrentModelSelection(sessionId);
  const { data: sessionReasoning } = useSessionReasoningEffort(sessionId, {
    enabled: !!sessionId,
  });
  const queryKey = ["models", "session-reasoning", sessionId];

  const reasoningMutation = useMutation({
    mutationFn: async (value: "auto" | ReasoningEffort) => {
      if (!sessionId || !window.modelsAPI) return;
      const result = await window.modelsAPI.setSessionReasoningEffort(
        sessionId,
        value === "auto" ? undefined : value,
      );
      if (result && !result.success) {
        throw new Error(result.error || "Failed to set reasoning effort");
      }
    },
    onMutate: async (value) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ReasoningEffort | null>(queryKey);
      queryClient.setQueryData(queryKey, value === "auto" ? null : value);
      return { previous };
    },
    onError: (err, _value, context) => {
      queryClient.setQueryData(queryKey, context?.previous ?? null);
      toast.error(err instanceof Error ? err.message : "Failed to set reasoning effort");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const supportedEfforts = getSupportedReasoningEfforts(currentModelInfo);
  if (!sessionId || supportedEfforts.length === 0) return null;

  const automaticEffort = getAutomaticReasoningEffort(currentModelInfo);
  const autoLabel = automaticEffort ? `Auto (${formatReasoningEffort(automaticEffort)})` : "Auto";
  const selected = sessionReasoning && supportedEfforts.includes(sessionReasoning);
  const buttonLabel = selected
    ? formatReasoningEffort(sessionReasoning)
    : automaticEffort
      ? formatReasoningEffort(automaticEffort)
      : "Auto";

  const handleSelect = (value: string) => {
    if (disabled) return;
    if (value === "auto" || isReasoningEffort(value)) reasoningMutation.mutate(value);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-10 gap-1.5 rounded-full px-2.5"
          disabled={disabled}
          aria-label="Reasoning effort"
          title={`Reasoning effort: ${selected ? buttonLabel : autoLabel}`}
          data-testid="reasoning-effort-trigger"
        >
          <Lightbulb size={20} className="shrink-0" />
          <span className="text-sm font-medium" data-testid="reasoning-effort-label">
            {buttonLabel}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-48" align="start" side="top">
        <DropdownMenuLabel data-testid="reasoning-picker">Reasoning effort</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={selected ? sessionReasoning : "auto"}
          onValueChange={handleSelect}
        >
          <DropdownMenuRadioItem value="auto" disabled={disabled}>
            {autoLabel}
          </DropdownMenuRadioItem>
          {supportedEfforts.map((effort) => (
            <DropdownMenuRadioItem key={effort} value={effort} disabled={disabled}>
              {formatReasoningEffort(effort)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
