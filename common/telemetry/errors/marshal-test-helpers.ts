import { vi } from "vitest";

import type { TelemetryCallbacks } from "../types";

/**
 * Returns a `TelemetryCallbacks` stub with `registerErrors` as a mock.
 * Centralizes the type-level escape needed because `TelemetryCallbacks`
 * has a wider real surface than the family registration tests need.
 */
export function mockTelemetryCallbacks(): TelemetryCallbacks {
  // eslint-disable-next-line vitest/require-mock-type-parameters
  const stub = { registerErrors: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
  return stub as any;
}
