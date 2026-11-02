/**
 * Visual Review Script
 *
 * Connects to a running M (Marshal) instance via CDP, navigates to every
 * panel, captures screenshots in both light and dark themes, and saves them
 * to scripts/visual-review-results/.
 *
 * Usage:
 *   1. pnpm run build:vite
 *   2. pnpm run electron:debug
 *   3. node scripts/marshal-visual-review.mjs [--port 9222]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import CDP from "chrome-remote-interface";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "visual-review-results");
const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") || "9222", 10);

// ── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function connect(port) {
  const deadline = Date.now() + 15_000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const targets = await CDP.List({ port });
      const renderer = targets.find((t) => t.type === "page" && !t.url.includes("devtools://"));
      if (!renderer) throw new Error("No renderer target");
      const client = await CDP({ port, target: renderer });
      await Promise.all([client.Runtime.enable(), client.Page.enable(), client.DOM.enable()]);
      return client;
    } catch (e) {
      lastErr = e;
      await sleep(500);
    }
  }
  throw new Error(`Failed to connect on port ${port}: ${lastErr?.message}`);
}

async function evaluate(Runtime, expr) {
  const { result, exceptionDetails } = await Runtime.evaluate({
    // Safe: `expr` is always a static internal script snippet passed from hardcoded callers in
    // this file — it is never derived from user input or external data, so there is no
    // code-injection vector here.
    // Rule: https://semgrep.dev/r/javascript.chrome-remote-interface.security.audit.chrome-remote-interface-compilescript-injection.chrome-remote-interface-compilescript-injection
    expression: expr, // nosemgrep: javascript.chrome-remote-interface.security.audit.chrome-remote-interface-compilescript-injection.chrome-remote-interface-compilescript-injection
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(
      `Eval error: ${exceptionDetails.exception?.description || exceptionDetails.text}`,
    );
  }
  return result.value;
}

async function screenshot(Page, name) {
  const { data } = await Page.captureScreenshot({ format: "png" });
  const filePath = path.join(RESULTS_DIR, name);
  fs.writeFileSync(filePath, Buffer.from(data, "base64"));
  console.log(`  📸 ${name}`);
  return filePath;
}

async function setTheme(Runtime, theme) {
  const t = JSON.stringify(theme);
  await evaluate(
    Runtime,
    `(async () => {
      const r = await window.settingsAPI.get();
      const s = r.settings || r;
      s.theme = ${t};
      await window.settingsAPI.save(s);
      document.documentElement.setAttribute('data-theme', ${t});
      document.documentElement.setAttribute('data-theme-mode', ${t});
    })()`,
  );
  await sleep(300); // let repaint settle
}

async function clickNavItem(Runtime, label) {
  const l = JSON.stringify(label);
  const clicked = await evaluate(
    Runtime,
    `(() => {
      const nav = document.querySelector('nav[aria-label="Main navigation"]');
      if (!nav) return 'no-nav';
      const btns = [...nav.querySelectorAll('button')];
      const btn = btns.find(b => b.textContent.trim() === ${l} || b.getAttribute('aria-label') === ${l});
      if (btn) { btn.click(); return 'clicked'; }
      return 'not-found';
    })()`,
  );
  await sleep(400); // let panel render
  return clicked;
}

async function waitForReady(Runtime) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = await evaluate(
      Runtime,
      `!!document.querySelector('textarea.prompt-input') || !!document.querySelector('[data-testid="welcome-state"]') || !!document.querySelector('[data-testid="settings-panel"]')`,
    );
    if (ready) return;
    await sleep(500);
  }
  throw new Error("App not ready within 30s");
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  console.log(`\n🔗 Connecting to M on port ${PORT}...`);
  const client = await connect(PORT);
  const { Runtime, Page } = client;

  console.log("⏳ Waiting for app to be ready...");
  await waitForReady(Runtime);
  console.log("✅ App is ready\n");

  // Determine layout mode
  const isNarrow = await evaluate(Runtime, `window.innerWidth < 600`);
  console.log(`Layout: ${isNarrow ? "narrow (< 600px)" : "wide (>= 600px)"}`);

  // Get current window size
  const winSize = await evaluate(
    Runtime,
    `JSON.stringify({ w: window.innerWidth, h: window.innerHeight })`,
  );
  console.log(`Window: ${winSize}\n`);

  // ── Panel navigation items ──
  const panels = [
    { nav: "Chat", name: "chat" },
    { nav: "Skills", name: "skills" },
    { nav: "Heartbeat", name: "heartbeat" },
    { nav: "Workflows", name: "workflows" },
    { nav: "Activity", name: "activities" },
    { nav: "Integrations", name: "integrations" },
    { nav: "Settings", name: "settings" },
  ];

  // ── Capture in both themes ──
  for (const theme of ["light", "dark"]) {
    console.log(`\n── ${theme.toUpperCase()} THEME ──`);
    await setTheme(Runtime, theme);

    for (const panel of panels) {
      const result = await clickNavItem(Runtime, panel.nav);
      if (result !== "clicked") {
        console.log(`  ⚠️  Could not click "${panel.nav}": ${result}`);
      }
      await screenshot(Page, `${panel.name}-${theme}.png`);
    }

    // Go back to chat for welcome state
    await clickNavItem(Runtime, "Chat");
    await sleep(200);
  }

  // ── Special states ──
  console.log("\n── SPECIAL STATES ──");

  // Ensure light theme for special states
  await setTheme(Runtime, "light");

  // New chat / welcome state (click "New chat" button)
  await evaluate(
    Runtime,
    `(() => {
      const btn = document.querySelector('[data-testid="new-chat-btn"]') ||
        [...document.querySelectorAll('button')].find(b => b.textContent.includes('New chat'));
      if (btn) btn.click();
    })()`,
  );
  await sleep(500);
  await screenshot(Page, "welcome-state-light.png");

  // Try to capture a dialog/popover state if there's a dropdown open
  // Screenshot the header area
  await screenshot(Page, "header-light.png");

  // Check if we can capture narrow nav rail
  console.log("\n── NARROW NAV RAIL ──");
  console.log("  (Resizing window to 500px width)");

  // Store original size
  const originalSize = await evaluate(
    Runtime,
    `JSON.stringify({ w: window.outerWidth, h: window.outerHeight })`,
  );

  // Resize to narrow
  await evaluate(
    Runtime,
    `(() => {
      if (window.windowControlsAPI?.setWidth) {
        window.windowControlsAPI.setWidth(500);
      }
    })()`,
  );
  await sleep(800);
  await screenshot(Page, "narrow-rail-light.png");

  // Switch to dark in narrow
  await setTheme(Runtime, "dark");
  await screenshot(Page, "narrow-rail-dark.png");

  // Restore original width
  const parsed = JSON.parse(originalSize);
  await evaluate(
    Runtime,
    `(() => {
      if (window.windowControlsAPI?.setWidth) {
        window.windowControlsAPI.setWidth(${parsed.w});
      }
    })()`,
  );
  await sleep(500);
  await setTheme(Runtime, "light");

  console.log(`\n✅ Done! Screenshots saved to: ${RESULTS_DIR}`);
  console.log(
    `   Total files: ${fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".png")).length}`,
  );

  await client.close();
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
