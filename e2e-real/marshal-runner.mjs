// Marshal-owned real-account harness.
/**
 * E2E Real Account Test Runner for Marshal.
 *
 * Connects to a running Marshal instance via CDP (remote debugging on port 9222),
 * runs test suites sequentially, takes screenshots, and generates a report.
 *
 * Usage:
 *   node e2e-real/marshal-runner.mjs                    # Run all suites
 *   node e2e-real/marshal-runner.mjs --suite 04-browser  # Run one suite
 *   node e2e-real/marshal-runner.mjs --from 17           # Run from suite 17 onwards
 *   node e2e-real/marshal-runner.mjs --port 9223         # Custom port
 *   node e2e-real/marshal-runner.mjs --results-dir C:\temp\marshal-runtime-real
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connectToApp, invokeIPC, sleep, timestamp } from "./marshal-cdp-helpers.mjs";
import { E2E_TEST_PERMISSIONS } from "./marshal-e2e-permissions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUITES_DIR = path.join(__dirname, "test-suites");
const MARSHAL_SUITE_FILENAME_PREFIX = "marshal-";

function publicSuiteFilename(file) {
  return file.startsWith(MARSHAL_SUITE_FILENAME_PREFIX)
    ? file.slice(MARSHAL_SUITE_FILENAME_PREFIX.length)
    : file;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { port: 9222, suite: null, from: null, resultsDir: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) opts.port = parseInt(args[++i]);
    if (args[i] === "--suite" && args[i + 1]) opts.suite = args[++i];
    if (args[i] === "--from" && args[i + 1]) opts.from = args[++i];
    if (args[i] === "--results-dir" && args[i + 1]) {
      opts.resultsDir = path.resolve(args[++i]);
    }
  }
  return opts;
}

async function discoverSuites(filter, from) {
  let files = fs
    .readdirSync(SUITES_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .sort((a, b) => {
      const publicA = publicSuiteFilename(a);
      const publicB = publicSuiteFilename(b);
      return publicA < publicB ? -1 : publicA > publicB ? 1 : 0;
    });

  const available = files.map(publicSuiteFilename);

  if (filter) {
    const matched = files.filter((f) => publicSuiteFilename(f).includes(filter));
    if (matched.length === 0) {
      console.error(`❌ No suite matching "${filter}" found.`);
      console.error(`Available: ${available.join(", ")}`);
      process.exit(1);
    }
    return matched;
  }

  if (from) {
    const idx = files.findIndex((f) => publicSuiteFilename(f).includes(from));
    if (idx === -1) {
      console.error(`❌ No suite matching "--from ${from}" found.`);
      console.error(`Available: ${available.join(", ")}`);
      process.exit(1);
    }
    files = files.slice(idx);
  }

  return files;
}

function generateReport(results, resultsDir) {
  const ts = path.basename(resultsDir);
  let md = `# E2E Real Account Test Report\n\n`;
  md += `**Run**: ${ts}\n`;
  md += `**Platform**: ${process.platform}\n`;
  md += `**Node**: ${process.version}\n\n`;

  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  md += `## Summary: ${passed} passed, ${failed} failed, ${skipped} skipped\n\n`;

  md += `| # | Suite | Status | Duration | Details |\n`;
  md += `|---|-------|--------|----------|--------|\n`;

  for (const r of results) {
    const icon = r.status === "passed" ? "✅" : r.status === "failed" ? "❌" : "⏭️";
    const dur = r.duration ? `${(r.duration / 1000).toFixed(1)}s` : "-";
    const detail = r.error ? r.error.slice(0, 80) : r.steps || "-";
    md += `| ${r.index} | ${r.name} | ${icon} ${r.status} | ${dur} | ${detail} |\n`;
  }

  md += `\n## Screenshots\n\n`;
  const screenshotsDir = path.join(resultsDir, "screenshots");
  if (fs.existsSync(screenshotsDir)) {
    const shots = fs.readdirSync(screenshotsDir).sort();
    for (const shot of shots) {
      md += `### ${shot}\n`;
      md += `![${shot}](screenshots/${shot})\n\n`;
    }
  }

  if (failed > 0) {
    md += `## Failures\n\n`;
    for (const r of results.filter((result) => result.status === "failed")) {
      md += `### ${r.name}\n\`\`\`\n${r.error}\n\`\`\`\n\n`;
    }
  }

  const reportPath = path.join(resultsDir, "report.md");
  fs.writeFileSync(reportPath, md);
  return reportPath;
}

async function main() {
  const opts = parseArgs();
  const ts = timestamp();
  const resultsDir = opts.resultsDir ?? path.join(__dirname, "results", ts);
  fs.mkdirSync(path.join(resultsDir, "screenshots"), { recursive: true });

  console.log(`\n🧪 Marshal E2E Real Account Test Runner`);
  console.log(`   Port: ${opts.port}`);
  console.log(`   Results: ${resultsDir}\n`);

  // Connect to Marshal
  console.log(`🔌 Connecting to Marshal on port ${opts.port}...`);
  let connection;
  try {
    connection = await connectToApp(opts.port);
    console.log(`✅ Connected to: ${connection.target.title} (${connection.target.url})\n`);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    console.error(`   Make sure Marshal is running with: pnpm run electron:debug\n`);
    process.exit(1);
  }

  const { client, Runtime, Page } = connection;

  // Seed E2E permissions — save originals so we can restore after all suites.
  let originalSettings;
  try {
    const result = await invokeIPC(Runtime, "settingsAPI", "get");
    originalSettings = result?.settings ?? result;
    await invokeIPC(Runtime, "settingsAPI", "save", {
      ...originalSettings,
      permissions: E2E_TEST_PERMISSIONS,
    });
    await sleep(500);
    console.log(`🔒 Seeded E2E test permissions\n`);
  } catch (err) {
    console.error(`⚠️  Could not seed permissions: ${err.message}`);
    console.error(`   Tests that trigger tools may hang on permission cards.\n`);
  }

  // Restore settings on Ctrl+C so the user's config isn't left in E2E test state.
  const restoreAndExit = async () => {
    if (originalSettings) {
      try {
        await invokeIPC(Runtime, "settingsAPI", "save", originalSettings);
        console.log(`\n🔒 Restored original settings (interrupted)`);
      } catch {
        // best-effort
      }
    }
    process.exit(130);
  };
  process.on("SIGINT", restoreAndExit);

  // Discover suites
  const suiteFiles = await discoverSuites(opts.suite, opts.from);
  console.log(`📋 ${suiteFiles.length} suite(s) to run:\n`);

  const results = [];

  try {
    for (let i = 0; i < suiteFiles.length; i++) {
      const file = suiteFiles[i];
      const suiteName = publicSuiteFilename(file).replace(".mjs", "");
      const index = String(i + 1).padStart(2, "0");

      console.log(`━━━ [${index}/${suiteFiles.length}] ${suiteName} ━━━`);

      const suiteModule = await import(`./test-suites/${file}`);
      const suite = suiteModule.default;

      const skipReason = typeof suite?.skip === "function" ? suite.skip() : suite?.skip;
      if (skipReason) {
        console.log(`   ⏭️  Skipped (${skipReason})\n`);
        results.push({
          index,
          name: suiteName,
          status: "skipped",
          steps: skipReason,
        });
        continue;
      }

      if (!suite || typeof suite.run !== "function") {
        console.log(`   ⏭️  Skipped (no run function exported)\n`);
        results.push({
          index,
          name: suiteName,
          status: "skipped",
          steps: "No run() exported",
        });
        continue;
      }

      const start = Date.now();
      try {
        const stepCount = await suite.run({
          Runtime,
          Page,
          client,
          resultsDir,
          connection,
        });
        const duration = Date.now() - start;
        console.log(`   ✅ Passed (${(duration / 1000).toFixed(1)}s, ${stepCount || "?"} steps)\n`);
        results.push({
          index,
          name: suiteName,
          status: "passed",
          duration,
          steps: `${stepCount || "?"} steps`,
        });
      } catch (err) {
        const duration = Date.now() - start;
        console.log(`   ❌ FAILED: ${err.message}\n`);
        // Take failure screenshot
        try {
          const { screenshot: takeScreenshot } = await import("./marshal-cdp-helpers.mjs");
          await takeScreenshot(Page, resultsDir, `FAIL-${suiteName}.png`);
        } catch {
          // ignore screenshot failure
        }
        results.push({
          index,
          name: suiteName,
          status: "failed",
          duration,
          error: err.message,
        });
      }
    }
  } finally {
    process.removeListener("SIGINT", restoreAndExit);
    // Always restore original settings after all suites
    if (originalSettings) {
      try {
        await invokeIPC(Runtime, "settingsAPI", "save", originalSettings);
        await sleep(500);
        console.log(`\n🔒 Restored original settings`);
      } catch (err) {
        console.error(`⚠️  Could not restore settings: ${err.message}`);
      }
    }
  }

  // Generate report
  const reportPath = generateReport(results, resultsDir);
  console.log(`\n━━━ RESULTS ━━━`);
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  console.log(`   ✅ ${passed} passed`);
  if (failed) console.log(`   ❌ ${failed} failed`);
  console.log(`   📄 Report: ${reportPath}`);
  console.log(`   📸 Screenshots: ${path.join(resultsDir, "screenshots")}\n`);

  await client.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n💥 Runner crashed: ${err.message}`);
  process.exit(2);
});
