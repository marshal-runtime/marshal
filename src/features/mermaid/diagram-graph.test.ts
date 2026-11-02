import { describe, expect, it } from "vitest";

import { buildHoverGraph, diagramLabel } from "./diagram-graph";

function flowchartSvg(): SVGSVGElement {
  const container = document.createElement("div");
  container.innerHTML = `
    <svg id="d1">
      <g class="node" id="d1-flowchart-run_gate-0"></g>
      <g class="node" id="d1-flowchart-run-1"></g>
      <g class="node" id="d1-flowchart-gate_note-2"></g>
      <g class="node" id="d1-flowchart-orphan-3"></g>
      <path data-edge="true" data-id="L_run_gate_gate_note_0"></path>
      <path data-edge="true" data-id="L_run_run_gate_0"></path>
      <g class="edgeLabel"><g class="label" data-id="L_run_gate_gate_note_0"></g></g>
    </svg>`;
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("fixture missing svg");
  return svg;
}

describe("buildHoverGraph", () => {
  it("links a node to its edges, edge labels, and neighbours, even with underscores in ids", () => {
    const svg = flowchartSvg();
    const graph = buildHoverGraph(svg);
    const byId = (id: string) => svg.querySelector(`[id='${id}'], [data-id='${id}']`);
    const runGate = svg.querySelector("#d1-flowchart-run_gate-0");
    if (!runGate) throw new Error("missing node");

    const related = graph.get(runGate) ?? [];
    expect(related).toContain(runGate);
    expect(related).toContain(byId("L_run_gate_gate_note_0"));
    expect(related).toContain(byId("L_run_run_gate_0"));
    expect(related).toContain(svg.querySelector("g.edgeLabel"));
    expect(related).toContain(svg.querySelector("#d1-flowchart-gate_note-2"));
    expect(related).toContain(svg.querySelector("#d1-flowchart-run-1"));

    const orphan = svg.querySelector("#d1-flowchart-orphan-3");
    if (!orphan) throw new Error("missing node");
    expect(graph.get(orphan)).toEqual([orphan]);
  });

  it("returns an empty graph for diagrams without flowchart nodes", () => {
    const container = document.createElement("div");
    container.innerHTML = '<svg id="seq"><rect class="actor"></rect></svg>';
    const svg = container.querySelector("svg");
    if (!svg) throw new Error("fixture missing svg");
    expect(buildHoverGraph(svg).size).toBe(0);
  });
});

describe("diagramLabel", () => {
  it.each([
    ["flowchart TD\n A-->B", "Flowchart"],
    ["graph LR; A-->B", "Flowchart"],
    ["%% comment\nsequenceDiagram\n A->>B: hi", "Sequence diagram"],
    ["---\ntitle: Deploy\n---\nstateDiagram-v2\n [*] --> A", "State diagram"],
    ["somethingNew\n A", "Diagram"],
  ])("labels %j as %s", (source, label) => {
    expect(diagramLabel(source)).toBe(label);
  });
});
