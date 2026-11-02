import { builtinModules } from "module";

import { defineConfig } from "vitest/config";

const nodeBuiltinAliases = Object.fromEntries(
  builtinModules
    .filter((m) => !m.startsWith("_") && !m.startsWith("node:"))
    .map((m) => [m, `node:${m}`]),
);

// Replays TLC counterexample traces against the real TypeScript modules.
// Kept out of the main vitest projects on purpose: `pnpm test` stays scoped
// to product tests; run with `pnpm vitest run --config formal/repro/vitest.config.ts`.
export default defineConfig({
  resolve: { alias: nodeBuiltinAliases },
  define: {
    __APP_VERSION__: JSON.stringify("0.0.0-test"),
    __IS_RELEASE_BUILD__: false,
    __MARSHAL_DEV_FEATURES__: false,
  },
  test: {
    name: "formal-repro",
    root: new URL("../..", import.meta.url).pathname,
    environment: "node",
    include: ["formal/repro/**/*.repro.test.ts"],
    testTimeout: 15000,
    retry: 0,
  },
});
