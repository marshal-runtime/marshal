// Marshal-owned real-account harness.
// Marshal-owned fixed E2E suite.
/**
 * 01-smoke: Verify app loads, auth is green, welcome state visible.
 */
import {
  waitForReady,
  isWelcomeVisible,
  isInputEnabled,
  getAuthStatus,
  screenshot,
  checkForErrors,
  invokeIPC,
} from "../marshal-cdp-helpers.mjs";

export default {
  name: "Smoke Test",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;

    // Step 1: Wait for app to be ready
    await waitForReady(Runtime);
    steps++;
    console.log("   ✓ App is ready, textarea enabled");

    // Step 2: Check auth status
    const auth = await getAuthStatus(Runtime);
    if (!auth || auth === "missing") {
      throw new Error(`Auth status indicator not found or not authenticated: ${auth}`);
    }
    steps++;
    console.log(`   ✓ Auth status: ${auth}`);

    // Step 3: Check welcome state
    const welcome = await isWelcomeVisible(Runtime);
    // Welcome might not be visible if there's an existing session — that's OK
    steps++;
    console.log(`   ✓ Welcome state visible: ${welcome}`);

    // Step 4: Verify input is enabled
    const enabled = await isInputEnabled(Runtime);
    if (!enabled) throw new Error("Chat input is disabled");
    steps++;
    console.log("   ✓ Chat input is enabled");

    // Step 5: Check for errors
    const errors = await checkForErrors(Runtime);
    if (errors.length > 0) {
      console.log(`   ⚠️  Errors found: ${errors.join(", ")}`);
    }
    steps++;

    // Step 6: Verify E2E permissions are seeded by the runner
    try {
      const settingsResult = await invokeIPC(Runtime, "settingsAPI", "get");
      const perms = settingsResult?.settings?.permissions ?? settingsResult?.permissions;
      if (!perms?.autoApproveReadOnly) {
        throw new Error(
          "E2E permissions not seeded — autoApproveReadOnly is off. Runner should seed permissions before suites.",
        );
      }
      if (!perms?.servers?.shell?.autoApprove) {
        throw new Error("E2E permissions not seeded — shell.autoApprove is off.");
      }
      console.log("   ✓ E2E permissions verified (autoApproveReadOnly + shell.autoApprove)");
    } catch (err) {
      if (err.message.includes("E2E permissions not seeded")) throw err;
      console.log(`   ⚠️  Could not verify permissions: ${err.message}`);
    }
    steps++;

    await screenshot(Page, resultsDir, "01-smoke-ready.png");
    console.log("   📸 01-smoke-ready.png");

    return steps;
  },
};
