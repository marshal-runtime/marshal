import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Isolated Vitest project for D4's deterministic native-frame regression
// suite (Field Guide decision 5 / AUDIT-VERDICT-AND-ACCEPTANCE.md point 4).
// Kept out of the repo's main vitest.config.ts on purpose: this facility
// owns host-smoke/acceptance-facility/** only and must not add includes to
// shared config another lane could collide with. Run directly:
//   pnpm exec vitest run --config host-smoke/acceptance-facility/native-frame/vitest.config.ts
export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  define: {
    __APP_VERSION__: JSON.stringify("acceptance-facility"),
    __IS_RELEASE_BUILD__: false,
    __MARSHAL_DEV_FEATURES__: false,
  },
  test: {
    name: "acceptance-facility-native-frame",
    include: ["host-smoke/acceptance-facility/native-frame/*.browser.test.tsx"],
    css: false,
    testTimeout: 30000,
    retry: 0,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
