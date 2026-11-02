import type { SessionMetadata } from "./marshal-ipc-contract";

export const SESSION_FILTER_OPTIONS = [
  { value: "chats", label: "Chats" },
  { value: "subagents", label: "Agents" },
  { value: "workflow-agents", label: "Workflow agents" },
  { value: "automations", label: "Automations" },
] as const;

export type SessionFilter = (typeof SESSION_FILTER_OPTIONS)[number]["value"];

export const ALL_SESSION_FILTERS: ReadonlySet<SessionFilter> = new Set(
  SESSION_FILTER_OPTIONS.map((option) => option.value),
);
export const DEFAULT_SESSION_FILTERS: ReadonlySet<SessionFilter> = new Set(["chats"]);

export function isSessionFilter(value: unknown): value is SessionFilter {
  return SESSION_FILTER_OPTIONS.some((option) => option.value === value);
}

export function matchesSessionFilter(
  session: Pick<SessionMetadata, "automationId" | "source">,
  selectedFilters: ReadonlySet<SessionFilter>,
): boolean {
  if (selectedFilters.size === SESSION_FILTER_OPTIONS.length) return true;

  for (const filter of selectedFilters) {
    if (filter === "automations" && session.automationId) return true;
    if (filter === "subagents" && session.source === "subagent") return true;
    if (filter === "workflow-agents" && session.source === "workflow-agent") return true;
    if (
      filter === "chats" &&
      !session.automationId &&
      session.source !== "subagent" &&
      session.source !== "workflow-agent"
    ) {
      return true;
    }
  }

  return false;
}
