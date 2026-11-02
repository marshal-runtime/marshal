import { describe, it, expect } from "vitest";

import { descriptionFromBody, stripYamlQuotes } from "./skill-fields";

describe("stripYamlQuotes", () => {
  it("strips surrounding double quotes", () => {
    expect(stripYamlQuotes('"hello world"')).toBe("hello world");
  });

  it("strips surrounding single quotes", () => {
    expect(stripYamlQuotes("'hello world'")).toBe("hello world");
  });

  it("unescapes backslash-escaped double quotes inside", () => {
    expect(stripYamlQuotes('"say \\"hi\\""')).toBe('say "hi"');
  });

  it("unescapes double backslashes", () => {
    expect(stripYamlQuotes('"C:\\\\Users"')).toBe("C:\\Users");
  });

  it("returns unquoted value unchanged", () => {
    expect(stripYamlQuotes("plain text")).toBe("plain text");
  });

  it("does not strip a single double-quote character", () => {
    expect(stripYamlQuotes('"')).toBe('"');
  });

  it("does not strip a single single-quote character", () => {
    expect(stripYamlQuotes("'")).toBe("'");
  });

  it("handles empty string", () => {
    expect(stripYamlQuotes("")).toBe("");
  });

  it("does not strip mismatched quotes", () => {
    expect(stripYamlQuotes("\"hello'")).toBe("\"hello'");
  });
});

describe("descriptionFromBody", () => {
  it("extracts first non-empty line", () => {
    expect(descriptionFromBody("Automate expense reports.\nMore details here.")).toBe(
      "Automate expense reports.",
    );
  });

  it("skips headings", () => {
    expect(descriptionFromBody("# Instructions\nDo something useful.")).toBe(
      "Do something useful.",
    );
  });

  it("skips blank lines", () => {
    expect(descriptionFromBody("\n\nThe real description.")).toBe("The real description.");
  });

  it("truncates long lines at sentence boundary", () => {
    const long = "A".repeat(50) + ". " + "B".repeat(200);
    expect(descriptionFromBody(long)).toBe("A".repeat(50) + ".");
  });

  it("truncates at short first sentence within limit", () => {
    const long = "Short. " + "B".repeat(250);
    expect(descriptionFromBody(long)).toBe("Short.");
  });

  it("truncates with ellipsis when no sentence boundary", () => {
    const long = "A".repeat(250);
    expect(descriptionFromBody(long)).toBe("A".repeat(200) + "\u2026");
  });

  it("truncates at sentence-ending punctuation at the 200th char", () => {
    const long = "A".repeat(199) + "." + "B".repeat(100);
    expect(descriptionFromBody(long)).toBe("A".repeat(199) + ".");
  });

  it("returns empty string for empty body", () => {
    expect(descriptionFromBody("")).toBe("");
  });

  it("returns empty string for headings-only body", () => {
    expect(descriptionFromBody("# Title\n## Subtitle")).toBe("");
  });
});
