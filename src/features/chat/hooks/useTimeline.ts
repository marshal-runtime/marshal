import { useMemo } from "react";

import type { PermissionCardData } from "@/types/electron";

import type { Message } from "../components/ChatMessage";
import {
  classifyPermissionCard,
  classifyTimelineMessage,
  collectTimelineSubagents,
  createTimelineFilterState,
  matchesTimelineFilter,
  type TimelineFilterState,
} from "../state/timelineFilters";

export type AssistantTimelineItem =
  | { kind: "message"; data: Message }
  | { kind: "permissions"; data: PermissionCardData[] };

export type TimelineItem = AssistantTimelineItem;

/**
 * A "run" is a group of consecutive assistant-side items (messages and
 * permission groups) that should render under a single avatar. Human, system,
 * and structured lifecycle/agent events are standalone runs.
 */
export type TimelineRun =
  | { role: "user"; items: [{ kind: "message"; data: Message }] }
  | { role: "system"; items: [{ kind: "message"; data: Message }] }
  | { role: "event"; items: [{ kind: "message"; data: Message }] }
  | { role: "assistant"; items: AssistantTimelineItem[] };

export interface TimelineWindowOptions {
  constrainResolvedCards?: boolean;
  filter?: TimelineFilterState;
}

/**
 * Merges chat messages and resolved permission cards into a single
 * chronologically-sorted timeline grouped into "runs". Consecutive
 * assistant-side items share an avatar; standalone actor/event messages break
 * the run.
 * Pending/running cards are returned separately so they render at the
 * bottom of the chat.
 */
export function useTimeline(
  messages: Message[],
  permissionCards: PermissionCardData[],
  options?: TimelineWindowOptions,
) {
  return useMemo(() => {
    const filter = options?.filter ?? createTimelineFilterState();
    const renderableMessages = messages
      .map((message, order) => ({
        message,
        order,
        classification: classifyTimelineMessage(message),
      }))
      .filter(({ classification }) => classification.renderable);
    const filteredMessages = renderableMessages.filter(({ classification }) =>
      matchesTimelineFilter(classification, filter),
    );
    const subagents = collectTimelineSubagents(
      renderableMessages.map(({ message }) => message),
    );
    const isSettled = (r: PermissionCardData) =>
      r.resolved === "denied" ||
      r.resolved === "failed" ||
      r.resolved === "timed-out" ||
      (r.resolved && r.output != null);
    const firstMessageAt = renderableMessages[0]?.classification.timestamp ?? undefined;
    const resolvedInWindow = permissionCards.filter(isSettled).filter((card) => {
      if (!options?.constrainResolvedCards || firstMessageAt === undefined) return true;
      const createdAt = card.createdAt ?? Number.POSITIVE_INFINITY;
      return createdAt >= firstMessageAt;
    });
    const resolved = resolvedInWindow.filter((card) =>
      matchesTimelineFilter(classifyPermissionCard(card), filter),
    );
    const activeCards = permissionCards.filter((r) => !isSettled(r));

    // Interleave messages and individual permission cards by time
    type FlatItem =
      | {
          kind: "message";
          data: Message;
          order: number;
          timestamp: number | null;
        }
      | { kind: "permission"; data: PermissionCardData; order: number };

    const flat: FlatItem[] = [
      ...filteredMessages.map(({ message, order, classification }) => ({
        kind: "message" as const,
        data: message,
        order,
        timestamp: classification.timestamp,
      })),
      ...resolved.map((r, index) => ({
        kind: "permission" as const,
        data: r,
        order: messages.length + index,
      })),
    ];
    flat.sort((a, b) => {
      const ta =
        a.kind === "message" ? a.timestamp : classifyPermissionCard(a.data).timestamp;
      const tb =
        b.kind === "message" ? b.timestamp : classifyPermissionCard(b.data).timestamp;
      return (
        (ta ?? Number.POSITIVE_INFINITY) - (tb ?? Number.POSITIVE_INFINITY) || a.order - b.order
      );
    });

    // Group consecutive permission items, then build runs
    const timeline: TimelineItem[] = [];
    for (const item of flat) {
      if (item.kind === "permission") {
        const last = timeline[timeline.length - 1];
        if (last?.kind === "permissions") {
          last.data.push(item.data);
        } else {
          timeline.push({ kind: "permissions", data: [item.data] });
        }
      } else {
        timeline.push({ kind: "message", data: item.data });
      }
    }

    // Group consecutive assistant-side items into runs
    const runs: TimelineRun[] = [];
    for (const item of timeline) {
      if (item.kind === "message") {
        const renderRole = classifyTimelineMessage(item.data).renderRole;
        if (renderRole === "event") {
          runs.push({ role: "event", items: [item] });
          continue;
        }
        if (renderRole === "user") {
          runs.push({ role: "user", items: [item] });
          continue;
        }
        if (renderRole === "system") {
          runs.push({ role: "system", items: [item] });
          continue;
        }
      }
      const last = runs[runs.length - 1];
      if (last?.role === "assistant") {
        last.items.push(item);
      } else {
        runs.push({ role: "assistant", items: [item] });
      }
    }

    return {
      timeline,
      runs,
      activeCards,
      subagents,
      totalEntryCount: renderableMessages.length + resolvedInWindow.length,
      visibleEntryCount: filteredMessages.length + resolved.length,
    };
  }, [messages, options?.constrainResolvedCards, options?.filter, permissionCards]);
}
