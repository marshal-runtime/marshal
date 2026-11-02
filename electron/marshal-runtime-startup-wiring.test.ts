import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const MAIN_SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "main.ts"),
  "utf8",
);

describe("Marshal Runtime startup failure wiring", () => {
  it("keeps host failures retryable but blocks failed directory prerequisites", () => {
    expect(MAIN_SOURCE).toContain(
      "captureMarshalRuntimeStartupFailure(error, { blockRetry: false });",
    );
    expect(MAIN_SOURCE).toContain(
      "captureMarshalRuntimeStartupFailure(error, { blockRetry: true });",
    );
    expect(MAIN_SOURCE).toContain(
      "if (options.blockRetry) marshalRuntimeHost.blockStartup(error);",
    );
  });

  it("records the bounded nested startup error instead of replacing it", () => {
    expect(MAIN_SOURCE).toContain("const runtimeFailure = summarizeError(error);");
    expect(MAIN_SOURCE).not.toContain('message: "Marshal Runtime host failed to start.",');
  });
});
