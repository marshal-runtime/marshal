/**
 * 33-marshal-fs-tools: Marshal filesystem self-tools + the out-of-workspace
 * folder-grant CARD flow (real app, CDP). Companion to plan Task 11.
 *
 * Complements 28-workspace-scope (which proves CONTAINMENT — a workspace
 * session can't see siblings). This proves the other half: CONSENTED ESCAPE —
 * the user can reach outside the workspace by approving a folder-grant card,
 * and that grant then covers the rest of that folder.
 *
 * Flow:
 *   1. Registration / build guard — File System Access is a capability (no
 *      `mcp:filesystem` group) and the `filesystem_*` self-tools exist.
 *   2. Out-of-workspace `listLocalFiles` (my self-tool) with NO prior grant
 *      → a permission card appears → click "Allow everywhere" → the list
 *      succeeds and surfaces the two files in the folder.
 *   3. Read a DIFFERENT file from that same folder → NO new card (the folder
 *      grant from step 2 covers siblings) → its content comes back. This is the
 *      path the reviewer's session-effective realpath guard had to honor.
 *
 * Asserted on-disk where possible and via the rendered card / response text.
 * Requires the app built from this branch (`pnpm electron:debug`) + signed in.
 */
import fs from "fs";
import os from "os";
import path from "path";

import {
  waitForReady,
  sendPrompt,
  waitForResponse,
  getLastAssistantMessage,
  getToolCalls,
  screenshot,
  timestamp,
  invokeIPC,
  sleep,
  createNewSession,
  clickCardButton,
  pendingCardVisible,
} from "../marshal-cdp-helpers.mjs";

export default {
  name: "Marshal Filesystem Self-Tools (folder-grant card flow)",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;
    const ts = timestamp();

    await waitForReady(Runtime);
    steps++;

    // ── 1. Build guard — File System Access is a capability, not an MCP server.
    // The `filesystem_*` self-tools are registered per-session in buildAllTools
    // (their UI surface is the File System Access capability block), so they do
    // NOT appear in the static `listTools` registry — the absence of the
    // `mcp:filesystem` MCP group is the build marker. Steps 2–3 then prove the
    // self-tools actually run.
    const toolsRes = await invokeIPC(Runtime, "permissionsAPI", "listTools");
    const flat = JSON.stringify(toolsRes?.categories ?? []);
    if (/mcp:filesystem/.test(flat)) {
      throw new Error(
        "Found an `mcp:filesystem` MCP group — the running app is NOT built from the fs-tools " +
          "branch (relaunch `pnpm electron:debug`).",
      );
    }
    steps++;
    console.log("   ✓ No mcp:filesystem MCP group — File System Access is a capability");

    // Always start from a clean chat so prior runs / leftover cards don't leak in.
    await createNewSession(Runtime);
    steps++;

    // Out-of-workspace folder with two files, NOT granted yet.
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `marshal-fs-${ts}-`)));
    const fileAName = `alpha-${ts}.txt`;
    const fileBName = `bravo-${ts}.txt`;
    const fileBContent = `BRAVO-CONTENT-${ts}`;
    fs.writeFileSync(path.join(outsideDir, fileAName), `alpha ${ts}`);
    fs.writeFileSync(path.join(outsideDir, fileBName), fileBContent);

    // Make sure this folder is NOT pre-granted (clean slate for the card flow).
    const settingsRes = await invokeIPC(Runtime, "settingsAPI", "get");
    const settings = settingsRes?.settings ?? settingsRes;
    const basePerms = settings.permissions ?? {};

    try {
      // ── 2. Out-of-workspace list → CARD → "Allow everywhere" ─────────────
      await sendPrompt(
        Runtime,
        `List the contents of the directory ${outsideDir} using your filesystem list tool. ` +
          `Report the exact file names you see.`,
      );
      const clicked = await clickCardButton(
        Runtime,
        ["Allow everywhere", "Allow for session", "Allow"],
        60,
      );
      await screenshot(Page, resultsDir, "33-fs-card.png");
      if (!clicked) {
        throw new Error(
          "No folder-grant permission card appeared for an out-of-workspace list — " +
            "the folder-grant prompt path is not engaging.",
        );
      }
      console.log(`   ✓ Out-of-workspace list raised a card; clicked "${clicked}"`);
      await waitForResponse(Runtime, 5, 90);
      const r1 = (await getLastAssistantMessage(Runtime)) || "";
      // Assert on the tool-call result JSON (authoritative — proves the tool ran
      // and returned the entries), not just the model's prose, which may
      // paraphrase or omit names. Narration is accepted as a fallback signal.
      const calls1 = await getToolCalls(Runtime);
      const calls1Str = JSON.stringify(calls1);
      const surfaced = (name) => calls1Str.includes(name) || r1.includes(name);
      if (!surfaced(fileAName) || !surfaced(fileBName)) {
        console.log(`   ⚠️  list response: "${r1.slice(0, 250)}"`);
        console.log(`   ⚠️  tool calls: ${calls1Str.slice(0, 250)}`);
        throw new Error("listLocalFiles did not surface both files after the folder grant");
      }
      steps++;
      console.log(`   ✓ list returned both files. tool lines: ${calls1Str.slice(0, 160)}`);

      // ── 3. Read a SIBLING file → no new card → content returned ──────────
      await sendPrompt(
        Runtime,
        `Read the file ${path.join(outsideDir, fileBName)} and tell me exactly what's in it.`,
      );
      // Poll until the sibling read actually completes; fail fast if a card
      // appears (a card would mean the grant didn't cover siblings — the bug).
      // A flat sleep+check could pass vacuously before the model even invokes
      // the read, so gate the "no card" conclusion on real progress (the file
      // content appearing).
      let siblingRead = false;
      for (let i = 0; i < 45; i++) {
        if (await pendingCardVisible(Runtime)) {
          await screenshot(Page, resultsDir, "33-fs-unexpected-card.png");
          throw new Error(
            "A permission card appeared when reading a SIBLING of an already-granted folder — " +
              "the folder grant is not covering the rest of the directory (session-effective guard regression).",
          );
        }
        const r2now = (await getLastAssistantMessage(Runtime)) || "";
        if (r2now.includes(fileBContent)) {
          siblingRead = true;
          break;
        }
        await sleep(2000);
      }
      await screenshot(Page, resultsDir, "33-fs-sibling-read.png");
      if (!siblingRead) {
        throw new Error(
          "Sibling file content was not returned after the folder grant (no content and no card within timeout)",
        );
      }
      steps++;
      console.log("   ✓ sibling file read with no new card — folder grant covers the directory");

      return steps;
    } finally {
      // Drop any folder grant the card flow persisted; restore base permissions.
      try {
        const after = await invokeIPC(Runtime, "settingsAPI", "get");
        const cur = after?.settings ?? after;
        await invokeIPC(Runtime, "settingsAPI", "save", { ...cur, permissions: basePerms });
      } catch {
        // best-effort; the runner restores original settings at the end anyway
      }
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  },
};
