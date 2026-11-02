import { describe, expect, it } from "vitest";

import type { MarshalRuntimeApiResult, MarshalRuntimeInvocationValue } from "./contracts";
import { compactTypeScriptExecutionResult } from "./typescript-tool-result";

function succeeded(output: unknown): MarshalRuntimeApiResult<MarshalRuntimeInvocationValue> {
  return {
    ok: true,
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only output is read by the compactor
    value: { output, result: { output } } as unknown as MarshalRuntimeInvocationValue,
    receipts: [],
  };
}

describe("compactTypeScriptExecutionResult", () => {
  it("returns only the value and non-empty streams on success", () => {
    const compact = compactTypeScriptExecutionResult(
      succeeded({
        ok: true,
        status: "succeeded",
        value: { rows: 3 },
        stdout: "log\n",
        stderr: "",
        environment: { nodeVersion: "v24" },
        compilation: { cacheKey: "sha256:x" },
      }),
    );
    expect(compact).toEqual({ ok: true, value: { rows: 3 }, stdout: "log\n" });
  });

  it("surfaces compile failures with source positions", () => {
    const compact = compactTypeScriptExecutionResult(
      succeeded({
        ok: false,
        status: "compile_failed",
        error: {
          code: "COMPILE_ERROR",
          message: "Type 'string' is not assignable to type 'number'.",
          stage: "compile",
        },
        diagnostics: [
          {
            level: "error",
            code: "TS2322",
            message: "Type 'string' is not assignable to type 'number'.",
            stage: "compile",
            location: { file: "/runtime/inline-module.ts", line: 2, column: 9 },
          },
        ],
        stdout: "",
        stderr: "",
      }),
    );
    expect(compact).toEqual({
      ok: false,
      status: "compile_failed",
      error: {
        code: "COMPILE_ERROR",
        message: "Type 'string' is not assignable to type 'number'.",
      },
      diagnostics: [
        {
          line: 2,
          column: 9,
          code: "TS2322",
          message: "Type 'string' is not assignable to type 'number'.",
        },
      ],
    });
  });

  it("drops bundle-relative positions from runtime failures but keeps output", () => {
    const compact = compactTypeScriptExecutionResult(
      succeeded({
        ok: false,
        status: "runtime_failed",
        error: {
          code: "RUNTIME_ERROR",
          message: "boom",
          stage: "execute",
          stack: "Error: boom\n at worker.mjs:1",
        },
        diagnostics: [
          {
            code: "RUNTIME_ERROR",
            message: "boom",
            stage: "execute",
            location: { line: 38, column: 9 },
          },
        ],
        stdout: "partial\n",
      }),
    );
    expect(compact).toEqual({
      ok: false,
      status: "runtime_failed",
      error: { code: "RUNTIME_ERROR", message: "boom" },
      diagnostics: [{ code: "RUNTIME_ERROR", message: "boom" }],
      stdout: "partial\n",
    });
  });

  it("passes API-level failures through without receipts", () => {
    const compact = compactTypeScriptExecutionResult({
      ok: false,
      error: { code: "permission-denied", message: "denied" },
      receipts: [],
    });
    expect(compact).toEqual({ ok: false, error: { code: "permission-denied", message: "denied" } });
  });
});
