// Marshal-owned path
import { spawnSync } from "child_process";

// CI=true is set by GitHub Actions and most CI providers.
if (process.env.CI) {
  console.log("→ postinstall: skipped (CI)");
  process.exit(0);
}

console.log("→ postinstall: ensuring Playwright Chromium is installed…");
const result = spawnSync(
  process.execPath,
  ["node_modules/playwright/cli.js", "install", "chromium"],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
