/**
 * Maps each flowchart node to the elements that light up when it is hovered:
 * itself, its edges, their labels, and the nodes at the other end.
 *
 * Mermaid 11 ids: nodes are `g.node#<svgId>-flowchart-<nodeId>-<n>`, edges are
 * `path[data-edge][data-id="L_<from>_<to>_<n>"]`, and edge labels carry the
 * same data-id on `g.edgeLabel > g.label`. Node ids may contain underscores,
 * so an edge id is split against the set of known node ids.
 */
export function buildHoverGraph(svg: Element): Map<Element, Element[]> {
  const graph = new Map<Element, Element[]>();
  const prefix = `${svg.id}-flowchart-`;
  const nodes = new Map<string, Element>();
  for (const node of svg.querySelectorAll("g.node")) {
    if (!node.id.startsWith(prefix)) continue;
    const nodeId = node.id.slice(prefix.length).replace(/-\d+$/, "");
    nodes.set(nodeId, node);
    graph.set(node, [node]);
  }
  if (nodes.size === 0) return graph;

  const labels = new Map<string, Element>();
  for (const label of svg.querySelectorAll("g.edgeLabel > g.label[data-id]")) {
    const edgeLabel = label.parentElement;
    const edgeId = label.getAttribute("data-id");
    if (edgeLabel && edgeId) labels.set(edgeId, edgeLabel);
  }

  for (const edge of svg.querySelectorAll("path[data-edge][data-id]")) {
    const edgeId = edge.getAttribute("data-id") ?? "";
    const ends = splitEdgeId(edgeId, nodes);
    if (!ends) continue;
    const from = nodes.get(ends[0]);
    const to = nodes.get(ends[1]);
    if (!from || !to) continue;
    const related = [edge, labels.get(edgeId)].filter((element): element is Element =>
      Boolean(element),
    );
    graph.get(from)?.push(...related, to);
    graph.get(to)?.push(...related, from);
  }
  return graph;
}

function splitEdgeId(edgeId: string, nodes: Map<string, Element>): [string, string] | null {
  if (!edgeId.startsWith("L_")) return null;
  const body = edgeId.slice(2).replace(/_\d+$/, "");
  for (const from of nodes.keys()) {
    if (!body.startsWith(`${from}_`)) continue;
    const to = body.slice(from.length + 1);
    if (nodes.has(to)) return [from, to];
  }
  return null;
}

const DIAGRAM_LABELS: [RegExp, string][] = [
  [/^(flowchart|graph)\b/, "Flowchart"],
  [/^sequenceDiagram\b/, "Sequence diagram"],
  [/^classDiagram/, "Class diagram"],
  [/^stateDiagram/, "State diagram"],
  [/^erDiagram\b/, "ER diagram"],
  [/^gantt\b/, "Gantt chart"],
  [/^pie\b/, "Pie chart"],
  [/^journey\b/, "User journey"],
  [/^gitGraph\b/, "Git graph"],
  [/^mindmap\b/, "Mind map"],
  [/^timeline\b/, "Timeline"],
  [/^quadrantChart\b/, "Quadrant chart"],
  [/^xychart/, "XY chart"],
  [/^sankey/, "Sankey diagram"],
  [/^block/, "Block diagram"],
  [/^architecture/, "Architecture diagram"],
];

/** Human label for the diagram type, read from the first meaningful source line. */
export function diagramLabel(source: string): string {
  let inFrontmatter = false;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter || line === "" || line.startsWith("%%")) continue;
    return DIAGRAM_LABELS.find(([pattern]) => pattern.test(line))?.[1] ?? "Diagram";
  }
  return "Diagram";
}
