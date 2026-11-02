import { useQuery } from "@tanstack/react-query";

export function useSouls(sessionId?: string | null) {
  const soulsQuery = useQuery({
    queryKey: ["souls"],
    queryFn: async () => {
      if (!window.soulAPI) return [];
      const result = await window.soulAPI.list();
      return result.success && result.souls ? result.souls : [];
    },
  });
  const souls = soulsQuery.data ?? [];

  const defaultSoulQuery = useQuery({
    queryKey: ["souls", "default"],
    queryFn: async () => {
      if (!window.soulAPI) return "default";
      const result = await window.soulAPI.getDefault();
      return result.success && result.soul ? result.soul : "default";
    },
  });
  const defaultSoul = defaultSoulQuery.data ?? "default";

  const sessionSoulQuery = useQuery({
    queryKey: ["souls", "session", sessionId],
    queryFn: async () => {
      const result = await window.soulAPI.getSessionSoul(sessionId!);
      return result.success && result.soul ? result.soul : "";
    },
    enabled: !!sessionId && !!window.soulAPI,
  });
  const sessionSoul = sessionSoulQuery.data ?? "";

  return {
    souls,
    defaultSoul,
    sessionSoul,
    isReady:
      defaultSoulQuery.isSuccess &&
      (!sessionId || !window.soulAPI || sessionSoulQuery.isSuccess),
  };
}
