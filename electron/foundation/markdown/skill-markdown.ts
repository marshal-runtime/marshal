import { stripYamlQuotes } from "../yaml/skill-fields";

// Parse SKILL.md with optional YAML frontmatter into name/description/instructions.
// Used for user-imported skills (import-file / import-url).
export function parseSkillMarkdown(content: string): {
  name: string;
  description: string;
  instructions: string;
} {
  const normalized = normalizeMarkdownNewlines(content);
  const frontmatterMatch = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    const body = frontmatterMatch[2].trim();
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
    return {
      name: stripYamlQuotes(nameMatch?.[1]?.trim() || "imported-skill"),
      description: stripYamlQuotes(descMatch?.[1]?.trim() || body.slice(0, 100)),
      instructions: body || normalized,
    };
  }

  function normalizeMarkdownNewlines(markdown: string): string {
    return markdown.replace(/\r\n/g, "\n");
  }
  // No frontmatter — derive name from first heading or use fallback
  const headingMatch = normalized.match(/^#\s+(.+)$/m);
  return {
    name: (headingMatch?.[1] || "imported-skill").toLowerCase().replace(/\s+/g, "-"),
    description: normalized.slice(0, 100).replace(/\n/g, " ").trim(),
    instructions: normalized,
  };
}
