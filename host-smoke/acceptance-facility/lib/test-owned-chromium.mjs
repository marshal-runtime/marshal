// Shared test-owned, ephemeral-port headless Chromium launcher for the
// facfix honest-red/green receipt scripts (scripts/capture-facfix-receipts.mjs,
// scripts/capture-facfix2-receipts.mjs). Always this repo's own bundled
// @playwright/test dependency, never the user's browser — see the Field
// Guide's honest-red standard (decision 2).

import net from "node:net";

/** Reserves an OS-assigned ephemeral TCP port on localhost, then releases it immediately. */
export async function reserveEphemeralPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Launches a test-owned, ephemeral-port headless Chromium via this repo's
 * bundled @playwright/test dependency (never the user's browser). Reserves a
 * free localhost port first and passes it explicitly to
 * `--remote-debugging-port` so the real CDP port is known up front (a small,
 * standard-practice reserve-then-release TOCTOU is accepted here).
 * @param {string[]} [extraArgs] — additional Chromium CLI args, e.g.
 *   `--user-agent=...` to simulate a spoofed /json/version User-Agent.
 */
export async function launchTestOwnedChromium(extraArgs = []) {
  const { chromium } = await import("@playwright/test");
  const port = await reserveEphemeralPort();
  const browser = await chromium.launch({
    headless: true,
    args: [`--remote-debugging-port=${port}`, ...extraArgs],
  });
  return {
    port,
    browser,
    version: browser.version(),
    async close() {
      await browser.close();
    },
  };
}
