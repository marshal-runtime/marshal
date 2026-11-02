import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { remotePreloadPlugin } from "./scripts/remote-preload-plugin";
export default defineConfig({
  base: "/ui/",
  plugins: [remotePreloadPlugin(), tailwindcss(), react()],
  resolve: { alias: { "@": path.resolve("src"), "@common": path.resolve("common") } },
  define: {
    __MARSHAL_CLOUD_HOSTED__: "true",
    __APP_VERSION__: JSON.stringify("0.1.0"),
    __IS_RELEASE_BUILD__: true,
    __IS_INTERNAL_BUILD__: false,
  },
  build: {
    outDir: "../marshal-cloud-workers/.web",
    emptyOutDir: true,
    rollupOptions: { input: "remote.html" },
  },
});
