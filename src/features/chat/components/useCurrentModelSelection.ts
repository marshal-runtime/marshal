import { useQuery } from "@tanstack/react-query";

import { useDefaultModel, useModels } from "@/shared/hooks/useModels";

/**
 * The model the chat will use next: the session's model (including a switch
 * still waiting for the current reply to end) or, before the session has one,
 * the default. Shared by the picker and its trigger so both show the same pick.
 */
export function useCurrentModelSelection(sessionId?: string | null) {
  const { data: models = [], isLoading: modelsLoading } = useModels();
  const { data: defaultModel = "" } = useDefaultModel();

  const { data: sessionModel = "" } = useQuery({
    queryKey: ["models", "session", sessionId],
    queryFn: async () => {
      const result = await window.modelsAPI.getSessionModel(sessionId!);
      if (result.success && result.model) return result.model;
      return "";
    },
    enabled: !!sessionId && !!window.modelsAPI,
  });

  const currentModel = sessionModel || defaultModel;
  const currentModelInfo = models.find((model) => model.id === currentModel);
  return { models, modelsLoading, currentModel, currentModelInfo };
}
