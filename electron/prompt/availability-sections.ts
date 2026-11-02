/**
 * Availability-gated guidance blocks shared by the legacy composer
 * (electron/system-message.ts) and the replacement assembler
 * (electron/prompt/assemble.ts). Single source: never duplicate these texts.
 * Each builder returns "" when the capability is unavailable, so the prompt
 * never carries eager guidance for tools the policy would deny.
 */

export function buildBrowserGuidanceSection(browserDisabled: boolean): string {
  return browserDisabled
    ? ""
    : `\n\n## Browser Control and Web Browsing\n\n### Performance tips\n- Use \`browser_navigate\` to navigate to URLs — it reuses the existing browser session and is fast.\n- Never call \`browser_close\` just to navigate to a new URL; \`browser_navigate\` handles all navigation without restarting the browser.\n\n### Efficient multi-step browser interactions\nWhen a task requires multiple browser actions (e.g. navigate, fill a form, click submit):\n1. Plan all steps up front before executing any.\n2. Execute steps in rapid sequence without stopping to snapshot between each one — only call \`browser_snapshot\` when you need to discover unknown element refs or verify a result.\n3. If you already know the page structure from a previous snapshot, act on the known refs immediately without re-snapshotting.`;
}

/**
 * Visualization guidance — the renderer always supports rich markdown, so this
 * block is unconditional. Restored per the coverage audit (B6): the legacy
 * composer never carried it.
 */
export const VISUALIZATION_GUIDANCE = `\n\n## Visualizations

Use a visualization when it presents information more clearly than prose — comparisons, schedules, flows, and structures the user would otherwise have to reconstruct mentally. The user does not need to ask. Use tables for mappings and comparisons; use Mermaid diagrams for small, static structure or flow explanations that a picture genuinely clarifies; render generated images inline per the interface rules; when \`runtimeShowUi\` is available, any table longer than 15 rows goes into a sortable \`runtimeShowUi\` data-table instead of markdown, and you create a view for data the user will sort, filter, or watch update, and for any custom visual that shows them what they need better than chat can (see the runtime section for triggers). Skip visuals for single facts, one-step actions, simple edits, and anything already clear in a short paragraph — compact notation and small inline examples are not visualizations and need no ceremony.`;
