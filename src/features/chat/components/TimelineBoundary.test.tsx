import { beforeEach, describe, expect, it } from "vitest";

import { installMockAPIs, render, screen } from "@/test-utils";

import type { Message } from "./ChatMessage";
import { TimelineBoundary } from "./TimelineBoundary";

beforeEach(() => {
  installMockAPIs();
});

const goalFence = {
  goalId: "goal-1",
  epoch: 1,
};

describe("TimelineBoundary", () => {
  it("renders a stopped goal as a terminal boundary", () => {
    const message: Message = {
      id: "stopped",
      role: "system",
      content: "Goal stopped by the user.",
      timestamp: new Date("2026-07-24T10:00:00.000Z"),
      goalTimelineEvent: {
        type: "goal.lifecycle-changed",
        fence: goalFence,
        from: "pursuing",
        to: "stopped",
        reason: "Goal stopped by the user.",
      },
    };

    render(<TimelineBoundary message={message} />);

    expect(screen.getByText("Goal stopped")).toBeInTheDocument();
    expect(screen.getByText("Goal stopped by the user.")).toBeInTheDocument();
  });

  it("renders the final completed lifecycle transition as a terminal boundary", () => {
    const message: Message = {
      id: "completed",
      role: "system",
      content: "Goal completed after verification.",
      timestamp: new Date("2026-07-24T10:00:00.000Z"),
      goalTimelineEvent: {
        type: "goal.lifecycle-changed",
        fence: goalFence,
        from: "pursuing",
        to: "completed",
        reason: "Goal completed after verification.",
      },
    };

    render(<TimelineBoundary message={message} />);

    expect(screen.getByText("Goal completed")).toBeInTheDocument();
    expect(screen.getByText("Goal completed after verification.")).toBeInTheDocument();
  });

  it("renders a subagent handoff as an attributed boundary instead of a user envelope", () => {
    const message: Message = {
      id: "handoff",
      role: "user",
      content: "Message from subagent Worker (child-1):\n\nImplementation is ready.",
      timestamp: new Date("2026-07-24T10:00:00.000Z"),
      agentMessage: {
        source: "child-1",
        sourceLabel: "Worker",
        kind: "parent",
        deliveryMode: "queue",
        sequence: 7,
      },
    };

    render(<TimelineBoundary message={message} />);

    expect(screen.getByTestId("timeline-boundary")).toBeInTheDocument();
    expect(screen.getByText("Subagent handoff")).toBeInTheDocument();
    expect(screen.getByText("· From Worker")).toBeInTheDocument();
    expect(screen.getByText("Implementation is ready.")).toBeInTheDocument();
    expect(screen.queryByText(/Message from subagent/)).not.toBeInTheDocument();
  });

  it("shows the send time of a message that sat in the queue", () => {
    const message: Message = {
      id: "stale",
      role: "user",
      content: "Fix the review findings.",
      timestamp: new Date("2026-11-01T09:46:00.000Z"),
      agentMessage: {
        source: "parent-1",
        sourceLabel: "Coordinator",
        kind: "subagent",
        deliveryMode: "queue",
        sequence: 9,
        acceptedAt: "2026-11-01T07:13:00.000Z",
      },
    };

    render(<TimelineBoundary message={message} />);

    const attributions = screen.getAllByTestId("timeline-agent-attribution");
    expect(attributions).toHaveLength(2);
    expect(attributions[1]).toHaveTextContent(/· Sent /);
  });

  it("does not repeat the send time of a message delivered straight away", () => {
    const message: Message = {
      id: "fresh",
      role: "user",
      content: "Fix the review findings.",
      timestamp: new Date("2026-11-01T09:46:10.000Z"),
      agentMessage: {
        source: "parent-1",
        sourceLabel: "Coordinator",
        kind: "subagent",
        deliveryMode: "queue",
        sequence: 10,
        acceptedAt: "2026-11-01T09:46:00.000Z",
      },
    };

    render(<TimelineBoundary message={message} />);

    expect(screen.getAllByTestId("timeline-agent-attribution")).toHaveLength(1);
  });

  it("labels several queued messages delivered as one turn", () => {
    const message: Message = {
      id: "batch",
      role: "user",
      content: "3 messages were queued for you and arrive together, oldest first.",
      timestamp: new Date("2026-11-01T09:46:00.000Z"),
      agentMessage: {
        source: "parent-1",
        sourceLabel: "Coordinator",
        kind: "subagent",
        deliveryMode: "queue",
        sequence: 11,
        coalescedMessageCount: 3,
        acceptedAt: "2026-11-01T07:13:00.000Z",
      },
    };

    render(<TimelineBoundary message={message} />);

    expect(screen.getByText("Queued messages")).toBeInTheDocument();
    expect(screen.getByText("· 3 messages")).toBeInTheDocument();
    expect(screen.getByText(/· Oldest sent /)).toBeInTheDocument();
  });

  it("renders review UI feedback with explicit reviewer provenance", () => {
    const message: Message = {
      id: "review-feedback",
      role: "user",
      content: "Please address the review comments.",
      timestamp: new Date("2026-07-24T10:00:00.000Z"),
      agentMessage: {
        source: "review-ui",
        sourceLabel: "Review UI",
        kind: "review-feedback",
        deliveryMode: "queue",
        sequence: 8,
      },
    };

    render(<TimelineBoundary message={message} />);

    expect(screen.getByText("Review feedback")).toBeInTheDocument();
    expect(screen.getByText("· From Review UI")).toBeInTheDocument();
    expect(screen.getByText("Please address the review comments.")).toBeInTheDocument();
  });

  it("renders readiness as a direct-owner state boundary", () => {
    const message: Message = {
      id: "readiness",
      role: "system",
      content: 'Subagent "Validator" is idle and ready for follow-up.',
      timestamp: new Date("2026-07-24T10:00:00.000Z"),
      agentMessage: {
        source: "validator-1",
        sourceLabel: "Validator",
        sourceSessionSource: "subagent",
        kind: "readiness",
        deliveryMode: "queue",
        sequence: 0,
        readinessGeneration: "work-1",
      },
    };

    render(<TimelineBoundary message={message} />);

    expect(screen.getByText("Subagent ready")).toBeInTheDocument();
    expect(screen.getByText("· From Validator")).toBeInTheDocument();
    expect(
      screen.getByText('Subagent "Validator" is idle and ready for follow-up.'),
    ).toBeInTheDocument();
  });

  it("separates and attributes a reviewed continuation without exposing its control prompt", () => {
    const message: Message = {
      id: "continuation",
      role: "user",
      content: "[GOAL CONTINUATION] private control prompt",
      timestamp: new Date("2026-07-24T10:00:00.000Z"),
      goalContinuation: true,
      goalTimelineEvent: {
        type: "goal.continuation",
        fence: goalFence,
        sequence: 2,
        verification: false,
        resumeTrigger: {
          kind: "milestone-available",
          reason: "A delegated subagent reached an idle milestone.",
          milestoneSummary: "Worker is ready for integration.",
          occurredAt: "2026-07-24T10:00:00.000Z",
        },
        durableMilestone: { handoffSummary: "Implementation is ready." },
        agent: {
          sessionId: "parent-1",
          source: "assistant",
          sourceLabel: "Primary agent",
        },
        reviewer: {
          sessionId: "goal:continuation-reviewer",
          source: "reviewer",
          sourceLabel: "Independent continuation reviewer",
          requestedCompaction: false,
        },
      },
    };

    render(<TimelineBoundary message={message} />);

    expect(screen.getByText("Goal continuation 2")).toBeInTheDocument();
    expect(screen.getByText("· Handled by Primary agent")).toBeInTheDocument();
    expect(screen.getByText("· Reviewed by Independent continuation reviewer")).toBeInTheDocument();
    expect(screen.getByText("Worker is ready for integration.")).toBeInTheDocument();
    expect(screen.queryByText(/private control prompt/)).not.toBeInTheDocument();
  });
});
