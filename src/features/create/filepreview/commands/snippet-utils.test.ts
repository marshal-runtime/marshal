import { describe, it, expect } from "vitest";

import { createSlashCommands } from "./command-catalog";
import {
  slashCommandSnippetOverrides,
  escapeSnippet,
  buildSlashCommandSnippet,
} from "./snippet-utils";

// ── Tests ───────────────────────────────────────────────────────

describe("escapeSnippet", () => {
  it("escapes $ signs", () => {
    expect(escapeSnippet("$100")).toBe("\\$100");
  });

  it("escapes closing braces", () => {
    expect(escapeSnippet("a}b")).toBe("a\\}b");
  });

  it("escapes backslashes", () => {
    expect(escapeSnippet("a\\b")).toBe("a\\\\b");
  });

  it("leaves normal text unchanged", () => {
    expect(escapeSnippet("Hello world")).toBe("Hello world");
  });

  it("escapes multiple special chars in one string", () => {
    // Only $, }, and \ are escaped — { is not a snippet special char
    expect(escapeSnippet("${foo}")).toBe("\\${foo\\}");
  });
});

describe("slashCommandSnippetOverrides", () => {
  it("covers every slash command except comment", () => {
    const commandIds = createSlashCommands.filter((c) => c.id !== "comment").map((c) => c.id);
    for (const id of commandIds) {
      expect(slashCommandSnippetOverrides).toHaveProperty(id);
    }
  });
});

describe("buildSlashCommandSnippet", () => {
  it("returns override for known commands", () => {
    expect(buildSlashCommandSnippet("heading-1", "# ")).toBe("# ${1:Heading}");
    expect(buildSlashCommandSnippet("link", "[text](url)")).toBe("[${1:text}](${2:url})");
  });

  it("returns escaped markdown with $0 for unknown commands", () => {
    expect(buildSlashCommandSnippet("unknown-cmd", "some text")).toBe("some text$0");
  });

  it("escapes special chars in fallback", () => {
    expect(buildSlashCommandSnippet("unknown-cmd", "$pecial")).toBe("\\$pecial$0");
  });

  it("joins multi-line markdown in fallback", () => {
    expect(buildSlashCommandSnippet("unknown-cmd", ["line1", "line2"])).toBe("line1\nline2$0");
  });
});

describe("snippet tab stop structure", () => {
  it("link has two tab stops for text and url", () => {
    const snippet = slashCommandSnippetOverrides["link"];
    expect(snippet).toContain("${1:");
    expect(snippet).toContain("${2:");
    expect(snippet).toBe("[${1:text}](${2:url})");
  });

  it("table has four tab stops for headers and data", () => {
    const snippet = slashCommandSnippetOverrides["table"];
    expect(snippet).toContain("${1:Col 1}");
    expect(snippet).toContain("${2:Col 2}");
    expect(snippet).toContain("${3:data}");
    expect(snippet).toContain("${4:data}");
  });

  it("code-block has tab stops for language and code body", () => {
    const snippet = slashCommandSnippetOverrides["code-block"];
    expect(snippet).toContain("${1:language}");
    expect(snippet).toContain("${2:code}");
    expect(snippet).toMatch(/^```\$\{1:language\}\n\$\{2:code\}\n```$/);
  });

  it("toggle has tab stops for summary and content", () => {
    const snippet = slashCommandSnippetOverrides["toggle"];
    expect(snippet).toContain("${1:Summary}");
    expect(snippet).toContain("${2:Content}");
  });

  it("callout has tab stops for type and text", () => {
    const snippet = slashCommandSnippetOverrides["callout"];
    expect(snippet).toContain("${1:NOTE}");
    expect(snippet).toContain("${2:text}");
  });

  it("todo-list has a tab stop for the task text", () => {
    const snippet = slashCommandSnippetOverrides["todo-list"];
    expect(snippet).toBe("- [ ] ${1:task}");
  });

  it("headings have a single tab stop for heading text", () => {
    expect(slashCommandSnippetOverrides["heading-1"]).toBe("# ${1:Heading}");
    expect(slashCommandSnippetOverrides["heading-2"]).toBe("## ${1:Heading}");
    expect(slashCommandSnippetOverrides["heading-3"]).toBe("### ${1:Heading}");
  });

  it("horizontal-rule uses $0 (final cursor) after the rule", () => {
    const snippet = slashCommandSnippetOverrides["horizontal-rule"];
    expect(snippet).toBe("---\n$0");
  });

  it("blockquote has a single tab stop", () => {
    expect(slashCommandSnippetOverrides["blockquote"]).toBe("> ${1:text}");
  });
});
