import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { render, screen } from "@/test-utils";

import type { TimelineRun } from "../hooks/useTimeline";
import { Timeline } from "./Timeline";

function makeRuns(count: number): TimelineRun[] {
  return Array.from({ length: count }, (_, index) => ({
    role: "user" as const,
    items: [
      {
        kind: "message" as const,
        data: {
          id: `message-${index}`,
          role: "user" as const,
          content: `Message ${index}`,
          timestamp: new Date(2026, 0, 1, 0, index),
        },
      },
    ],
  }));
}

describe("Timeline virtualization", () => {
  it("keeps the mounted DOM bounded for 100 runs", async () => {
    const scrollRef = createRef<HTMLDivElement>();
    render(
      <div ref={scrollRef} style={{ height: 800, overflow: "auto" }}>
        <Timeline
          runs={makeRuns(100)}
          scrollRef={scrollRef}
          onPermissionRespond={vi.fn<() => void>()}
        />
      </div>,
    );

    const rows = await screen.findAllByTestId("timeline-virtual-row");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(24);
    expect(screen.queryByText("Message 99")).not.toBeInTheDocument();
  });
});
