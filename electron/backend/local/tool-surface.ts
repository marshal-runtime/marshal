import type { RuntimeTool } from "../runtime-contract";

export interface RestrictedToolSurface {
  readonly tools: RuntimeTool[];
  /** Strict runtime allowlist; undefined when the session is unrestricted. */
  readonly availableTools: string[] | undefined;
}

/**
 * Narrows a session's host tools to an explicit allowlist. Both the schemas
 * handed to the runtime and the runtime's own allowlist shrink, so runtimes
 * that only honor one of them still stop advertising the excluded tools.
 * Creation fails closed on unknown names; resume drops names that no longer
 * exist rather than leaving an unresumable session.
 */
export function restrictToolSurface(
  tools: readonly RuntimeTool[],
  allowlist: readonly string[] | undefined,
  options: { readonly failOnUnknown: boolean },
): RestrictedToolSurface {
  if (allowlist === undefined) return { tools: [...tools], availableTools: undefined };
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const names = [...new Set(allowlist)];
  const unknown = names.filter((name) => !byName.has(name));
  if (unknown.length > 0 && options.failOnUnknown) {
    throw new Error(`allowedTools contains unknown host tools: ${unknown.join(", ")}`);
  }
  const surface = names.flatMap((name) => {
    const tool = byName.get(name);
    return tool ? [tool] : [];
  });
  return { tools: surface, availableTools: surface.map((tool) => tool.name) };
}
