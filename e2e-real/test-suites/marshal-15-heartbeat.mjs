// Marshal-owned real-account harness.
/**
 * 15-heartbeat: Configure, enable, run, verify, and restore the real heartbeat
 * service through its production Electron IPC surface.
 */
import { invokeIPC, screenshot, sleep } from "../marshal-cdp-helpers.mjs";

function assertSuccessful(result, operation) {
  if (!result?.success) throw new Error(result?.error || `${operation} failed`);
  return result;
}

async function waitForHeartbeatState(Runtime, enabled, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = assertSuccessful(
      await invokeIPC(Runtime, "heartbeatAPI", "status"),
      "heartbeat:status",
    );
    if (result.status?.supported === false) {
      throw new Error("Heartbeat is unsupported by this backend");
    }
    if (result.status?.enabled === enabled) return result.status;
    await sleep(500);
  }
  throw new Error(`Heartbeat did not become ${enabled ? "enabled" : "disabled"}`);
}

async function waitForNewHeartbeatLog(Runtime, knownKeys, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = assertSuccessful(
      await invokeIPC(Runtime, "heartbeatAPI", "getLogs", 30),
      "heartbeat:getLogs",
    );
    const fresh = (result.logs || []).filter(
      (entry) => !knownKeys.has(`${entry.timestamp}|${entry.type}|${entry.message}`),
    );
    const failure = fresh.find((entry) => entry.type === "error");
    if (failure) throw new Error(`Heartbeat logged an error: ${failure.message}`);
    const completed = fresh.find((entry) => entry.type === "complete");
    if (completed) return { completed, fresh };
    await sleep(1000);
  }
  throw new Error("Heartbeat run produced no new completion log");
}

export default {
  name: "Heartbeat",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;

    const originalSettingsResult = assertSuccessful(
      await invokeIPC(Runtime, "heartbeatAPI", "getSettings"),
      "heartbeat:getSettings",
    );
    if (originalSettingsResult.settings?.supported === false) {
      throw new Error("Heartbeat is unsupported by this backend");
    }
    const originalSettings = originalSettingsResult.settings;
    const originalStatus = assertSuccessful(
      await invokeIPC(Runtime, "heartbeatAPI", "status"),
      "heartbeat:status",
    ).status;
    const sessionsBefore = assertSuccessful(
      await invokeIPC(Runtime, "sessionsAPI", "list"),
      "sessions:list",
    );
    const existingSessionIds = new Set(
      (sessionsBefore.sessions || []).map((session) => session.id),
    );
    steps++;

    try {
      assertSuccessful(
        await invokeIPC(Runtime, "heartbeatAPI", "saveSettings", {
          intervalMinutes: 60,
          schedule: "always",
          prompt: "Respond with exactly HEARTBEAT REAL OK.",
        }),
        "heartbeat:saveSettings",
      );
      assertSuccessful(
        await invokeIPC(Runtime, "heartbeatAPI", "toggle", true),
        "heartbeat:toggle(true)",
      );
      await waitForHeartbeatState(Runtime, true);

      const configured = assertSuccessful(
        await invokeIPC(Runtime, "heartbeatAPI", "getSettings"),
        "heartbeat:getSettings",
      ).settings;
      if (configured?.intervalMinutes !== 60 || configured?.schedule !== "always") {
        throw new Error(
          `Heartbeat configuration did not persist: ${JSON.stringify(configured || null)}`,
        );
      }
      if (configured?.prompt !== "Respond with exactly HEARTBEAT REAL OK.") {
        throw new Error(`Heartbeat prompt did not persist: ${configured?.prompt || "empty"}`);
      }
      steps++;
      console.log("   ✓ Heartbeat settings and enabled state persisted");

      const logsBefore = assertSuccessful(
        await invokeIPC(Runtime, "heartbeatAPI", "getLogs", 30),
        "heartbeat:getLogs",
      );
      const knownLogKeys = new Set(
        (logsBefore.logs || []).map((entry) => `${entry.timestamp}|${entry.type}|${entry.message}`),
      );

      assertSuccessful(await invokeIPC(Runtime, "heartbeatAPI", "runNow"), "heartbeat:runNow");
      const { fresh } = await waitForNewHeartbeatLog(Runtime, knownLogKeys);
      steps++;
      console.log(`   ✓ Real heartbeat run completed with ${fresh.length} new log entries`);

      await screenshot(Page, resultsDir, "15-heartbeat-run.png");
      console.log("   📸 15-heartbeat-run.png");

      assertSuccessful(
        await invokeIPC(Runtime, "heartbeatAPI", "toggle", false),
        "heartbeat:toggle(false)",
      );
      await waitForHeartbeatState(Runtime, false);
      steps++;
      console.log("   ✓ Heartbeat disable persisted");
    } finally {
      if (originalSettings?.supported === true) {
        const {
          supported: _supported,
          controllable: _controllable,
          enabled: _enabled,
          ...restoredSettings
        } = originalSettings;
        await invokeIPC(Runtime, "heartbeatAPI", "saveSettings", restoredSettings);
      }
      if (originalStatus?.supported === true) {
        await invokeIPC(Runtime, "heartbeatAPI", "toggle", originalStatus.enabled);
      }

      // Remove only heartbeat sessions created by this suite. Existing user
      // sessions, including a previously pinned heartbeat session, are untouched.
      const sessionsAfter = await invokeIPC(Runtime, "sessionsAPI", "list");
      for (const session of sessionsAfter?.sessions || []) {
        if (!existingSessionIds.has(session.id) && session.source === "heartbeat") {
          await invokeIPC(Runtime, "sessionsAPI", "delete", session.id);
        }
      }
    }

    return steps;
  },
};
