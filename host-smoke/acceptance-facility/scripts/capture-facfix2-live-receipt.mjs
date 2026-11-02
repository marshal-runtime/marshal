#!/usr/bin/env node
// F-DEPLOY-2b deliverable 4: end-to-end safe verification against the REAL,
// running Marshal. EXPLICITLY authorized for this lane only (this facility's
// swarm task's deliverable 4 — the parent uses this exact route already):
// connect → metadata verify → match marshal://app/index.html → the single
// mandatory marker-probe evaluate → clean disconnect. No other evaluate,
// nothing mutated. Requires the same explicit opt-in every other live path
// in this facility requires (ACCEPTANCE_FACILITY_ALLOW_LIVE=1,
// ACCEPTANCE_FACILITY_CDP_PORT) — never runs by accident, and is NOT part of
// run-all.mjs's offline pipeline.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  connectToRunningMarshal,
  liveModePort,
  liveModeRequested,
} from "../lib/live-connection.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = path.resolve(__dirname, "..", "test-receipts");

async function main() {
  const lines = [
    "=== F-DEPLOY-2b LIVE VERIFICATION: connectToRunningMarshal() against the real, running Marshal ===",
    "",
  ];
  if (!liveModeRequested()) {
    throw new Error(
      "ACCEPTANCE_FACILITY_ALLOW_LIVE=1 is required — this script connects to a real, running Marshal.",
    );
  }
  const port = liveModePort();
  lines.push(`Explicit port: ${port} (ACCEPTANCE_FACILITY_CDP_PORT) — no default.`);
  lines.push("");
  lines.push("connectToRunningMarshal() performs, in order, as its own single call:");
  lines.push(
    "  1. metadata verify — /json/version fetched, isKnownNonMarshalBrowserString(Browser, User-Agent).",
  );
  lines.push(
    "  2. target match — marshal://app/index.html (primary) or legacy /dist/index.html; no [0] fallback.",
  );
  lines.push(
    "  3. the single mandatory marker-probe evaluate (window.sessionsAPI/window.runtimeUiAPI) — the FIRST " +
      "and only evaluate this connector ever runs.",
  );
  lines.push("");
  const startedAt = new Date().toISOString();
  lines.push(`Calling connectToRunningMarshal(${port}) at ${startedAt}...`);
  const { client, target } = await connectToRunningMarshal(port);
  lines.push(`ACCEPTED. Matched page: ${target.url}`);
  lines.push(
    "Metadata verify passed (User-Agent carried the Marshal/Electron markers) and the marker probe " +
      "confirmed window.sessionsAPI/window.runtimeUiAPI exist on this page.",
  );
  lines.push("");
  lines.push(
    "Step 4: clean disconnect. No further CDP call is made — no readResource, no invoke, no other evaluate.",
  );
  await client.close();
  const finishedAt = new Date().toISOString();
  lines.push(`Disconnected at ${finishedAt}.`);
  lines.push("");
  lines.push(
    "Summary: this script performed exactly one Runtime.evaluate for the entire run (the mandatory marker " +
      "probe inside connectToRunningMarshal()), then closed the CDP client. Nothing else evaluated; nothing " +
      "mutated.",
  );
  const filePath = path.join(RECEIPTS_DIR, "facfix2-live-9333.txt");
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
  process.stdout.write(`${filePath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
