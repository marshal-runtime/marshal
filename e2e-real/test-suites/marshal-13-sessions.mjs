// Marshal-owned real-account harness.
/**
 * 13-sessions: Create a new session, switch back, verify persistence.
 */
import {
  waitForReady,
  sendPrompt,
  waitForResponse,
  getLastAssistantMessage,
  getMessageCount,
  getActiveSessionId,
  isWelcomeVisible,
  invokeIPC,
  screenshot,
  sleep,
  switchToSession,
} from "../marshal-cdp-helpers.mjs";

export default {
  name: "Session Management",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;

    await waitForReady(Runtime);
    steps++;

    const originalSessionId = await getActiveSessionId(Runtime);
    if (!originalSessionId) throw new Error("No active session before session persistence test");

    // Remember the current message count and prove the session exists on disk.
    const initialCount = await getMessageCount(Runtime);
    const before = await invokeIPC(Runtime, "sessionsAPI", "list");
    if (!before?.success || !before.sessions?.some((session) => session.id === originalSessionId)) {
      throw new Error(`Active session ${originalSessionId} was absent from sessions:list`);
    }
    console.log(`   ✓ Current session ${originalSessionId} has ${initialCount} messages`);
    steps++;

    // Create a new session via IPC
    let createdSessionId;
    try {
      const created = await invokeIPC(Runtime, "sessionsAPI", "create");
      if (!created?.success || !created.session?.id) {
        throw new Error(created?.error || "sessions:create returned no session id");
      }
      createdSessionId = created.session.id;
      await sleep(2000);
      steps++;
      console.log(`   ✓ Created new session via IPC: ${createdSessionId}`);
    } catch (err) {
      // Fallback: try clicking the "New chat" button (shared helper).
      console.log(`   ⚠️  IPC create failed (${err.message}), trying UI button`);
      try {
        const { createNewSession } = await import("../marshal-cdp-helpers.mjs");
        createdSessionId = await createNewSession(Runtime);
        if (!createdSessionId) throw new Error("UI create returned no active session id");
        steps++;
      } catch {
        throw new Error("Could not create new session via IPC or UI");
      }
    }

    let removedTestSession = false;
    try {
      // sessions:create persists the row but intentionally does not navigate the
      // renderer. Exercise the real sidebar selection path before asserting UI.
      await switchToSession(Runtime, createdSessionId);
      await waitForReady(Runtime);

      // New session should have 0 messages or show welcome
      const newCount = await getMessageCount(Runtime);
      const welcome = await isWelcomeVisible(Runtime);
      const activeAfterCreate = await getActiveSessionId(Runtime);
      if (activeAfterCreate !== createdSessionId) {
        throw new Error(
          `Created session was not active: expected ${createdSessionId}, got ${activeAfterCreate}`,
        );
      }
      if (newCount !== 0 && !welcome) {
        throw new Error(`Created session was not empty: ${newCount} messages, welcome=${welcome}`);
      }
      console.log(`   ✓ New session: ${newCount} messages, welcome visible: ${welcome}`);
      steps++;

      await screenshot(Page, resultsDir, "13-session-new.png");
      console.log("   📸 13-session-new.png");

      // Send a message in the new session
      await sendPrompt(Runtime, "Say 'session test' and nothing else.");
      await waitForResponse(Runtime, 15, 60);
      steps++;

      const response = await getLastAssistantMessage(Runtime);
      if (!response || !response.toLowerCase().includes("session test")) {
        throw new Error(`Unexpected session response: ${JSON.stringify(response)}`);
      }
      console.log(`   ✓ New session response: "${(response || "").slice(0, 50)}"`);
      steps++;

      // Confirm the new session is persisted before navigating away.
      const persisted = await invokeIPC(Runtime, "sessionsAPI", "list");
      if (!persisted?.success || !persisted.sessions?.some((s) => s.id === createdSessionId)) {
        throw new Error(`Created session ${createdSessionId} was not persisted`);
      }

      await switchToSession(Runtime, originalSessionId);
      console.log(`   ✓ Switched back to previous session: ${originalSessionId}`);
      steps++;

      await waitForReady(Runtime);

      // Verify previous messages are still there
      const restoredCount = await getMessageCount(Runtime);
      const restoredActiveId = await getActiveSessionId(Runtime);
      if (restoredActiveId !== originalSessionId) {
        throw new Error(`Previous session was not active after switch: ${restoredActiveId}`);
      }
      if (restoredCount !== initialCount) {
        throw new Error(
          `Previous session message count changed: ${initialCount} -> ${restoredCount}`,
        );
      }
      console.log(`   ✓ Restored session has ${restoredCount} messages (was ${initialCount})`);
      steps++;

      // Switch to the created session again to prove its messages survive a round trip.
      await switchToSession(Runtime, createdSessionId);
      await waitForReady(Runtime);
      const roundTripResponse = await getLastAssistantMessage(Runtime);
      if (!roundTripResponse?.toLowerCase().includes("session test")) {
        throw new Error(
          `Created session response did not survive switch: ${roundTripResponse || "empty"}`,
        );
      }
      steps++;

      // Leave the user on the original session and remove only our test session.
      await switchToSession(Runtime, originalSessionId);
      const removed = await invokeIPC(Runtime, "sessionsAPI", "delete", createdSessionId);
      if (!removed?.success) throw new Error(removed?.error || "Could not delete test session");
      const afterCleanup = await invokeIPC(Runtime, "sessionsAPI", "list");
      if (afterCleanup?.sessions?.some((s) => s.id === createdSessionId)) {
        throw new Error(`Test session ${createdSessionId} remained after cleanup`);
      }
      removedTestSession = true;
      steps++;

      await screenshot(Page, resultsDir, "13-session-switch.png");
      console.log("   📸 13-session-switch.png");
    } finally {
      if (!removedTestSession && createdSessionId) {
        try {
          await switchToSession(Runtime, originalSessionId);
        } catch {
          // Best effort: sessions:delete selects a surviving session when needed.
        }
        await invokeIPC(Runtime, "sessionsAPI", "delete", createdSessionId);
      }
    }

    return steps;
  },
};
