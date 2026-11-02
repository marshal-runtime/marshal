import {
  isHiddenInternalControlMessage,
  isVisibleInternalControlResponse,
} from "@common/marshal-ipc-contract";
import { createLogger } from "@common/marshal-logger";

import type { PermissionCardData } from "@/types/electron";

import type { Message } from "../components/ChatMessage";

const TIMELINE_FILTER_STORAGE_PREFIX = "marshal.chat.timeline-filter.v1:";
const log = createLogger("TimelineFilters");

export const TIMELINE_FILTER_CATEGORIES = [
  "assistant",
  "user",
  "subagent",
  "goal",
  "runtime",
  "system",
] as const;

export type TimelineFilterCategory = (typeof TIMELINE_FILTER_CATEGORIES)[number];
export type TimelineRenderRole = "assistant" | "user" | "event" | "system";

export interface TimelineSubagentIdentity {
  id: string;
  name: string;
  source: "subagent" | "workflow-agent" | "reviewer";
}

export interface TimelineEntryClassification {
  categories: readonly TimelineFilterCategory[];
  timestamp: number | null;
  renderRole: TimelineRenderRole;
  renderable: boolean;
  participants: readonly TimelineSubagentIdentity[];
  subagent?: TimelineSubagentIdentity;
}

export interface TimelineFilterState {
  categories: TimelineFilterCategory[];
  subagentId: string | null;
  from: string;
  to: string;
}

export function createTimelineFilterState(): TimelineFilterState {
  return {
    categories: [...TIMELINE_FILTER_CATEGORIES],
    subagentId: null,
    from: "",
    to: "",
  };
}

function timelineFilterStorageKey(
  sessionId?: string | null,
  prefix = TIMELINE_FILTER_STORAGE_PREFIX,
): string {
  return `${prefix}${encodeURIComponent(sessionId ?? "<new>")}`;
}

function isTimelineFilterCategory(value: unknown): value is TimelineFilterCategory {
  return (
    typeof value === "string" && TIMELINE_FILTER_CATEGORIES.some((category) => category === value)
  );
}

function isTimelineFilterState(value: unknown): value is TimelineFilterState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const categories = Reflect.get(value, "categories");
  const subagentId = Reflect.get(value, "subagentId");
  const from = Reflect.get(value, "from");
  const to = Reflect.get(value, "to");
  if (
    !Array.isArray(categories) ||
    !categories.every(isTimelineFilterCategory) ||
    new Set(categories).size !== categories.length
  ) {
    return false;
  }
  if (subagentId !== null && typeof subagentId !== "string") return false;
  if (typeof from !== "string" || typeof to !== "string") return false;
  return (
    (!from || parseLocalDateTimeValue(from) !== null) &&
    (!to || parseLocalDateTimeValue(to) !== null)
  );
}

export function loadTimelineFilterState(sessionId?: string | null): TimelineFilterState {
  const fallback = createTimelineFilterState();
  if (typeof window === "undefined") return fallback;
  const key = timelineFilterStorageKey(sessionId);
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!isTimelineFilterState(parsed)) {
      window.localStorage.removeItem(key);
      log.warn("Ignoring invalid persisted timeline filter state");
      return fallback;
    }
    const selectedCategories = new Set(parsed.categories);
    return {
      ...parsed,
      categories: TIMELINE_FILTER_CATEGORIES.filter((category) => selectedCategories.has(category)),
    };
  } catch (error) {
    log.warn("Could not restore timeline filter state", error);
    return fallback;
  }
}

export function persistTimelineFilterState(
  sessionId: string | null | undefined,
  filter: TimelineFilterState,
): void {
  if (typeof window === "undefined") return;
  const key = timelineFilterStorageKey(sessionId);
  try {
    if (isTimelineFilterActive(filter)) {
      window.localStorage.setItem(key, JSON.stringify(filter));
    } else {
      window.localStorage.removeItem(key);
    }
  } catch (error) {
    log.warn("Could not persist timeline filter state", error);
  }
}

function isSubagentSource(source: string | undefined): source is "subagent" | "workflow-agent" {
  return source === "subagent" || source === "workflow-agent";
}

function getTimelineParticipants(message: Message): TimelineSubagentIdentity[] {
  const participants = new Map<string, TimelineSubagentIdentity>();
  const addParticipant = (participant: TimelineSubagentIdentity | undefined) => {
    if (participant && !participants.has(participant.id)) {
      participants.set(participant.id, participant);
    }
  };
  const continuationAgent =
    message.goalTimelineEvent?.type === "goal.continuation"
      ? message.goalTimelineEvent.agent
      : undefined;
  if (isSubagentSource(continuationAgent?.source)) {
    addParticipant({
      id: continuationAgent.sessionId,
      name:
        continuationAgent.sourceLabel?.trim() ||
        `Subagent ${continuationAgent.sessionId.slice(0, 8)}`,
      source: continuationAgent.source,
    });
  }
  const continuationReviewer =
    message.goalTimelineEvent?.type === "goal.continuation"
      ? message.goalTimelineEvent.reviewer
      : undefined;
  if (continuationReviewer) {
    addParticipant({
      id: continuationReviewer.sessionId,
      name:
        continuationReviewer.sourceLabel?.trim() ||
        `Reviewer ${continuationReviewer.sessionId.slice(0, 8)}`,
      source: isSubagentSource(continuationReviewer.source)
        ? continuationReviewer.source
        : "reviewer",
    });
  }
  const metadata = message.agentMessage;
  if (metadata) {
    const source = isSubagentSource(metadata.sourceSessionSource)
      ? metadata.sourceSessionSource
      : metadata.kind === "review-comment" || metadata.kind === "review-feedback"
        ? "reviewer"
        : metadata.kind === "parent" ||
            metadata.kind === "readiness" ||
            (metadata.kind === "goal-terminal" && !metadata.source.startsWith("goal:"))
          ? "subagent"
          : undefined;
    if (source) {
      const fallbackLabel = source === "reviewer" ? "Reviewer" : "Subagent";
      addParticipant({
        id: metadata.source,
        name: metadata.sourceLabel?.trim() || `${fallbackLabel} ${metadata.source.slice(0, 8)}`,
        source,
      });
    }
  }
  return [...participants.values()];
}

function getSubagentIdentity(message: Message): TimelineSubagentIdentity | undefined {
  return getTimelineParticipants(message)[0];
}

function finiteTimestamp(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * A goal-continuation RESPONSE is the pursuing agent's own turn — its text and tool
 * calls — so it belongs in the timeline even though the injected prompt that triggered
 * it is internal.
 */
function isGoalContinuationWork(message: Message): boolean {
  return (
    message.internalControl?.kind === "goal-continuation" &&
    message.internalControl.side === "response"
  );
}

export function classifyTimelineMessage(message: Message): TimelineEntryClassification {
  const structuredInternalBoundary =
    message.internalControl?.side === "request" && message.goalTimelineEvent !== undefined;
  if (
    isHiddenInternalControlMessage(message) &&
    !structuredInternalBoundary &&
    !isGoalContinuationWork(message)
  ) {
    return {
      categories: [],
      timestamp: finiteTimestamp(message.timestamp.getTime()),
      renderRole: "event",
      renderable: false,
      participants: [],
    };
  }

  const categories = new Set<TimelineFilterCategory>();
  const participants = getTimelineParticipants(message);
  const subagent = participants[0];
  const agentKind = message.agentMessage?.kind;
  const continuationAgent =
    message.goalTimelineEvent?.type === "goal.continuation"
      ? message.goalTimelineEvent.agent
      : undefined;
  const isGoal =
    message.goalContinuation === true ||
    message.goalTimelineEvent !== undefined ||
    isGoalContinuationWork(message) ||
    message.agentMessage?.goalFence !== undefined ||
    message.agentMessage?.goalId !== undefined ||
    message.agentMessage?.goalDeliveryKind !== undefined ||
    agentKind === "goal-terminal";
  const isRuntime =
    message.background === true ||
    Boolean(message.toolCalls?.length) ||
    agentKind === "subagent" ||
    agentKind === "readiness" ||
    agentKind === "review-comment" ||
    agentKind === "review-feedback";

  if (subagent) categories.add("subagent");
  if (isGoal) categories.add("goal");
  if (isRuntime) categories.add("runtime");
  if (message.role === "system") categories.add("system");

  if (
    (message.role === "assistant" && !message.background) ||
    continuationAgent?.source === "assistant"
  ) {
    categories.add("assistant");
  } else if (
    message.role === "user" &&
    !subagent &&
    !isGoal &&
    !isRuntime &&
    message.agentMessage === undefined
  ) {
    categories.add("user");
  }

  if (categories.size === 0) {
    categories.add(message.role === "assistant" ? "assistant" : message.role);
  }

  const renderRole: TimelineRenderRole =
    message.goalTimelineEvent || message.agentMessage || message.goalContinuation
      ? "event"
      : message.role === "system"
        ? "system"
        : message.role;
  const renderable =
    !message.suppressedAgentStatusResponse &&
    (renderRole === "event" ||
      Boolean(
        message.content?.trim() ||
        message.images?.length ||
        message.question ||
        message.reasoning?.text.trim() ||
        message.toolCalls?.length,
      ));

  return {
    categories: TIMELINE_FILTER_CATEGORIES.filter((category) => categories.has(category)),
    timestamp: finiteTimestamp(message.timestamp.getTime()),
    renderRole,
    renderable,
    participants,
    subagent,
  };
}

export function classifyPermissionCard(card: PermissionCardData): TimelineEntryClassification {
  return {
    categories: ["runtime"],
    timestamp: finiteTimestamp(card.createdAt ?? Number.NaN),
    renderRole: "assistant",
    renderable: true,
    participants: [],
  };
}

export function parseLocalDateTimeValue(value: string): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "0"] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return null;
  }
  return date.getTime();
}

export function getTimelineDateRangeError(filter: TimelineFilterState): string | null {
  const from = parseLocalDateTimeValue(filter.from);
  const to = parseLocalDateTimeValue(filter.to);
  return from !== null && to !== null && from > to ? "Start must be before end" : null;
}

export function matchesTimelineFilter(
  classification: TimelineEntryClassification,
  filter: TimelineFilterState,
): boolean {
  if (!classification.categories.some((category) => filter.categories.includes(category))) {
    return false;
  }
  if (
    filter.subagentId &&
    !classification.participants.some((participant) => participant.id === filter.subagentId)
  ) {
    return false;
  }
  const from = parseLocalDateTimeValue(filter.from);
  const to = parseLocalDateTimeValue(filter.to);
  if (from === null && to === null) return true;
  if (classification.timestamp === null) return false;
  return (
    (from === null || classification.timestamp >= from) &&
    (to === null || classification.timestamp <= to)
  );
}

export function collectTimelineSubagents(messages: readonly Message[]): TimelineSubagentIdentity[] {
  const identities = new Map<string, TimelineSubagentIdentity>();
  for (const message of messages) {
    for (const identity of classifyTimelineMessage(message).participants) {
      if (!identities.has(identity.id)) identities.set(identity.id, identity);
    }
  }
  return [...identities.values()];
}

export function isTimelineFilterActive(filter: TimelineFilterState): boolean {
  return (
    filter.categories.length !== TIMELINE_FILTER_CATEGORIES.length ||
    !TIMELINE_FILTER_CATEGORIES.every((category) => filter.categories.includes(category)) ||
    filter.subagentId !== null ||
    Boolean(filter.from) ||
    Boolean(filter.to)
  );
}

export function timelineFilterActiveCount(filter: TimelineFilterState): number {
  let count = filter.categories.length === TIMELINE_FILTER_CATEGORIES.length ? 0 : 1;
  if (filter.subagentId) count += 1;
  if (filter.from) count += 1;
  if (filter.to) count += 1;
  return count;
}

export function getTimelineMessageDisplayContent(message: Message): string {
  if (
    message.internalControl &&
    message.internalControl.side !== "request" &&
    !isVisibleInternalControlResponse(message)
  ) {
    return "";
  }
  const metadata = message.agentMessage;
  if (!metadata || !getSubagentIdentity(message)) return message.content;
  const prefix = "Message from subagent ";
  const identitySuffix = ` (${metadata.source}):\n\n`;
  if (!message.content.startsWith(prefix)) return message.content;
  const suffixIndex = message.content.indexOf(identitySuffix, prefix.length);
  if (suffixIndex < 0) return message.content;
  return message.content.slice(suffixIndex + identitySuffix.length);
}
