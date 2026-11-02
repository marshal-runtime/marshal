/**
 * 33-provider-neutral-surfaces: Assert the real renderer exposes the intended
 * provider-neutral settings/integration surfaces and retired controls stay gone.
 *
 * This suite is deliberately read-only: it does not connect an account, clear
 * chats, or change providers.
 */
import { evaluate, openLeftNavItem, screenshot, sleep } from "../marshal-cdp-helpers.mjs";

async function waitForMainNavigation(Runtime, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = await evaluate(
      Runtime,
      `!!document.querySelector('nav[aria-label="Main navigation"]')`,
    );
    if (visible) return;
    await sleep(250);
  }
  throw new Error("Main navigation did not become ready");
}

async function waitForTestId(Runtime, testId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = await evaluate(
      Runtime,
      `!!document.querySelector('[data-testid=${JSON.stringify(testId)}]')`,
    );
    if (visible) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for [data-testid="${testId}"]`);
}

async function panelSnapshot(Runtime, testId) {
  return evaluate(
    Runtime,
    `(() => {
      const panel = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
      if (!panel) throw new Error('Panel not found: ' + ${JSON.stringify(testId)});
      const headings = [...panel.querySelectorAll('h1,h2,h3,h4,[role="heading"]')]
        .map((node) => node.textContent.trim())
        .filter(Boolean);
      const buttons = [...panel.querySelectorAll('button')]
        .map((node) => (node.getAttribute('aria-label') || node.textContent || '').trim())
        .filter(Boolean);
      return { text: panel.textContent || '', headings, buttons };
    })()`,
  );
}

function requireText(snapshot, text, panelName) {
  if (!snapshot.text.toLowerCase().includes(text.toLowerCase())) {
    throw new Error(`${panelName} is missing "${text}"`);
  }
}

export default {
  name: "Provider-neutral surfaces",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;

    await waitForMainNavigation(Runtime);
    steps++;

    await openLeftNavItem(Runtime, "Settings");
    await waitForTestId(Runtime, "settings-panel");
    const settings = await panelSnapshot(Runtime, "settings-panel");

    for (const required of ["Runtime adapters", "Active cloud provider", "Chat storage"]) {
      requireText(settings, required, "Settings");
    }
    const retiredSettingsHeadings = settings.headings.filter((heading) =>
      /^(memory|tool pinning|pinned tools)$/i.test(heading),
    );
    if (retiredSettingsHeadings.length > 0) {
      throw new Error(`Retired Settings sections returned: ${retiredSettingsHeadings.join(", ")}`);
    }
    const chatStorageValue = await evaluate(
      Runtime,
      `document.querySelector('[data-testid="settings-panel"] [aria-label="Chat storage"]')?.textContent?.trim() || null`,
    );
    if (!chatStorageValue || !/on this device|cloud app folder/i.test(chatStorageValue)) {
      throw new Error(`Chat storage selector has no recognized provider: ${chatStorageValue}`);
    }
    const clearAllChatsVisible = await evaluate(
      Runtime,
      `document.querySelector('nav[aria-label="Main navigation"]')?.textContent?.includes('Clear all chats') || false`,
    );
    if (clearAllChatsVisible) throw new Error('Retired "Clear all chats" action is still visible');
    steps++;
    console.log(
      `   ✓ Settings exposes runtime/cloud/storage controls; storage=${chatStorageValue}`,
    );

    await screenshot(Page, resultsDir, "33-provider-neutral-settings.png");
    console.log("   📸 33-provider-neutral-settings.png");

    await openLeftNavItem(Runtime, "Integrations");
    await waitForTestId(Runtime, "integrations-panel");
    const integrations = await panelSnapshot(Runtime, "integrations-panel");
    requireText(integrations, "Cloud identity & sources", "Integrations");
    const hasIdentityActionOrState =
      integrations.buttons.some((label) => /^(connect|refresh token)$/i.test(label)) ||
      /signed in|not signed in|checking|token expired|status error/i.test(integrations.text);
    if (!hasIdentityActionOrState) {
      throw new Error("Cloud identity card exposes neither status nor a connection action");
    }
    steps++;
    console.log("   ✓ Integrations exposes cloud identity and provider relay surfaces");

    await screenshot(Page, resultsDir, "33-provider-neutral-integrations.png");
    console.log("   📸 33-provider-neutral-integrations.png");

    return steps;
  },
};
