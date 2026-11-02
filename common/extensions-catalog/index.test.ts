import { describe, expect, it } from "vitest";

import { EXTENSIONS_CATALOG } from "./marshal-extension-catalog";

describe("extensions catalog", () => {
  it("contains the supported bundled skills", () => {
    const ids = EXTENSIONS_CATALOG.map((item) => item.id);
    const names = EXTENSIONS_CATALOG.map((item) => item.name);

    expect(ids).toEqual([
      "skill-docx",
      "skill-pptx",
      "skill-xlsx",
      "skill-excalidraw",
      "skill-web-artifacts-builder",
    ]);
    expect(names).toContain("docx");
    expect(names).toContain("pptx");
    expect(names).toContain("xlsx");
  });
});
