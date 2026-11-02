import type { ExtensionPromptContribution } from "../extension-contributions";

/**
 * Hard routing rule for code questions, emitted only when a healthy extension
 * contributes `knowledge.*` capabilities. Agents otherwise default to grep even
 * with the extension's own guidance in the prompt (2026-09-26 probe).
 */
const CODE_INTELLIGENCE_SECTION = `## Code questions: search the knowledge index first

This workspace has a code knowledge index (\`knowledge.*\`). **Decision rule:** when you need to find where something is implemented, how something works, who calls a symbol, or what a change affects, your first call is \`knowledge.search\` through \`runtimeExecuteTypeScript\`, before \`grep\`, \`rg\`, \`git grep\`, Glob, or opening files:

\`\`\`ts
return (await context.runtime.invoke("knowledge.search", { query: "how are failed message deliveries retried", limit: 10 }))
  .hits.map((hit) => [hit.node.name, hit.node.path, hit.node.id]);
\`\`\`

- Write the query as the question in words, not a regex.
- Read the files the top hits point to. Hit paths start with a \`[workspace-…]\` route tag; drop it to get the repo-relative path.
- \`knowledge.context {target: {kind: "node", id}}\` returns a hit's definition, callers, and callees; \`knowledge.impact {target, direction: "inbound"}\` returns what depends on it.
- Grep stays right for an exact string you already know, or for listing every occurrence once you know what to look for. A grep for several words or \`a|b\` alternatives means you skipped this step.
- Memory hits are notes from earlier sessions; \`knowledge.context\` on one lists the files it links.

### Memories about code are linked memories

Any memory about specific code goes through \`memory.link\`, not \`remember\`: a rule or convention, a decision, who owns an area, a gotcha, or how parts connect across files. You choose the links: the files and symbols the memory explains, which you usually just read. \`memory.link\` stores and links in one call, so it fits in the block where you found the files:

\`\`\`ts
return await context.runtime.invoke("memory.link", {
  content: "Retries: the scheduler re-queues failed deliveries; the worker backs off per config/retry.yaml.",
  key: "v1:delivery/retries",
  links: [{ path: "services/scheduler/queue.go", symbol: "Requeue" }, { path: "config/retry.yaml" }],
});
\`\`\`

- Paths are repo-relative; SQL, YAML and Markdown files can be linked too. Each link becomes a graph edge that search, context and impact follow. Check \`links[].linked\` in the result and fix any path that did not link.
- Reusing a key replaces that memory. To convert a plain memory, save it with \`memory.link\`, then \`forget\` the old id.
- When a task made you trace a flow across several files, save that flow once before you finish, so the next session starts with the map.
- \`remember\` stays right for preferences and facts that are not about code.`;

export function hasCodeIntelligence(
  contributions: ReadonlyArray<ExtensionPromptContribution>,
): boolean {
  return contributions.some(
    (contribution) =>
      contribution.health === "healthy" &&
      contribution.capabilityPrefixes.some((prefix) => prefix.startsWith("knowledge.")),
  );
}

export function buildCodeIntelligenceSection(enabled: boolean): string {
  return enabled ? CODE_INTELLIGENCE_SECTION : "";
}
