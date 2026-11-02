import { useState } from "react";
import { describe, expect, it } from "vitest";

import { render, screen, userEvent } from "@/test-utils";

import { createTimelineFilterState, type TimelineFilterState } from "../state/timelineFilters";
import { TimelineFilters } from "./TimelineFilters";

function FilterHarness() {
  const [filter, setFilter] = useState<TimelineFilterState>(createTimelineFilterState);
  return (
    <TimelineFilters
      filter={filter}
      subagents={[
        { id: "subagent-1", name: "Research helper", source: "subagent" },
        { id: "subagent-2", name: "Verifier", source: "subagent" },
      ]}
      visibleCount={3}
      totalCount={6}
      onChange={setFilter}
    />
  );
}

describe("TimelineFilters", () => {
  it("toggles categories and resets to the all state", async () => {
    const user = userEvent.setup();
    render(<FilterHarness />);

    await user.click(screen.getByRole("button", { name: "Filter timeline" }));
    await user.click(screen.getByRole("checkbox", { name: "Assistant" }));

    expect(screen.getByRole("button", { name: "Filter timeline, 1 active" })).toBeInTheDocument();
    expect(screen.getByText("3 of 6")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByRole("button", { name: "Filter timeline" })).toBeInTheDocument();
    expect(screen.queryByText("3 of 6")).not.toBeInTheDocument();
  });

  it("selects an individual named subagent", async () => {
    const user = userEvent.setup();
    render(<FilterHarness />);

    await user.click(screen.getByRole("button", { name: "Filter timeline" }));
    await user.click(screen.getByRole("checkbox", { name: "Agents & reviewers" }));
    await user.click(screen.getByRole("combobox", { name: "Named agent or reviewer" }));
    await user.click(screen.getByRole("option", { name: "Verifier" }));

    expect(screen.getByRole("combobox", { name: "Named agent or reviewer" })).toHaveTextContent(
      "Verifier",
    );
    expect(screen.getByRole("checkbox", { name: "Agents & reviewers" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Filter timeline, 1 active" })).toBeInTheDocument();
  });

  it("accepts local date-time bounds and exposes reversed-range validation", async () => {
    const user = userEvent.setup();
    render(<FilterHarness />);

    await user.click(screen.getByRole("button", { name: "Filter timeline" }));
    await user.type(screen.getByLabelText("From"), "2026-07-24T12:11");
    await user.type(screen.getByLabelText("To"), "2026-07-24T12:10");

    expect(screen.getByRole("alert")).toHaveTextContent("Start must be before end");
    expect(screen.getByLabelText("From")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Filter timeline, 2 active" })).toBeInTheDocument();
  });

  it("returns focus on keyboard close and exposes a compact clear action", async () => {
    const user = userEvent.setup();
    render(<FilterHarness />);
    const trigger = screen.getByRole("button", { name: "Filter timeline" });
    trigger.focus();

    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("checkbox", { name: "Assistant" }));
    await user.keyboard("{Escape}");

    expect(trigger).toHaveFocus();
    expect(screen.getByRole("button", { name: "Clear timeline filters" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear timeline filters" }));
    expect(screen.getByRole("button", { name: "Filter timeline" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear timeline filters" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the filter surface viewport bounded", async () => {
    const user = userEvent.setup();
    render(<FilterHarness />);

    await user.click(screen.getByRole("button", { name: "Filter timeline" }));

    expect(screen.getByTestId("timeline-filter-popover")).toHaveClass(
      "max-h-[calc(100vh-1rem)]",
      "overflow-y-auto",
    );
  });
});
