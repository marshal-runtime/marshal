// Marshal-owned real-account harness.
// Marshal-owned fixed E2E suite.
/**
 * 28-workspace-scope: Verify workspace sessions can only see files in their workspace folder.
 *
 * Creates a temporary workspace with a known marker file, creates a workspace-scoped session,
 * asks the AI what it can see, and asserts it only sees the workspace contents (not parent dirs).
 */
import fs from "fs";
import path from "path";

import { evaluate, screenshot, timestamp, invokeIPC } from "../marshal-cdp-helpers.mjs";

export default {
  name: "Workspace Filesystem Scope",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;
    const ts = timestamp();
    const workspaceName = `e2e-scope-test-${ts}`;
    const markerFileName = `scope-marker-${ts}.txt`;
    const markerContent = `This file proves workspace scoping works. Created at ${ts}`;

    // Resolve workspace root from the app itself so we use the exact same path
    // (on Windows with a cloud-sync client redirecting Documents,
    //  app.getPath("documents") is not the local Documents folder).
    // appAPI.getDefaultWorkspaceDir returns the fully-resolved WORKSPACE_DIR,
    // which already applies any user override from MSettings.workspaceDir.
    const appResult = await invokeIPC(Runtime, "appAPI", "getDefaultWorkspaceDir");
    const workspaceRoot = appResult?.defaultWorkspaceDir;
    if (!workspaceRoot) throw new Error("Could not get workspaceDir from app");
    const testWorkspaceDir = path.join(workspaceRoot, workspaceName);

    try {
      // Step 1: Create the test workspace folder with a marker file
      fs.mkdirSync(testWorkspaceDir, { recursive: true });
      fs.writeFileSync(path.join(testWorkspaceDir, markerFileName), markerContent);
      steps++;
      console.log(`   ✓ Created workspace "${workspaceName}" with marker file`);

      // Step 2: Create a workspace-scoped session via IPC
      const createResult = await invokeIPC(Runtime, "sessionsAPI", "create", null, null, {
        name: `Scope Test: ${workspaceName}`,
        source: "workspace",
        workspaceName,
        setActive: false, // keep as background so main process auto-saves assistant messages
      });
      if (!createResult?.success) {
        throw new Error(`Failed to create workspace session: ${createResult?.error}`);
      }
      const sessionId = createResult.session.id;
      steps++;
      console.log(`   ✓ Created workspace session: ${sessionId}`);

      // Step 3: Send message directly to the workspace session — fire-and-forget.
      // We deliberately bypass sendPrompt() (which types into the chat UI textarea):
      // the chat panel's React activeSessionId state still points to the previous
      // regular session. The workspace session stays as a background session so the
      // main process auto-saves the assistant reply via appendMessage / TurnAccumulator persistence.
      //
      // We do NOT await the Promise (comma operator returns undefined immediately).
      // evaluate() uses awaitPromise:true — if the AI takes >30 s, awaiting the
      // copilotAPI.send promise would block CDP and potentially time out before
      // we even start polling. Fire-and-forget lets the IPC run in the background
      // while we poll sessionsAPI.get for the response.
      // The filesystem self-tools take an explicit path, so name the directories.
      // The session is workspace-scoped to testWorkspaceDir; listing it should
      // succeed (in-workspace), while listing the parent must be confined.
      const prompt =
        `Using your filesystem list tool, list the directory ${testWorkspaceDir}. ` +
        `Then also try to list its parent directory ${workspaceRoot}. ` +
        `Report exactly what each listing shows; if a listing is not permitted, say so.`;
      await evaluate(
        Runtime,
        `(window.copilotAPI.send(${JSON.stringify(prompt)}, ${JSON.stringify(sessionId)}, [])
          .catch(e => console.error('[e2e] send failed:', e)), undefined)`,
      );
      steps++;
      console.log(`   ✓ Sent filesystem listing prompt to background session ${sessionId}`);

      // Poll sessionsAPI.get until the session has a response and is no longer busy.
      // The AI may need up to 60 s for filesystem tool use + response.
      await new Promise((r) => setTimeout(r, 5000));
      let response = null;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const sessionState = await invokeIPC(Runtime, "sessionsAPI", "get", sessionId);
        if (!sessionState?.isBusy) {
          const msgs = sessionState?.session?.messages ?? [];
          const lastAsst = [...msgs].reverse().find((m) => m.role === "assistant");
          if (lastAsst) {
            response = lastAsst.content;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!response) throw new Error("No response from AI about filesystem listing");
      steps++;
      console.log(`   ✓ Got response (${response.length} chars)`);

      await screenshot(Page, resultsDir, "28-workspace-scope-listing.png");
      console.log("   📸 28-workspace-scope-listing.png");

      // Step 5: Verify scoping — response should mention our marker file
      const lowerResponse = response.toLowerCase();
      if (!lowerResponse.includes(markerFileName.toLowerCase())) {
        console.log(`   ⚠️  Response: "${response.slice(0, 300)}"`);
        throw new Error(
          `Workspace session does not see the marker file "${markerFileName}" — filesystem scoping may not be working`,
        );
      }
      steps++;
      console.log(`   ✓ Marker file "${markerFileName}" visible in workspace`);

      // Step 6: Verify the parent listing was confined — a sibling workspace
      // ("Scratchpad") must NOT appear. The session's self-tools are scoped to
      // testWorkspaceDir, so listing the parent is denied by the realpath guard.
      if (lowerResponse.includes("scratchpad")) {
        console.log(`   ⚠️  Response: "${response.slice(0, 300)}"`);
        throw new Error(
          'Workspace session can see "Scratchpad" (sibling workspace) — filesystem is NOT properly scoped',
        );
      }
      steps++;
      console.log('   ✓ Sibling workspace "Scratchpad" NOT visible (scoping works)');

      // Step 7: Clean up — delete session
      await invokeIPC(Runtime, "sessionsAPI", "delete", sessionId);
      steps++;
      console.log("   ✓ Cleaned up workspace session");

      return steps;
    } finally {
      // Always clean up the test workspace folder
      try {
        fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
        console.log(`   ✓ Cleaned up workspace folder "${workspaceName}"`);
      } catch (e) {
        console.log(`   ⚠️  Failed to clean up workspace folder: ${e.message}`);
      }
    }
  },
};
