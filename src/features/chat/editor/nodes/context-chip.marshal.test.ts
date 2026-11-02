// marshal-owned renderer test
import { describe, expect, it } from "vitest";

import { chipMarkdownText, type ContextChipEntity } from "./context-chip";

describe("chipMarkdownText", () => {
  it("renders a person as bold name + invisible mailto marker", () => {
    const entity: ContextChipEntity = {
      type: "People",
      id: "p1",
      displayName: "Alice Smith",
      email: "alice@x.com",
    };
    expect(chipMarkdownText(entity)).toBe("**Alice Smith** <!--ctx:mailto:alice@x.com-->");
  });

  it("renders a person without email as bold name only", () => {
    const entity: ContextChipEntity = { type: "People", id: "p1", displayName: "Anon" };
    expect(chipMarkdownText(entity)).toBe("**Anon**");
  });

  it("renders a file as bold title + invisible URL marker", () => {
    const entity: ContextChipEntity = {
      type: "File",
      id: "f1",
      title: "report.pdf",
      accessUrl: "https://files.example.com/sites/x/report.pdf",
    };
    expect(chipMarkdownText(entity)).toBe(
      "**report.pdf** <!--ctx:https://files.example.com/sites/x/report.pdf-->",
    );
  });

  it("renders a file without accessUrl as bold title only", () => {
    const entity: ContextChipEntity = { type: "File", id: "f1", title: "doc.docx" };
    expect(chipMarkdownText(entity)).toBe("**doc.docx**");
  });
});
