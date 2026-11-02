import { useQuery } from "@tanstack/react-query";

import type {
  HeartbeatLogEntry,
  HeartbeatSettings,
  HeartbeatStatus,
  AutomationData,
  AutomationRunData,
} from "@/types/electron";

export interface ConditionStatus {
  lastCheck: string | null;
  nextCheck: string | null;
  lastError: string | null;
}

interface ActivitiesPanelData {
  now: number;
  heartbeatStatus: HeartbeatStatus | null;
  heartbeatSettings: HeartbeatSettings | null;
  heartbeatLogs: HeartbeatLogEntry[];
  automations: AutomationData[];
  allAutomationRuns: AutomationRunData[];
  conditionStatuses: Map<string, ConditionStatus>;
}

const DEFAULT_DATA: ActivitiesPanelData = {
  now: 0,
  heartbeatStatus: null,
  heartbeatSettings: null,
  heartbeatLogs: [],
  automations: [],
  allAutomationRuns: [],
  conditionStatuses: new Map(),
};

/**
 * Fetches and refreshes all data needed by the Activities panel.
 * Loads on open and polls every 30s while the panel is visible.
 */
export function useActivitiesPanelData(isOpen: boolean): ActivitiesPanelData {
  const { data } = useQuery({
    queryKey: ["activities"],
    queryFn: async (): Promise<ActivitiesPanelData> => {
      if (!window.activitiesAPI) return DEFAULT_DATA;

      const result = await window.activitiesAPI.getAll(100);
      if (!result.success) return DEFAULT_DATA;

      return {
        now: Date.now(),
        heartbeatStatus: result.heartbeatStatus ?? null,
        heartbeatSettings: result.heartbeatSettings ?? null,
        heartbeatLogs: result.heartbeatLogs ?? [],
        automations: result.automations ?? [],
        allAutomationRuns: result.allAutomationRuns ?? [],
        conditionStatuses: new Map(Object.entries(result.conditionStatuses ?? {})),
      };
    },
    enabled: isOpen,
    placeholderData: DEFAULT_DATA,
    refetchInterval: isOpen ? 30_000 : false,
  });

  return data ?? DEFAULT_DATA;
}
