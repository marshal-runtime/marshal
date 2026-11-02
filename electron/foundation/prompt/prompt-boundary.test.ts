// Marshal ownership: relocated module identity.
import { describe, expect, it } from "vitest";

import { escapeXmlLikeClosingTag, makeClosingTagEscaper } from "./prompt-boundary";

describe("escapeXmlLikeClosingTag", () => {
  it("coerces nullish bodies to an empty string", () => {
    expect(escapeXmlLikeClosingTag("x", null)).toBe("");
    expect(escapeXmlLikeClosingTag("x", undefined)).toBe("");
  });

  it("escapes tag names containing regex metacharacters", () => {
    expect(escapeXmlLikeClosingTag("a.b+c", "before </a.b+c> after")).toBe(
      "before <\\/a.b+c> after",
    );
  });

  it("preserves lookalike closing tags with longer names", () => {
    expect(escapeXmlLikeClosingTag("foo", "before </foobar> after")).toBe("before </foobar> after");
  });

  it("escapes whitespace, case, and attribute-bearing closing-tag variants", () => {
    expect(escapeXmlLikeClosingTag("foo", 'A</FOO >B</foo bar="baz">C')).toBe(
      "A<\\/foo>B<\\/foo>C",
    );
  });
});

describe("makeClosingTagEscaper", () => {
  it("returns a reusable escaper for a fixed tag name", () => {
    const escapeFoo = makeClosingTagEscaper("foo");

    expect(escapeFoo("before </foo> after")).toBe("before <\\/foo> after");
    expect(escapeFoo("before </foobar> after")).toBe("before </foobar> after");
  });
});
