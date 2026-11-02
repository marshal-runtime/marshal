// Marshal-owned module.
import { describe, expect, it } from "vitest";

import { CONTEXT_PICKER_LISTBOX_ID, contextPickerOptionId } from "./picker-option-id";

describe("context picker deterministic option ids", () => {
  it("uses a stable listbox id", () => {
    expect(CONTEXT_PICKER_LISTBOX_ID).toBe("context-picker-listbox");
  });

  it("derives stable option ids from cmdk values", () => {
    expect(contextPickerOptionId("skill-review")).toBe("context-picker-option-skill-review");
    expect(contextPickerOptionId("People:p1")).toBe("context-picker-option-People%3Ap1");
    expect(contextPickerOptionId("File:file/id with spaces")).toBe(
      "context-picker-option-File%3Afile%2Fid%20with%20spaces",
    );
  });
});
