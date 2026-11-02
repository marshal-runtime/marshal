import { describe, expect, it } from "vitest";

import { splitMessageSlots } from "./messageSlots";

describe("splitMessageSlots", () => {
  it("returns plain markdown untouched", () => {
    expect(splitMessageSlots("Hello <!-- note --> world")).toEqual([
      { kind: "markdown", key: "md-0", text: "Hello <!-- note --> world" },
    ]);
  });

  it("splits own-line placeholders and keys repeated slots by occurrence", () => {
    const segments = splitMessageSlots(
      "Intro\n<!--ui:chart-->\nMiddle\n  <!-- ui:chart -->\nEnd <!--ui:inline-->",
    );
    expect(segments).toEqual([
      { kind: "markdown", key: "md-0", text: "Intro" },
      { kind: "slot", key: "slot-chart-0", name: "chart" },
      { kind: "markdown", key: "md-1", text: "Middle" },
      { kind: "slot", key: "slot-chart-1", name: "chart" },
      { kind: "markdown", key: "md-2", text: "End <!--ui:inline-->" },
    ]);
  });

  it("leaves placeholders inside code fences as text", () => {
    const content = "```md\n<!--ui:demo-->\n```\n<!--ui:live-->";
    expect(splitMessageSlots(content)).toEqual([
      { kind: "markdown", key: "md-0", text: "```md\n<!--ui:demo-->\n```" },
      { kind: "slot", key: "slot-live-0", name: "live" },
    ]);
  });

  it("keeps earlier keys stable while a streaming message grows", () => {
    const partial = splitMessageSlots("A\n<!--ui:one-->\nB");
    const grown = splitMessageSlots("A\n<!--ui:one-->\nB\n<!--ui:two-->\nC");
    expect(grown.slice(0, partial.length).map((segment) => segment.key)).toEqual(
      partial.map((segment) => segment.key),
    );
  });
});
