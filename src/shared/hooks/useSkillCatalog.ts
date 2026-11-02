// Ownership: shared catalog hooks.
import { useQuery } from "@tanstack/react-query";

import type { Skill } from "@/types/electron";

/**
 * Shared hook for fetching installed skills.
 * Uses the canonical ["skills"] query key so all consumers share the same cache.
 */
export function useSkills(enabled = true, sessionId?: string) {
  return useQuery<Skill[]>({
    queryKey: ["skills", sessionId ?? "global"],
    queryFn: async () => {
      if (!window.skillsAPI) return [];
      const r = await window.skillsAPI.list(sessionId);
      return r.success && r.skills ? r.skills : [];
    },
    enabled,
  });
}
