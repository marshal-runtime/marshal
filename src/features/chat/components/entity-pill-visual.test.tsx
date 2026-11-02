import { describe, expect, it } from "vitest";

import { render } from "@/test-utils";

import { FileExtensionIcon } from "./entity-pill-visual";

const PDF_EXTENSION = "pdf";
const SPREADSHEET_EXTENSION = "xlsx";
const UNKNOWN_EXTENSION = "zzz";

describe("FileExtensionIcon", () => {
  it("renders distinct Phosphor glyphs for known file types and the generic fallback", () => {
    const pdf = render(<FileExtensionIcon extension={PDF_EXTENSION} />)
      .container.querySelector("svg")
      ?.innerHTML;
    const spreadsheet = render(<FileExtensionIcon extension={SPREADSHEET_EXTENSION} />)
      .container.querySelector("svg")
      ?.innerHTML;
    const unknown = render(<FileExtensionIcon extension={UNKNOWN_EXTENSION} />)
      .container.querySelector("svg")
      ?.innerHTML;

    expect(pdf).toBeTruthy();
    expect(spreadsheet).toBeTruthy();
    expect(unknown).toBeTruthy();
    expect(pdf).not.toEqual(spreadsheet);
    expect(pdf).not.toEqual(unknown);
    expect(spreadsheet).not.toEqual(unknown);
  });
});
