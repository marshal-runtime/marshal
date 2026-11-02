// Owned by the shared Vitest test environment.
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// Some prompt-editor helpers import `act` from `react`, so set this explicitly
// to avoid happy-dom "act(...) not configured" warnings.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- IS_REACT_ACT_ENVIRONMENT is a non-standard global flag added by React for test environments
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});
