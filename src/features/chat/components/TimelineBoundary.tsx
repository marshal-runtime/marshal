import type { GoalLifecycleStatus } from "@common/goal-contract";
import type { ReactNode } from "react";

import {
  Bot,
  CircleAlert,
  CircleCheck,
  Flag,
  MessageSquareMore,
  RefreshCw,
} from "@/components/icons";
import { MarkdownRenderer } from "@/plugins/streamdown-config";
import { formatMessageTime } from "@/shared/marshal-foundation/date";

import type { Message } from "./ChatMessage";

interface TimelineBoundaryPresentation {
  title: string;
  detail?: string;
  attributions?: string[];
  icon: ReactNode;
}

export function TimelineBoundary({ message }: { message: Message }) {
  const presentation = presentTimelineBoundary(message);
  const time = formatMessageTime(message.timestamp);
  const eventType =
    message.goalTimelineEvent?.type ??
    (message.agentMessage ? `agent.${message.agentMessage.kind}` : "goal.continuation");

  return (
    <div className="w-full py-1.5" data-message-id={message.id} data-testid="timeline-boundary">
      <div className="flex items-center gap-3" data-event-type={eventType}>
        <div className="h-px min-w-6 flex-1 bg-border/70" aria-hidden />
        <div className="flex max-w-[640px] shrink-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span aria-hidden>{presentation.icon}</span>
          <span className="font-medium text-foreground/80">{presentation.title}</span>
          {presentation.attributions?.map((attribution) => (
            <span key={attribution} data-testid="timeline-agent-attribution">
              · {attribution}
            </span>
          ))}
          {time && (
            <time dateTime={message.timestamp.toISOString()} className="text-muted-foreground/80">
              · {time}
            </time>
          )}
        </div>
        <div className="h-px min-w-6 flex-1 bg-border/70" aria-hidden />
      </div>
      {presentation.detail && (
        <div
          className="mx-auto mt-1.5 max-w-[640px] px-8 text-sm/6 wrap-break-word text-muted-foreground"
          data-testid="timeline-boundary-detail"
        >
          <MarkdownRenderer>{presentation.detail}</MarkdownRenderer>
        </div>
      )}
    </div>
  );
}

function presentTimelineBoundary(message: Message): TimelineBoundaryPresentation {
  if (message.agentMessage) return presentAgentMessage(message);
  const event = message.goalTimelineEvent;
  if (!event) {
    return {
      title: "Goal continuation",
      icon: <RefreshCw className="size-3.5" />,
    };
  }

  switch (event.type) {
    case "goal.declared":
      return {
        title: "Goal started",
        detail: event.objective,
        icon: <Flag className="size-3.5" />,
      };
    case "goal.continuation": {
      const detail = [
        event.resumeTrigger.milestoneSummary,
        event.durableMilestone.handoffSummary,
        event.resumeTrigger.reason,
      ]
        .filter(
          (value, index, values): value is string =>
            Boolean(value) && values.indexOf(value) === index,
        )
        .join("\n\n");
      return {
        title: event.verification
          ? `Goal verification ${event.sequence}`
          : `Goal continuation ${event.sequence}`,
        ...(detail ? { detail } : {}),
        attributions: [
          `Handled by ${agentLabel(event.agent)}`,
          ...(event.reviewer ? [`Reviewed by ${agentLabel(event.reviewer)}`] : []),
        ],
        icon: event.verification ? (
          <CircleCheck className="size-3.5" />
        ) : (
          <RefreshCw className="size-3.5" />
        ),
      };
    }
    case "goal.completion-requested":
      return {
        title: "Completion requested",
        detail: "The goal will continue through verification before it can finish.",
        icon: <CircleCheck className="size-3.5" />,
      };
    case "goal.completion-rejected":
      return {
        title:
          event.outcome === "blocked"
            ? "Completion rejected and goal blocked"
            : "Completion rejected; goal will continue",
        detail: event.reason,
        icon: <CircleAlert className="size-3.5" />,
      };
    case "goal.lifecycle-changed":
      return {
        title: lifecycleTitle(event.to),
        ...(event.reason ? { detail: event.reason } : {}),
        icon:
          event.to === "blocked" ? (
            <CircleAlert className="size-3.5" />
          ) : event.to === "completed" ? (
            <CircleCheck className="size-3.5" />
          ) : (
            <Flag className="size-3.5" />
          ),
      };
  }
  return {
    title: "Goal updated",
    icon: <Flag className="size-3.5" />,
  };
}

function presentAgentMessage(message: Message): TimelineBoundaryPresentation {
  const metadata = message.agentMessage;
  if (!metadata) {
    return { title: "Agent update", detail: message.content, icon: <Bot className="size-3.5" /> };
  }
  const detail = stripSubagentEnvelope(message.content);
  const attribution = `From ${metadata.sourceLabel ?? compactAgentId(metadata.source)}`;
  if (metadata.kind === "goal-terminal") {
    const delegated = !metadata.source.startsWith("goal:");
    const terminal = metadata.goalTerminalKind ?? "completed";
    return {
      title: delegated ? `Delegated goal ${terminal}` : `Goal ${terminal}`,
      ...(detail ? { detail } : {}),
      attributions: [attribution],
      icon:
        terminal === "completed" ? (
          <CircleCheck className="size-3.5" />
        ) : (
          <CircleAlert className="size-3.5" />
        ),
    };
  }
  if (metadata.coalescedMessageCount) {
    const oldest = sentTimeAttribution(message, "Oldest sent");
    return {
      title: "Queued messages",
      ...(detail ? { detail } : {}),
      attributions: [`${metadata.coalescedMessageCount} messages`, ...(oldest ? [oldest] : [])],
      icon: <Bot className="size-3.5" />,
    };
  }
  const sent = sentTimeAttribution(message, "Sent");
  const title =
    metadata.kind === "parent"
      ? "Subagent handoff"
      : metadata.kind === "readiness"
        ? "Subagent ready"
        : metadata.kind === "subagent"
          ? "Parent continuation"
          : metadata.kind === "review-comment" || metadata.kind === "review-feedback"
            ? "Review feedback"
            : "Agent update";
  return {
    title,
    ...(detail ? { detail } : {}),
    attributions: [attribution, ...(sent ? [sent] : [])],
    icon:
      metadata.kind === "review-comment" || metadata.kind === "review-feedback" ? (
        <MessageSquareMore className="size-3.5" />
      ) : (
        <Bot className="size-3.5" />
      ),
  };
}

/** The boundary's own time is arrival, so a message that sat in the queue also shows when it was sent. */
function sentTimeAttribution(message: Message, label: string): string | undefined {
  const acceptedAt = message.agentMessage?.acceptedAt;
  if (!acceptedAt) return undefined;
  const sentAt = new Date(acceptedAt);
  if (message.timestamp.getTime() - sentAt.getTime() < 60_000) return undefined;
  const time = formatMessageTime(sentAt);
  return time ? `${label} ${time}` : undefined;
}

function agentLabel(agent: { sessionId: string; sourceLabel?: string }): string {
  return agent.sourceLabel ?? compactAgentId(agent.sessionId);
}

function compactAgentId(value: string): string {
  if (value.startsWith("goal:")) return "Goal engine";
  return value.length > 12 ? value.slice(0, 8) : value;
}

function stripSubagentEnvelope(content: string): string {
  if (!content.startsWith("Message from subagent ")) return content;
  const separator = content.indexOf("\n\n");
  return separator === -1 ? content : content.slice(separator + 2);
}

function lifecycleTitle(status: GoalLifecycleStatus): string {
  switch (status) {
    case "pursuing":
      return "Goal pursuit resumed";
    case "paused":
      return "Goal paused";
    case "blocked":
      return "Goal blocked";
    case "completed":
      return "Goal completed";
    case "stopped":
      return "Goal stopped";
  }
  return "Goal updated";
}
