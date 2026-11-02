/**
 * Renderer-wide cache of compiled authored components. A component id is a
 * content digest, so its HTML never changes; caching it lets a remounted view
 * (a card scrolled back into the timeline, a tab moved to another dock, a phone
 * sheet reopened) ask the runtime for its payload with `knownComponentId` and
 * receive everything except the component document itself.
 */
const MAX_COMPONENTS = 12;

const componentHtml = new Map<string, string>();
const componentByRender = new Map<string, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function remember(renderId: string, componentId: string, html: string): void {
  componentHtml.delete(componentId);
  componentHtml.set(componentId, html);
  componentByRender.set(renderId, componentId);
  while (componentHtml.size > MAX_COMPONENTS) {
    const oldest = componentHtml.keys().next().value;
    if (oldest === undefined) break;
    componentHtml.delete(oldest);
  }
}

/** Adds `knownComponentId` when this render's current component is cached. */
export function withCachedComponent(
  renderId: string,
  input: Record<string, unknown>,
): { readonly input: Record<string, unknown>; readonly fromCache: boolean } {
  const known = componentByRender.get(renderId);
  if (input.knownComponentId !== undefined || !known || !componentHtml.has(known)) {
    return { input, fromCache: false };
  }
  return { input: { ...input, knownComponentId: known }, fromCache: true };
}

/**
 * Remembers a delivered component, and restores the document the runtime
 * omitted because this cache offered it. A payload the renderer template
 * itself marked as known (a live-workspace poll) passes through untouched.
 */
export function reconcileCachedComponent(
  renderId: string,
  output: Record<string, unknown>,
  fromCache: boolean,
): Record<string, unknown> {
  const structured = isRecord(output.structuredContent) ? output.structuredContent : undefined;
  const marshal = structured && isRecord(structured.marshal) ? structured.marshal : undefined;
  if (
    !structured ||
    !marshal ||
    marshal.kind !== "compiled_react_ui" ||
    typeof marshal.componentId !== "string" ||
    typeof marshal.componentHtml !== "string"
  ) {
    return output;
  }
  if (marshal.componentHtml) {
    remember(renderId, marshal.componentId, marshal.componentHtml);
    return output;
  }
  const cached = fromCache ? componentHtml.get(marshal.componentId) : undefined;
  if (cached === undefined) return output;
  remember(renderId, marshal.componentId, cached);
  return {
    ...output,
    structuredContent: { ...structured, marshal: { ...marshal, componentHtml: cached } },
  };
}
