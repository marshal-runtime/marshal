// Marshal-owned test
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../common/marshal-logger";
import { addDiagnosticLogSink } from "./diagnostic-log-sink";
import { writeDiagnosticEntry } from "./diagnostic-logger";

vi.mock("./diagnostic-logger", () => ({
  writeDiagnosticEntry:
    vi.fn<
      (entry: {
        level: "error" | "warn" | "info";
        category: string;
        message: string;
        metadata?: Record<string, unknown>;
      }) => void
    >(),
}));

describe("addDiagnosticLogSink", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes object log args into the diagnostic JSONL message", () => {
    const remove = addDiagnosticLogSink();
    try {
      createLogger("Test").info("usage", { model: "gpt-4o", inputTokens: 1200 });

      expect(writeDiagnosticEntry).toHaveBeenCalledWith({
        level: "info",
        category: "Test",
        message: 'usage {"model":"gpt-4o","inputTokens":1200}',
        metadata: undefined,
      });
    } finally {
      remove();
    }
  });
});
