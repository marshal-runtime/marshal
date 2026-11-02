// marshal-owned renderer test
import { describe, expect, it } from "vitest";

import { friendlyFileType } from "./entity-pill-kind";

describe("friendlyFileType", () => {
  it("labels common office and document formats", () => {
    expect(friendlyFileType("docx")).toBe("Word document");
    expect(friendlyFileType(".xlsx")).toBe("Excel spreadsheet");
    expect(friendlyFileType("pptx")).toBe("PowerPoint presentation");
    expect(friendlyFileType("pdf")).toBe("PDF document");
  });

  it("normalizes CSV extension casing", () => {
    expect(friendlyFileType(".CSV")).toBe("CSV file");
  });

  it("falls back to an extension label for unknown types", () => {
    expect(friendlyFileType("foo")).toBe(".foo file");
  });

  it("labels missing extensions as a generic file", () => {
    expect(friendlyFileType()).toBe("File");
    expect(friendlyFileType("")).toBe("File");
  });
});
