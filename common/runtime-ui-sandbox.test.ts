import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { RUNTIME_UI_SANDBOX_BOOTSTRAP, RUNTIME_UI_SANDBOX_CSP_SOURCE } from "./runtime-ui-sandbox";

it("pins the only permitted inline sandbox bootstrap to its exact script bytes", () => {
  expect(RUNTIME_UI_SANDBOX_CSP_SOURCE).toBe(
    `'sha256-${createHash("sha256").update(RUNTIME_UI_SANDBOX_BOOTSTRAP).digest("base64")}'`,
  );
});
