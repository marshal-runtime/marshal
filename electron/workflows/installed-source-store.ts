// electron/workflows/installed-source-store.ts
//
// `.installed.json` sidecar — the trusted source-of-truth for a workflow's
// install transport. Per r1-fixes A12, manifest.json's `source` field is
// IGNORED on disk; this file is the only authoritative answer to
// "where did this workflow come from?".

import * as fs from "node:fs";
import * as path from "node:path";

import { createLogger } from "../../common/marshal-logger";
import { InstalledSourceSchema, type InstalledSource } from "../../common/workflows-contract";

const log = createLogger("WorkflowInstalledSource");
const SIDECAR_FILENAME = ".installed.json";

export function sidecarPath(workflowDir: string): string {
  return path.join(workflowDir, SIDECAR_FILENAME);
}

export function readInstalledSource(workflowDir: string): InstalledSource | null {
  const file = sidecarPath(workflowDir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsedJson = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    const parsed = InstalledSourceSchema.safeParse(parsedJson);
    if (!parsed.success) {
      log.warn(`.installed.json schema mismatch in ${workflowDir}:`, parsed.error.issues);
      return null;
    }
    return parsed.data;
  } catch (err) {
    log.warn(`Failed to read .installed.json in ${workflowDir}:`, err);
    return null;
  }
}

export function writeInstalledSource(workflowDir: string, source: InstalledSource): void {
  fs.mkdirSync(workflowDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(sidecarPath(workflowDir), JSON.stringify(source, null, 2), {
    mode: 0o600,
  });
}
