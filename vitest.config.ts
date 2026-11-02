import { builtinModules } from "module";
import { existsSync } from "node:fs";

import react from "@vitejs/plugin-react";
import { playwright as playwrightProvider } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// These tests import the sibling marshal-cloud-workers checkout, which CI does not clone.
const CLOUD_WORKERS_DEPENDENT_TESTS = existsSync("../marshal-cloud-workers")
  ? []
  : [
      "electron/backend/cloud/client.test.ts",
      "electron/backend/cloud/integration.test.ts",
      "electron/backend/cloud/workspace.test.ts",
    ];

// Node.js built-in aliases: map bare names (e.g. "fs") to their node: prefix
// so Vite/Rollup treats them as externals rather than trying to resolve them
// as packages (which fails in happy-dom / browser environments).
const nodeBuiltinAliases = Object.fromEntries(
  builtinModules
    .filter((m) => !m.startsWith("_") && !m.startsWith("node:"))
    .map((m) => [m, `node:${m}`]),
);

export default defineConfig({
  test: {
    env: { TZ: "UTC" },
    experimental: {
      fsModuleCache: true,
    },
    projects: [
      {
        plugins: [react()],
        resolve: {
          tsconfigPaths: true,
        },
        define: {
          __APP_VERSION__: JSON.stringify("0.0.0-test"),
          __IS_RELEASE_BUILD__: false,
          __MARSHAL_DEV_FEATURES__: false,
        },
        test: {
          name: "unit",
          environment: "happy-dom",
          setupFiles: ["./src/test-environment-setup.ts"],
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["src/**/*.browser.test.{ts,tsx}"],
          css: false,
          testTimeout: 15000,
          retry: 2,
          deps: {
            optimizer: {
              web: { enabled: true },
            },
          },
        },
      },
      {
        plugins: [react()],
        resolve: {
          tsconfigPaths: true,
        },
        define: {
          __APP_VERSION__: JSON.stringify("0.0.0-test"),
          __IS_RELEASE_BUILD__: false,
          __MARSHAL_DEV_FEATURES__: false,
        },
        test: {
          name: "browser",
          browser: {
            enabled: true,
            headless: true,
            provider: playwrightProvider(),
            instances: [{ browser: "chromium" }],
          },
          setupFiles: ["./src/test-environment-setup.ts"],
          include: ["src/**/*.browser.test.{ts,tsx}"],
          css: false,
          testTimeout: 15000,
          retry: 2,
        },
      },
      {
        resolve: {
          alias: {
            ...nodeBuiltinAliases,
            // Marshal identity: published workflow packages still import this package name.
            "@marshal/workflow-sdk": new URL(
              "./packages/workflow-sdk/src/index.ts",
              import.meta.url,
            ).pathname.replace(/^\/([A-Z]:)/, "$1"),
          },
        },
        define: {
          __APP_VERSION__: JSON.stringify("0.0.0-test"),
          __IS_RELEASE_BUILD__: false,
          __MARSHAL_DEV_FEATURES__: false,
        },
        test: {
          name: "node",
          environment: "node",
          include: ["electron/**/*.test.ts", "common/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: CLOUD_WORKERS_DEPENDENT_TESTS,
          testTimeout: 15000,
          retry: 2,
          deps: {
            optimizer: {
              ssr: { enabled: true },
            },
          },
        },
      },
      {
        resolve: {
          alias: nodeBuiltinAliases,
        },
        test: {
          name: "tools",
          environment: "node",
          include: ["tools/**/test/**/*.test.ts"],
          testTimeout: 15000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "electron/**/*.ts", "common/**/*.ts"],
      exclude: ["src/test-*.ts", "**/*.test.*", "**/*.d.ts"],
    },
  },
});
