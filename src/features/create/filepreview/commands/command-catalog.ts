import type { MarshalIcon } from "@/components/icons";
import {
  MessageSquare,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Square,
  ChevronRight,
  Code,
  Table,
  TextQuote,
  Lightbulb,
  Minus,
  Link,
} from "@/components/icons";

export interface SlashCommandItem {
  id: string;
  label: string;
  icon: MarshalIcon;
  /** Extra keywords for fuzzy search (beyond label) */
  keywords: string[];
  /** The markdown to insert. If string, single-line replacement. */
  markdown: string | string[];
  /**
   * Where to place cursor after insertion.
   * - "end": after the inserted prefix on same line (default for single-line)
   * - number: activate line at this offset from the insertion point
   * - "select:start:end": select a range within the first inserted line
   */
  cursor?: "end" | number | `select:${number}:${number}`;
}

export const createSlashCommands: SlashCommandItem[] = [
  {
    id: "comment",
    label: "Comment",
    icon: MessageSquare,
    keywords: ["hidden", "note", "invisible", "html", "annotation"],
    markdown: "", // Handled specially via addComment()
  },
  {
    id: "heading-1",
    label: "Heading 1",
    icon: Heading1,
    keywords: ["h1", "title"],
    markdown: "# ",
    cursor: "end",
  },
  {
    id: "heading-2",
    label: "Heading 2",
    icon: Heading2,
    keywords: ["h2", "subtitle"],
    markdown: "## ",
    cursor: "end",
  },
  {
    id: "heading-3",
    label: "Heading 3",
    icon: Heading3,
    keywords: ["h3"],
    markdown: "### ",
    cursor: "end",
  },
  {
    id: "bulleted-list",
    label: "Bulleted list",
    icon: List,
    keywords: ["ul", "unordered", "bullet"],
    markdown: "- ",
    cursor: "end",
  },
  {
    id: "numbered-list",
    label: "Numbered list",
    icon: ListOrdered,
    keywords: ["ol", "ordered", "number"],
    markdown: "1. ",
    cursor: "end",
  },
  {
    id: "todo-list",
    label: "To-do list",
    icon: Square,
    keywords: ["checkbox", "task", "todo"],
    markdown: "- [ ] ",
    cursor: "end",
  },
  {
    id: "toggle",
    label: "Toggle",
    icon: ChevronRight,
    keywords: ["details", "collapse", "expand", "accordion"],
    markdown: ["<details>", "<summary>Toggle</summary>", "", "</details>"],
    cursor: "select:9:15", // select "Toggle" in "<summary>Toggle</summary>"
  },
  {
    id: "code-block",
    label: "Code Block",
    icon: Code,
    keywords: ["fence", "pre", "code"],
    markdown: ["```", "", "```"],
    cursor: 1, // activate the blank line inside the fence
  },
  {
    id: "table",
    label: "Table",
    icon: Table,
    keywords: ["grid", "columns", "rows"],
    markdown: ["| Col 1 | Col 2 |", "| --- | --- |", "|  |  |"],
    cursor: 0, // activate header row for editing
  },
  {
    id: "blockquote",
    label: "Blockquote",
    icon: TextQuote,
    keywords: ["quote", "cite"],
    markdown: "> ",
    cursor: "end",
  },
  {
    id: "callout",
    label: "Callout",
    icon: Lightbulb,
    keywords: ["note", "info", "warning", "tip", "admonition"],
    markdown: ["> [!NOTE]", "> "],
    cursor: 1, // activate second line after "> "
  },
  {
    id: "horizontal-rule",
    label: "Horizontal rule",
    icon: Minus,
    keywords: ["hr", "divider", "separator", "line"],
    markdown: ["---", ""],
    cursor: 1, // activate blank line after rule
  },
  {
    id: "link",
    label: "Link",
    icon: Link,
    keywords: ["url", "href", "anchor"],
    markdown: "[text](url)",
    cursor: "select:1:5", // select "text" inside [text](url)
  },
];
