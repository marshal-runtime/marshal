import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// CI=true is set by GitHub Actions and most CI providers.
if (process.env.CI) {
  console.log("→ preinstall: skipped (CI)");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
console.log("→ preinstall: fetching bundled Node binaries…");
const fetchResult = spawnSync(process.execPath, [join(here, "marshal-fetch-bundled-node.cjs")], {
  stdio: "inherit",
});
process.exit(fetchResult.status ?? 1);
