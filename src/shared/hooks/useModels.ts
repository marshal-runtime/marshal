import { useQuery } from "@tanstack/react-query";

import type { ContextTier, ModelTier, ReasoningEffort } from "@/types/electron";

export function useModels({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["models"],
    queryFn: async () => {
      if (!window.modelsAPI) return [];
      const result = await window.modelsAPI.list();
      return result.success && result.models ? result.models : [];
    },
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useDefaultModel({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["models", "default"],
    queryFn: async () => {
      if (!window.modelsAPI) return "";
      const result = await window.modelsAPI.getDefault();
      return result.success && result.model ? result.model : "";
    },
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useDefaultReasoningEffort(
  model: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["models", "reasoning", model],
    queryFn: async () => {
      if (!window.modelsAPI || !model) return null;
      const result = await window.modelsAPI.getDefaultReasoningEffort(model);
      return result.success ? (result.effort ?? null) : null;
    },
    enabled: enabled && !!model,
    staleTime: 5 * 60 * 1000,
  });
}

export function useDefaultContextTier(
  model: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["models", "context-tier", model],
    queryFn: async (): Promise<ContextTier | null> => {
      if (!window.modelsAPI || !model) return null;
      const result = await window.modelsAPI.getDefaultContextTier(model);
      return result.success ? (result.contextTier ?? null) : null;
    },
    enabled: enabled && !!model,
    staleTime: 5 * 60 * 1000,
  });
}

/** Stored default model + reasoning for the subagent or workflow tier. */
export function useTierDefaults(tier: ModelTier, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["models", "tier", tier],
    queryFn: async (): Promise<{
      model?: string;
      reasoningEffort?: ReasoningEffort;
      contextTier?: ContextTier;
    }> => {
      if (!window.modelsAPI) return {};
      const result = await window.modelsAPI.getTierDefaults(tier);
      return result.success && result.defaults ? result.defaults : {};
    },
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

/** Per-session reasoning-effort override (null = inherit tier default). */
export function useSessionReasoningEffort(
  sessionId: string | null | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["models", "session-reasoning", sessionId],
    queryFn: async (): Promise<ReasoningEffort | null> => {
      if (!window.modelsAPI || !sessionId) return null;
      const result = await window.modelsAPI.getSessionReasoningEffort(sessionId);
      return result.success ? (result.effort ?? null) : null;
    },
    enabled: enabled && !!sessionId,
    staleTime: 5 * 60 * 1000,
  });
}

/** Per-session context-tier override (null = inherit the resolved default). */
export function useSessionContextTier(
  sessionId: string | null | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["models", "session-context-tier", sessionId],
    queryFn: async (): Promise<ContextTier | null> => {
      if (!window.modelsAPI || !sessionId) return null;
      const result = await window.modelsAPI.getSessionContextTier(sessionId);
      return result.success ? (result.contextTier ?? null) : null;
    },
    enabled: enabled && !!sessionId,
    staleTime: 5 * 60 * 1000,
  });
}
