import { describe, expect, it } from "vitest";

import { stripCtxMarkers } from "./editor-support";

describe("stripCtxMarkers", () => {
  it("removes a person marker with leading space", () => {
    expect(stripCtxMarkers("**Alice** <!--ctx:mailto:alice@x.com-->")).toBe("**Alice**");
  });

  it("removes a file marker with leading space", () => {
    expect(stripCtxMarkers("**doc.docx** <!--ctx:https://files/doc.docx-->")).toBe("**doc.docx**");
  });

  it("removes consecutive markers in a longer prompt", () => {
    const input =
      "Hi **Alice** <!--ctx:mailto:alice@x.com--> please review **doc** <!--ctx:https://x/doc--> today";
    expect(stripCtxMarkers(input)).toBe("Hi **Alice** please review **doc** today");
  });

  it("returns input unchanged when no marker is present", () => {
    expect(stripCtxMarkers("just a normal message")).toBe("just a normal message");
  });

  it("removes a marker without a leading space", () => {
    expect(stripCtxMarkers("**Alice**<!--ctx:mailto:alice@x.com-->!")).toBe("**Alice**!");
  });

  it("ignores non-ctx HTML comments", () => {
    expect(stripCtxMarkers("text <!-- not a ctx --> more")).toBe("text <!-- not a ctx --> more");
  });

  it("handles URLs containing dashes / slashes", () => {
    expect(
      stripCtxMarkers("**file** <!--ctx:https://files.example.com/sites/x-y/file.pdf-->"),
    ).toBe("**file**");
  });
});
