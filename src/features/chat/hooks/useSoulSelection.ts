import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useSouls } from "./useSouls";

export interface SoulSelection {
  souls: ReturnType<typeof useSouls>["souls"];
  /** Session soul when set, otherwise the global default. */
  currentId: string;
  select: (soulId: string) => void;
}

/**
 * Data layer for choosing the Marshal agent's soul: the list, the
 * current selection, and an optimistic write to the default (with rollback).
 */
export function useSoulSelection(
  sessionId?: string | null,
  onSelect?: (soulId: string) => void,
): SoulSelection {
  const { souls, defaultSoul, sessionSoul } = useSouls(sessionId);
  const queryClient = useQueryClient();
  const currentId = sessionSoul || defaultSoul;

  const selectMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!window.soulAPI) throw new Error("Soul API not available");
      await window.soulAPI.setDefault(id);
    },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["souls", "default"] });
      const previous = queryClient.getQueryData<string>(["souls", "default"]);
      queryClient.setQueryData(["souls", "default"], id);
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(["souls", "default"], context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["souls"] });
    },
  });

  const select = (id: string) => {
    selectMutation.mutate(id);
    onSelect?.(id);
  };

  return { souls, currentId, select };
}
