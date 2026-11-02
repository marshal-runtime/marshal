// Dev-only harness for the Mermaid viewer. Serves the real renderer components
// with the real app stylesheet in a plain browser — no Electron.
//   pnpm exec vite --config src/features/mermaid/harness/vite.config.ts
// then open http://localhost:5599/src/features/mermaid/harness/index.html
import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

export default defineConfig({
  root: repoRoot,
  plugins: [react(), tailwindcss()],
  resolve: { tsconfigPaths: true, dedupe: ["react", "react-dom"] },
  server: { port: 5599, strictPort: true },
  define: {
    __APP_VERSION__: JSON.stringify("harness"),
    __IS_RELEASE_BUILD__: false,
    __IS_INTERNAL_BUILD__: false,
  },
});
