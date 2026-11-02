/**
 * Hand-crafted Monaco snippet templates for each slash command.
 * Uses tab stops ($1, $2, …) and placeholders (${1:default}) so Tab
 * cycles through all editable sections of the inserted markdown.
 * Commands not listed here fall back to a simple insertion with $0 at end.
 */
export const slashCommandSnippetOverrides: Record<string, string> = {
  "heading-1": "# ${1:Heading}",
  "heading-2": "## ${1:Heading}",
  "heading-3": "### ${1:Heading}",
  "bulleted-list": "- ${1:item}",
  "numbered-list": "1. ${1:item}",
  "todo-list": "- [ ] ${1:task}",
  link: "[${1:text}](${2:url})",
  "code-block": "```${1:language}\n${2:code}\n```",
  table: "| ${1:Col 1} | ${2:Col 2} |\n| --- | --- |\n| ${3:data} | ${4:data} |",
  toggle: "<details>\n<summary>${1:Summary}</summary>\n\n${2:Content}\n\n</details>",
  blockquote: "> ${1:text}",
  callout: "> [!${1:NOTE}]\n> ${2:text}",
  "horizontal-rule": "---\n$0",
};

/** Escape special snippet characters ($, }, \\) in literal text. */
export function escapeSnippet(text: string): string {
  return text.replace(/[$}\\]/g, "\\$&");
}

/** Build a snippet string for a command, using override or falling back to raw markdown. */
export function buildSlashCommandSnippet(id: string, md: string | string[]): string {
  if (id in slashCommandSnippetOverrides) return slashCommandSnippetOverrides[id];
  // Fallback: escape the raw markdown and put cursor at end
  const raw = typeof md === "string" ? md : md.join("\n");
  return escapeSnippet(raw) + "$0";
}
