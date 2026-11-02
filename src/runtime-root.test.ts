import { describe, expect, it } from "vitest";

import { resolveRuntimeRoot } from "./runtime-root";

describe("runtime renderer roots", () => {
  it("preserves Copilot and Gateway composition", () => {
    expect(resolveRuntimeRoot("copilot")).toBe("copilot");
    expect(resolveRuntimeRoot("gateway")).toBe("gateway");
  });

  it("routes Claude, Codex, and unknown adapters through generic local auth", () => {
    expect(resolveRuntimeRoot("claude")).toBe("local");
    expect(resolveRuntimeRoot("codex")).toBe("local");
    expect(resolveRuntimeRoot("future-runtime")).toBe("local");
  });
});
