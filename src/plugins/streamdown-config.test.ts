import { describe, it, expect } from "vitest";

vi.mock("streamdown", () => ({
  parseMarkdownIntoBlocks: (md: string) => [md], // identity for testing
}));

import { vi } from "vitest";

import { isTrustedLink } from "./link-safety";
import { parseMarshalMarkdownBlocks } from "./marshal-content/markdown/local-image-block-parser";

describe("parseMarshalMarkdownBlocks (encodeLocalImagePaths)", () => {
  function encode(text: string): string {
    // parseMarshalMarkdownBlocks wraps encodeLocalImagePaths + parseMarkdownIntoBlocks
    // Since our mock parseMarkdownIntoBlocks returns [text], we get back [encoded]
    return parseMarshalMarkdownBlocks(text)[0];
  }

  it("encodes spaces in file:/// image URLs", () => {
    const input = "![alt](file:///C:/Users/alice/My Files/Documents/Marshal/export.png)";
    expect(encode(input)).toBe(
      "![alt](file:///C:/Users/alice/My%20Files/Documents/Marshal/export.png)",
    );
  });

  describe("isTrustedLink", () => {
    it.each([
      "http://example.com",
      "https://example.com/path",
      "mailto:user@example.com",
      "local-file:///C:/docs/readme.txt",
    ])("allows direct navigation without a confirmation prompt for %s", (url) => {
      expect(isTrustedLink(url)).toBe(true);
    });

    it.each([["javascript", "alert(1)"].join(":"), "data:text/html,test", "file:///etc/passwd"])(
      "keeps untrusted schemes behind link safety: %s",
      (url) => {
        expect(isTrustedLink(url)).toBe(false);
      },
    );
  });

  it("encodes spaces in Windows paths", () => {
    const input = "![chart](C:\\My Files\\diagram.png)";
    expect(encode(input)).toBe("![chart](C:\\My%20Files\\diagram.png)");
  });

  it("does NOT modify URLs without spaces", () => {
    const input = "![ok](file:///C:/Users/test/image.png)";
    expect(encode(input)).toBe(input);
  });

  it("does NOT modify already-encoded URLs", () => {
    const input = "![ok](file:///C:/My%20Files/img.png)";
    expect(encode(input)).toBe(input);
  });

  it("does NOT encode spaces in non-local URLs", () => {
    const input = "![pic](https://example.com/path with spaces/img.png)";
    expect(encode(input)).toBe(input);
  });

  it("does NOT encode spaces for non-image extensions", () => {
    const input = "![doc](file:///C:/My Files/secret.txt)";
    expect(encode(input)).toBe(input);
  });

  it("handles multiple images in one string", () => {
    const input = [
      "Here: ![a](file:///C:/My Docs/a.png)",
      "And: ![b](file:///C:/Other Path/b.jpg)",
    ].join("\n");
    const result = encode(input);
    expect(result).toContain("My%20Docs");
    expect(result).toContain("Other%20Path");
  });

  it("preserves surrounding text", () => {
    const input = "Check this ![diagram](file:///C:/My Files/d.png) for details";
    expect(encode(input)).toBe("Check this ![diagram](file:///C:/My%20Files/d.png) for details");
  });

  it("is case-insensitive for extensions", () => {
    expect(encode("![a](file:///C:/My Dir/img.PNG)")).toContain("My%20Dir");
    expect(encode("![a](file:///C:/My Dir/img.Jpeg)")).toContain("My%20Dir");
  });
});
