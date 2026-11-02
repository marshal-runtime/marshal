// Sets IS_RELEASE_BUILD=true before running vite build so the renderer
// embeds a release flag at build time — used to disable the dev console sink.
// This must only be run as part of the electron-builder release flow (pnpm run build),
// not for local dev builds or e2e test builds.
// Intentionally not a VITE_ prefix: see vite.config.ts define for rationale.
process.env.IS_RELEASE_BUILD = "true";

const { execFileSync } = require("child_process");

try {
  execFileSync("pnpm", ["run", "build:vite"], { stdio: "inherit", shell: true });
} catch (e) {
  process.exit(e.status ?? 1);
}
