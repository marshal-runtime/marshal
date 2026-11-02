import { defineConfig } from "@playwright/test";

// Live harness specs throw at load time unless their run-root env is set by the
// dedicated launcher (scripts/runtime-acceptance/run.mjs or the manual command
// in each spec header), so the default run skips them.
const RUNTIME_ACCEPTANCE_SPECS = [
  "**/marshal-runtime-live.test.ts",
  "**/marshal-runtime-live-actors.test.ts",
  "**/marshal-runtime-live-agt-mem-brn-rec.test.ts",
  "**/marshal-runtime-live-stories.test.ts",
  "**/marshal-runtime-live-ui-api-ctx.test.ts",
];
const PLACEMENT_SPECS = [
  "**/authored-render-placement.marshal.test.ts",
  "**/session-cards.marshal.test.ts",
  "**/session-dock-clipping.marshal.test.ts",
  "**/session-dock.marshal.test.ts",
  "**/session-phone-views.marshal.test.ts",
  "**/session-slot-reply.marshal.test.ts",
];

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.test.ts", // *.test.perf.ts files don't match this pattern — no testIgnore needed
  testIgnore: [
    ...(process.env.MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT ? [] : RUNTIME_ACCEPTANCE_SPECS),
    ...(process.env.MARSHAL_PLACEMENT_RUN_ROOT ? [] : PLACEMENT_SPECS),
  ],
  timeout: 60_000,
  expect: { timeout: 10_000 }, // Global assertion timeout (Electron app can be slow to render)
  // Local: 4 workers for parallel speed. CI: serial — parallel Electron launches
  // cause ECONNRESET on both GH Actions (windows-latest) and ADO hosted agents.
  // Per-worker data dirs (MARSHAL_E2E_WORKER) are in place for future parallelism.
  workers: process.env.CI ? 1 : 4,
  retries: 2,
  reporter: [["html", { open: "never" }], ["list"]],
  projects: [{ name: "electron" }],
});
