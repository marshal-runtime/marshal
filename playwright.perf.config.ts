// Marshal ownership: performance test configuration.
import { defineConfig } from "@playwright/test";

/** Playwright config for performance benchmark tests.
 *  Used by `pnpm run test:perf` — not run in CI.
 *  Perf tests require real Copilot auth and live network access.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.test.perf.ts",
  timeout: 20 * 60_000, // 20 min per test (covers 5 runs × 15 min each + overhead)
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  projects: [{ name: "electron" }],
});
