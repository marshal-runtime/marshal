// Marshal-owned real-account harness.
// Marshal-owned fixed E2E suite.
/**
 * 23-permission-routing: Verify permission cards stay scoped to their session
 * and survive navigation away + session switches.
 *
 * Part 1: Session isolation — cards don't leak across sessions.
 * Part 2: Navigate-away resilience — cards survive ChatPanel unmount.
 * Part 3: Session-switch resilience — cards resolve while viewing another session.
 * Part 4: New pipeline features — button labels, autoApproveReadOnly, pattern whitelist.
 */
import {
  waitForReady,
  sendPrompt,
  waitForResponse,
  getLastAssistantMessage,
  evaluate,
  invokeIPC,
  openLeftNavItem,
  screenshot,
  sleep,
  createNewSession,
  getActiveSessionId,
  switchToSession,
  countCards,
  hasRunningCard,
  clickCardButton,
} from "../marshal-cdp-helpers.mjs";
import { E2E_TEST_PERMISSIONS, NO_AUTO_APPROVE_PERMISSIONS } from "../marshal-e2e-permissions.mjs";

/**
 * Click a left-nav item by label. Items that live in the bottom-left "More"
 * overflow menu (Heartbeat, Activity, Extensions, Integrations, Settings) are
 * opened by clicking the More trigger first.
 */
async function clickNavButton(Runtime, label) {
  await openLeftNavItem(Runtime, label);
  await sleep(2000);
}

/** Close the current panel by navigating back to chat (click first session in sidebar). */
async function closePanel(Runtime) {
  await evaluate(
    Runtime,
    `(() => {
      // Try Close button first (works for overlay panels)
      const closeBtn = document.querySelector('button[aria-label="Close"]');
      if (closeBtn) { closeBtn.click(); return true; }
      // Fallback: click the first session in the sidebar to switch back to chat
      const session = document.querySelector('[data-session-id]');
      if (session) { session.click(); return true; }
      throw new Error('Neither Close button nor session found');
    })()`,
  );
  await sleep(2000);
}

export default {
  name: "Permission Routing & Resilience",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;

    await waitForReady(Runtime);
    steps++;

    // ── Part 1: Session isolation (existing test) ───────────────────────

    // Save current settings so we can restore
    let originalSettings;
    try {
      const result = await invokeIPC(Runtime, "settingsAPI", "get");
      originalSettings = result?.settings || result;
      console.log("   ✓ Saved original settings");
    } catch {
      /* no-op */
    }
    steps++;

    // Ensure permissions are set for full auto-approve in Part 1
    await invokeIPC(Runtime, "settingsAPI", "save", {
      ...originalSettings,
      permissions: E2E_TEST_PERMISSIONS,
    });
    await sleep(500);

    // Start from a fresh session (clicking "New chat" handles both create + UI switch)
    await createNewSession(Runtime);
    await waitForReady(Runtime);

    const currentSessionId = await getActiveSessionId(Runtime);
    console.log(`   ✓ Current session (fresh): ${currentSessionId || "unknown"}`);
    steps++;

    // Send a command that exercises shell tool (with auto-approve ON, should complete)
    await sendPrompt(Runtime, "Run the command: echo permission-routing-test-1");
    steps++;

    await waitForResponse(Runtime, 15, 60);
    steps++;

    const response1 = await getLastAssistantMessage(Runtime);
    console.log(`   ✓ Response in session 1: "${(response1 || "").slice(0, 80)}"`);
    steps++;

    await screenshot(Page, resultsDir, "23-session1-command.png");
    console.log("   📸 23-session1-command.png");

    // Count permission cards in current session
    const cardsInSession1 = await countCards(Runtime);
    console.log(`   ✓ Permission cards in session 1: ${cardsInSession1}`);
    steps++;

    // Create a new session
    await createNewSession(Runtime);
    steps++;

    // Verify the new session does NOT show cards from the old session
    const cardsInSession2 = await countCards(Runtime);
    console.log(
      `   ${cardsInSession2 === 0 ? "✓" : "⚠️"} Permission cards in new session: ${cardsInSession2} (expected 0)`,
    );
    steps++;

    await screenshot(Page, resultsDir, "23-session2-empty.png");
    console.log("   📸 23-session2-empty.png");

    // Switch back to original session — cards should still be there
    if (currentSessionId) {
      try {
        const sessions = await invokeIPC(Runtime, "sessionsAPI", "list");
        const original = sessions?.sessions?.find(
          (s) => s.id === currentSessionId || s.name === currentSessionId,
        );
        if (original) {
          await switchToSession(Runtime, original.id);

          const cardsBack = await countCards(Runtime);
          console.log(
            `   ${cardsBack >= cardsInSession1 ? "✓" : "⚠️"} Cards after switch-back: ${cardsBack} (was ${cardsInSession1})`,
          );

          await screenshot(Page, resultsDir, "23-session1-restored.png");
          console.log("   📸 23-session1-restored.png");
        }
      } catch (err) {
        console.log(`   ⚠️  Could not switch back: ${err.message}`);
      }
    }
    steps++;

    // ── Part 2 & 3: Resilience tests (auto-approve OFF) ────────────────

    try {
      // Disable ALL auto-approve paths so permission cards appear as pending
      const noAutoApprove = {
        ...originalSettings,
        permissions: NO_AUTO_APPROVE_PERMISSIONS,
      };
      await invokeIPC(Runtime, "settingsAPI", "save", noAutoApprove);
      await sleep(1000);
      console.log("   ✓ Disabled all auto-approve for resilience tests");
      steps++;

      // ── Part 2: Navigate-away resilience ──────────────

      console.log("   ── Part 2: Navigate-away resilience ──");

      // Create a fresh session for this scenario
      const navTestSessionId = await createNewSession(Runtime);
      await waitForReady(Runtime);
      console.log(`   ✓ Nav-away test session: ${navTestSessionId}`);

      // Use echo (works on macOS/Linux/Windows). With autoApproveReadOnly=false,
      // even read-only commands prompt — so this triggers the permission card.
      await sendPrompt(Runtime, "Run this exact shell command without explanation: echo nav-test");
      // Poll for a pending permission card — the SDK needs time to invoke the tool.
      let cardsBeforeNav = 0;
      for (let i = 0; i < 20; i++) {
        await sleep(1000);
        const pending = await evaluate(
          Runtime,
          `document.querySelectorAll('[data-testid="permission-card"]:not([data-resolved])').length`,
        );
        if (pending > 0) {
          cardsBeforeNav = pending;
          break;
        }
      }
      steps++;
      console.log(
        `   ${cardsBeforeNav >= 1 ? "✓" : "⚠️"} Cards before navigation: ${cardsBeforeNav} (expected >= 1)`,
      );
      steps++;

      await screenshot(Page, resultsDir, "23-nav-away-card-visible.png");
      console.log("   📸 23-nav-away-card-visible.png");

      // Navigate to Settings (ChatPanel unmounts)
      await clickNavButton(Runtime, "Settings");
      console.log("   ✓ Navigated to Settings (ChatPanel unmounted)");
      steps++;

      // Close Settings panel → returns to chat (ChatPanel remounts)
      await closePanel(Runtime);
      console.log("   ✓ Closed Settings, back to Chat");
      steps++;

      // Wait for async fetch to populate cards after remount
      await sleep(3000);

      const cardsAfterNav = await countCards(Runtime);
      const navPassed = cardsAfterNav >= cardsBeforeNav;
      console.log(
        `   ${navPassed ? "✓" : "⚠️"} Cards after navigation: ${cardsAfterNav} (was ${cardsBeforeNav}) — ${navPassed ? "PASS" : "FAIL: cards lost on navigate-away"}`,
      );
      steps++;

      await screenshot(Page, resultsDir, "23-nav-away-card-preserved.png");
      console.log("   📸 23-nav-away-card-preserved.png");

      // ── Part 3: Session-switch resilience ─────────────

      console.log("   ── Part 3: Session-switch resilience ──");

      // Re-enable auto-approve to create a clean session, then disable again
      await invokeIPC(Runtime, "settingsAPI", "save", {
        ...originalSettings,
        permissions: E2E_TEST_PERMISSIONS,
      });
      await sleep(500);

      // Create a fresh session for this scenario
      const sessionAId = await createNewSession(Runtime);
      await waitForReady(Runtime);
      console.log(`   ✓ Session A: ${sessionAId}`);
      steps++;

      // Now disable all auto-approve so the next command triggers a permission card
      await invokeIPC(Runtime, "settingsAPI", "save", noAutoApprove);
      await sleep(500);

      // Send a slow command — gives us time to switch sessions while it executes.
      // Pick a platform-appropriate sleep: macOS doesn't ship powershell, and
      // POSIX `sleep` isn't reliably on Windows. Without the right command,
      // the tool errors out instantly and the card never enters Running state.
      const slowCmd =
        process.platform === "win32"
          ? 'powershell -c "Start-Sleep -Seconds 5; Write-Output session-switch-done"'
          : "sleep 5 && echo session-switch-done";
      await sendPrompt(Runtime, `Run this exact shell command without explanation: ${slowCmd}`);
      // Poll for the permission card to appear
      for (let i = 0; i < 20; i++) {
        await sleep(1000);
        const pending = await evaluate(
          Runtime,
          `document.querySelectorAll('[data-testid="permission-card"]:not([data-resolved])').length`,
        );
        if (pending > 0) break;
      }
      steps++;

      // Click Allow on the pending permission card
      try {
        if (!(await clickCardButton(Runtime, "Allow", 30))) {
          throw new Error("No pending permission card to Allow");
        }
        console.log("   ✓ Clicked Allow — card should be Running");
      } catch (err) {
        console.log(`   ⚠️  Could not click Allow: ${err.message}`);
      }
      await sleep(1000);
      steps++;

      const isRunning = await hasRunningCard(Runtime);
      console.log(`   ${isRunning ? "✓" : "⚠️"} Card is Running: ${isRunning}`);

      await screenshot(Page, resultsDir, "23-session-switch-running.png");
      console.log("   📸 23-session-switch-running.png");
      steps++;

      // Switch to a new session while tool is executing in Session A
      await createNewSession(Runtime);
      console.log("   ✓ Switched to new session while tool executes in background");
      steps++;

      // Wait for the tool to finish (ping ~5s + SDK processing buffer)
      await sleep(15000);
      console.log("   ✓ Waited 15s for background tool to complete");
      steps++;

      // Switch back to Session A
      if (sessionAId) {
        try {
          await switchToSession(Runtime, sessionAId);
          console.log("   ✓ Switched back to Session A");

          const stillRunning = await hasRunningCard(Runtime);
          const switchPassed = !stillRunning;
          console.log(
            `   ${switchPassed ? "✓" : "⚠️"} Card still Running: ${stillRunning} — ${switchPassed ? "PASS: card resolved in background" : "FAIL: card stuck in Running state"}`,
          );

          await screenshot(Page, resultsDir, "23-session-switch-resolved.png");
          console.log("   📸 23-session-switch-resolved.png");
        } catch (err) {
          console.log(`   ⚠️  Could not switch back: ${err.message}`);
        }
      }
      steps++;
      // ── Part 4: New pipeline features ──────────────────────────────────

      console.log("   ── Part 4: New pipeline features ──");

      // 4a: Verify new button labels on a *pending* permission card.
      // Self-contained: don't rely on Part 2's leftover card. The "New chat"
      // button can reuse an existing empty session, so navTestSessionId and
      // sessionAId may be the same — meaning Part 3's Allow click resolved
      // the only existing card. Resolved cards don't render the action
      // buttons (PermissionCard.tsx:142+), so we need to generate a fresh
      // pending card here.
      {
        await invokeIPC(Runtime, "settingsAPI", "save", noAutoApprove);
        await sleep(500);
        await createNewSession(Runtime);
        await waitForReady(Runtime);

        await sendPrompt(
          Runtime,
          "Run this exact shell command without explanation: echo new-buttons-check",
        );
        // Poll for a pending card to appear
        for (let i = 0; i < 20; i++) {
          await sleep(1000);
          const pending = await evaluate(
            Runtime,
            `document.querySelectorAll('[data-testid="permission-card"]:not([data-resolved])').length`,
          );
          if (pending > 0) break;
        }

        // Chat-side permission cards render the always-allow button as
        // "Allow everywhere" (display-only override; the wire label remains
        // "Always allow"). Match by the visible chat text.
        const hasNewButtons = await evaluate(
          Runtime,
          `(() => {
            const cards = document.querySelectorAll('[data-testid="permission-card"]:not([data-resolved])');
            for (const card of cards) {
              const buttons = [...card.querySelectorAll('button')].map(b => b.textContent.trim());
              const hasAlwaysAllow = buttons.includes('Allow everywhere');
              const hasAllowForSession = buttons.includes('Allow for session');
              if (hasAlwaysAllow && hasAllowForSession) return true;
            }
            return false;
          })()`,
        );
        console.log(`   ${hasNewButtons ? "✓" : "⚠️"} New button labels present: ${hasNewButtons}`);
        steps++;

        // Deny the pending card so it doesn't bleed into later parts.
        await evaluate(
          Runtime,
          `(() => {
            const cards = [...document.querySelectorAll('[data-testid="permission-card"]:not([data-resolved])')];
            for (const card of cards) {
              const btn = [...card.querySelectorAll('button')].find(b => b.textContent.trim() === 'Deny');
              if (btn) btn.click();
            }
            return true;
          })()`,
        );
        await sleep(500);
      }

      // 4b: Verify autoApproveReadOnly works end-to-end
      {
        await invokeIPC(Runtime, "settingsAPI", "save", {
          ...originalSettings,
          permissions: {
            ...NO_AUTO_APPROVE_PERMISSIONS,
            autoApproveReadOnly: true,
          },
        });
        await sleep(1000);

        await createNewSession(Runtime);
        await waitForReady(Runtime);

        // Count cards before sending prompt (to detect stale cards from prior parts)
        const cardsBefore4b = await countCards(Runtime);

        // Send a safe command — should auto-approve (no NEW permission card)
        await sendPrompt(Runtime, "Run the command: echo safe-command-test");
        await waitForResponse(Runtime, 10, 30);
        await sleep(2000);

        const cardsAfter4b = await countCards(Runtime);
        const newCards4b = cardsAfter4b - cardsBefore4b;
        console.log(
          `   ${newCards4b === 0 ? "✓" : "⚠️"} Safe command auto-approved (new cards: ${newCards4b})`,
        );
        steps++;

        await screenshot(Page, resultsDir, "23-safe-command-auto-approved.png");
        console.log("   📸 23-safe-command-auto-approved.png");
      }

      // 4c: Verify pattern whitelist works end-to-end
      {
        await invokeIPC(Runtime, "settingsAPI", "save", {
          ...originalSettings,
          permissions: {
            ...NO_AUTO_APPROVE_PERMISSIONS,
            allow: ["echo *"],
          },
        });
        await sleep(1000);

        await createNewSession(Runtime);
        await waitForReady(Runtime);

        // Count cards before sending prompt
        const cardsBefore4c = await countCards(Runtime);

        // "echo *" is in the allow list — should auto-approve (no NEW permission card)
        await sendPrompt(Runtime, "Run the command: echo pattern-whitelist-test");
        await waitForResponse(Runtime, 10, 30);
        await sleep(2000);

        const cardsAfter4c = await countCards(Runtime);
        const newCards4c = cardsAfter4c - cardsBefore4c;
        console.log(
          `   ${newCards4c === 0 ? "✓" : "⚠️"} Pattern whitelist auto-approved (new cards: ${newCards4c})`,
        );
        steps++;

        await screenshot(Page, resultsDir, "23-pattern-whitelist-auto-approved.png");
        console.log("   📸 23-pattern-whitelist-auto-approved.png");
      }

      // 4d: Structured tool auto-approve (Step 7a — permissions.tools map)
      // OBSERVATIONAL ONLY — model non-determinism means we cannot assert whether
      // the SDK actually calls listAutomations. We log the result for manual review
      // but do NOT count this toward the step total.
      {
        await invokeIPC(Runtime, "settingsAPI", "save", {
          ...originalSettings,
          permissions: {
            ...NO_AUTO_APPROVE_PERMISSIONS,
            autoApproveReadOnly: false,
            tools: { "tool:listAutomations": true },
          },
        });
        await sleep(1000);

        await createNewSession(Runtime);
        await waitForReady(Runtime);

        const cardsBefore4d = await countCards(Runtime);

        await sendPrompt(Runtime, "List my automations");
        await waitForResponse(Runtime, 15, 60);
        await sleep(2000);

        const cardsAfter4d = await countCards(Runtime);
        const newCards4d = cardsAfter4d - cardsBefore4d;
        console.log(
          `   ${newCards4d === 0 ? "✓" : "⚠️"} Tool map auto-approved (new cards: ${newCards4d}) [observational — model may not invoke tool]`,
        );
        // steps++ intentionally omitted — observational only

        await screenshot(Page, resultsDir, "23-tool-map-auto-approved.png");
        console.log("   📸 23-tool-map-auto-approved.png");
      }
      // ── Part 5: Per-automation permissions ────────────────────────────
      //
      // Verify that an automation with custom permissions auto-approves tools
      // that the global settings would block.

      console.log("   ── Part 5: Per-automation permissions ──");

      // Set global permissions to deny everything (no auto-approve)
      await invokeIPC(Runtime, "settingsAPI", "save", {
        ...originalSettings,
        permissions: NO_AUTO_APPROVE_PERMISSIONS,
      });
      await sleep(500);

      // Create an automation with custom permissions that auto-approve read-only ops
      const wfResult = await invokeIPC(Runtime, "automationsAPI", "create", {
        name: `Perm Test ${Date.now()}`,
        steps: [
          {
            id: "s1",
            label: "Echo",
            prompt: 'Run this exact command: echo "per-automation-perm-test"',
          },
        ],
        // parseSchedule rejects "never" → manager.create throws → IPC returns
        // { success: false } and wfResult.automation is undefined.
        // Use a parseable schedule; the test calls runNow directly so the
        // schedule never actually fires.
        schedule: { naturalLanguage: "daily at 9am", days: [], hour: 9, minute: 0 },
      });
      const wfId = wfResult?.automation?.id;
      console.log(`   ✓ Created automation: ${wfId}`);
      steps++;

      if (wfId) {
        // Update the automation to add custom permissions (autoApproveReadOnly: true)
        await invokeIPC(Runtime, "automationsAPI", "update", wfId, {
          permissions: {
            autoApproveReadOnly: true,
            allow: [],
            tools: {},
            servers: {
              shell: { enabled: true, autoApprove: false },
            },
          },
        });
        console.log("   ✓ Updated automation with custom permissions (autoApproveReadOnly)");
        steps++;

        // Run the automation — the echo command is read-only, so it should
        // auto-approve under the automation's custom permissions even though
        // global settings have no auto-approve enabled.
        const runResult = await invokeIPC(Runtime, "automationsAPI", "runNow", wfId);
        const runStatus = runResult?.run?.status;
        const runCompleted = runStatus === "completed";
        if (!runCompleted) {
          throw new Error(
            `Automation run status: ${runStatus} (expected "completed") — per-automation permissions may not be applying`,
          );
        }
        console.log(`   ✓ Automation run status: ${runStatus}`);
        steps++;

        await screenshot(Page, resultsDir, "23-per-automation-permissions.png");
        console.log("   📸 23-per-automation-permissions.png");

        // Clean up: delete the test automation
        try {
          await invokeIPC(Runtime, "automationsAPI", "delete", wfId);
        } catch {
          /* best-effort */
        }
      }
    } finally {
      // Always restore E2E test permissions
      try {
        await invokeIPC(Runtime, "settingsAPI", "save", {
          ...originalSettings,
          permissions: E2E_TEST_PERMISSIONS,
        });
        await sleep(1000);
        console.log("   ✓ Restored E2E test permissions");
      } catch (err) {
        console.log(`   ⚠️  Could not restore permissions: ${err.message}`);
      }
    }
    steps++;

    return steps;
  },
};
