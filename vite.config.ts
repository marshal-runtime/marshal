import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "fs";
import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron";

import pkg from "./package.json";
import { remotePreloadPlugin } from "./scripts/remote-preload-plugin";

// Confidentiality hardening (strip source maps + minify the Electron MAIN bundle) is applied
// ONLY to packaged distribution builds (IS_RELEASE_BUILD). Plain
// `pnpm dev` / `electron:dev` leave the main bundle readable + un-minified so local iteration
// stays debuggable.
const HARDEN_BUNDLE = process.env.IS_RELEASE_BUILD === "true";
const devFeatures = process.env.MARSHAL_DEV_FEATURES === "true";
const runtimeAcceptanceBuild = process.env.MARSHAL_RUNTIME_ACCEPTANCE_BUILD === "1";
const expectedWindowsSignerSubject =
  process.env.EXPECTED_WINDOWS_SIGNER_SUBJECT?.trim() || "UNCONFIGURED_WINDOWS_SIGNER";
const expectedMacosTeamId = process.env.EXPECTED_MACOS_TEAM_ID?.trim() || "UNCONFIGURED_MACOS_TEAM";

const MINI_MODE_PAGE_DIR = path.join("electron", "mini-mode-page");
const MINI_MODE_PAGE_OUT = path.join("dist-electron", "mini-mode-page");
const MINI_MODE_PAGE_FILES = ["index.html", "style.css", "script.js"];
const RUNTIME_ACCEPTANCE_PRELOAD = path.join("dist-electron", "runtime-acceptance-preload.cjs");

function syncRuntimeAcceptancePreload() {
  if (runtimeAcceptanceBuild) {
    writeFileSync(
      RUNTIME_ACCEPTANCE_PRELOAD,
      `${readFileSync("electron/preload.cjs", "utf8")}\n${readFileSync(
        "electron/runtime-acceptance-preload.cjs",
        "utf8",
      )}`,
    );
  } else {
    rmSync(RUNTIME_ACCEPTANCE_PRELOAD, { force: true });
  }
}

function copyMiniModePage() {
  mkdirSync(MINI_MODE_PAGE_OUT, { recursive: true });
  for (const file of MINI_MODE_PAGE_FILES) {
    copyFileSync(path.join(MINI_MODE_PAGE_DIR, file), path.join(MINI_MODE_PAGE_OUT, file));
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    remotePreloadPlugin(),
    tailwindcss(),
    react(),
    electron([
      {
        entry: "electron/main.ts",
        onstart(args) {
          // DEV ONLY: onstart doesn't run during `vite build` (production).
          // Production copy is handled by the closeBundle plugin below.
          copyFileSync("electron/preload.cjs", "dist-electron/preload.cjs");
          syncRuntimeAcceptancePreload();
          copyFileSync("electron/mini-mode/preload.cjs", "dist-electron/mini-mode-preload.cjs");
          copyMiniModePage();
          // Clear ELECTRON_RUN_AS_NODE so Electron starts as a browser process.
          // This env var may be inherited from parent Electron apps (e.g. VS Code, Marshal).
          const env = { ...process.env };
          delete env.ELECTRON_RUN_AS_NODE;
          void args.startup([".", "--no-sandbox"], { env });
        },
        vite: {
          resolve: {
            alias: {
              "@marshal/workflow-sdk": path.resolve("packages/workflow-sdk/src/index.ts"),
            },
          },
          define: {
            __MARSHAL_DEV_FEATURES__: devFeatures,
            __MARSHAL_RUNTIME_ACCEPTANCE_BUILD__: runtimeAcceptanceBuild,
            __EXPECTED_WINDOWS_SIGNER_SUBJECT__: JSON.stringify(expectedWindowsSignerSubject),
            __EXPECTED_MACOS_TEAM_ID__: JSON.stringify(expectedMacosTeamId),
          },
          build: {
            outDir: "dist-electron",
            // The main bundle carries updater/auth/token logic and ships on a public
            // download. In packaged builds (HARDEN_BUNDLE) strip its source maps + minify it so it
            // can't be read as source; in dev, leave it readable + un-minified for debugging.
            ...(HARDEN_BUNDLE ? { sourcemap: false } : {}),
            rolldownOptions: {
              // build.minify is ignored for the plugin's lib-mode main build — use rolldown's
              // native Oxc output.minify instead.
              ...(HARDEN_BUNDLE ? { output: { minify: true } } : {}),
              external: [
                "electron",
                "@github/copilot-sdk",
                "@cursor/sdk",
                /^@cursor\/sdk/,
                /^@marshal\/(?!workflow-sdk$)/,
                /^@modelcontextprotocol\/sdk/,
                "ws",
                "bufferutil",
                "utf-8-validate",
                "esbuild",
                /^@esbuild\//,
              ],
            },
          },
          plugins: [
            {
              name: "copy-preload",
              closeBundle() {
                // Ensure preload scripts are copied after production build
                mkdirSync("dist-electron", { recursive: true });
                copyFileSync("electron/preload.cjs", "dist-electron/preload.cjs");
                syncRuntimeAcceptancePreload();
                copyFileSync(
                  "electron/mini-mode/preload.cjs",
                  "dist-electron/mini-mode-preload.cjs",
                );
                copyMiniModePage();
              },
            },
            (() => {
              let watcher: FSWatcher | undefined;
              return {
                name: "watch-mini-mode-page",
                buildStart() {
                  // DEV ONLY: watch mini-mode page assets and re-copy on change
                  if (process.env.NODE_ENV === "production") return;
                  watcher = watch(MINI_MODE_PAGE_DIR, (_event, filename) => {
                    if (filename && MINI_MODE_PAGE_FILES.includes(filename)) {
                      try {
                        copyMiniModePage();
                      } catch {
                        /* file may be mid-write */
                      }
                    }
                  });
                },
                closeBundle() {
                  watcher?.close();
                },
              };
            })(),
          ],
        },
      },
    ]),
  ],
  resolve: {
    tsconfigPaths: true,
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5544,
    strictPort: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Set by scripts/marshal-build-release.cjs only — intentionally not a VITE_ prefix so
    // it isn't auto-exposed from process.env and can't leak from a developer's shell.
    __IS_RELEASE_BUILD__: process.env.IS_RELEASE_BUILD === "true",
    __MARSHAL_DEV_FEATURES__: devFeatures,
  },
  build: {
    target: "esnext",
    minify: true,
    sourcemap: false,
    rolldownOptions: {
      input: {
        main: path.resolve("index.html"),
        remote: path.resolve("remote.html"),
        observe: path.resolve("observe.html"),
      },
      output: {
        // Give Shiki lazy-loaded chunks readable names instead of opaque hashes.
        // Resolved IDs look like: .../node_modules/@shikijs/langs/dist/bash.mjs
        manualChunks(id) {
          if (!id.includes("@shikijs/")) return undefined;
          // Language grammars: @shikijs/langs/dist/bash.mjs → shiki-lang-bash
          const langMatch = id.match(/@shikijs\/langs\/dist\/(\w+)\./);
          if (langMatch) return `shiki-lang-${langMatch[1]}`;
          // Themes: @shikijs/themes/dist/github-light.mjs → shiki-theme-github-light
          const themeMatch = id.match(/@shikijs\/themes\/dist\/([\w-]+)\./);
          if (themeMatch) return `shiki-theme-${themeMatch[1]}`;
          // Core engine: @shikijs/core + @shikijs/engine-javascript → shiki-core
          if (id.includes("@shikijs/core/") || id.includes("@shikijs/engine-javascript/")) {
            return "shiki-core";
          }
          return undefined;
        },
      },
    },
  },
});
