import assert from "node:assert/strict";
import test from "node:test";

import {
  responseConfirmsSuccess,
  runtimeInvocationSucceeded,
} from "./test-suites/99-marshal-runtime.mjs";

test("rejects a completed runtimeInvoke row whose capability result requires approval", () => {
  assert.equal(
    runtimeInvocationSucceeded({
      ariaLabel: "Runtime invoke, Done",
      details:
        'Output{"content":"{\\"ok\\":false,\\"error\\":{\\"code\\":\\"approval-required\\"}}"}',
    }),
    false,
  );
  assert.equal(
    responseConfirmsSuccess(
      "Capability: code.index.status\nInvocation succeeded: No — interactive approval was required.",
    ),
    false,
  );
});

test("accepts only an affirmative successful runtimeInvoke result and response", () => {
  assert.equal(
    runtimeInvocationSucceeded({
      details:
        'Output{"content":"{\\"ok\\":true,\\"value\\":{\\"state\\":\\"ready\\"},\\"receipts\\":[]}"}',
    }),
    true,
  );
  assert.equal(
    responseConfirmsSuccess("Capability: code.index.status\nInvocation succeeded: Yes"),
    true,
  );
  assert.equal(
    responseConfirmsSuccess(
      "**Capability:** `code.index.status`\n**Invocation:** Succeeded. Returned state: `unavailable`.",
    ),
    true,
  );
});
