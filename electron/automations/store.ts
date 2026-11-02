import { createLogger } from "../../common/marshal-logger";
const log = createLogger("AutomationStore");
import * as fs from "fs";
import * as path from "path";

import { getAppDataDir } from "../app-paths";
import { secureMkdirSync, secureWriteFileSync } from "../platform-security";
import type { Automation, AutomationRun } from "./domain/contracts";
import { isRecord, migrateScheduleInPlace } from "./schedule";
import { AutomationRunSchema, AutomationSchema } from "./schemas";

const MAX_HISTORY = 10;

function ensureDir(dir: string) {
  secureMkdirSync(dir, 0o700);
}

/** Computes the canonical automations directory under the user's app-data root.
 *  Exported so cross-cutting consumers (like the cloud-sync adapter's
 *  `isCollectionMissing()` check) don't duplicate the literal path. */
export function getAutomationsDir(): string {
  return path.join(getAppDataDir(), "marshal-automations");
}

/** Handles file-level persistence for automations and their run history. */
export class AutomationStore {
  readonly automationsDir: string;
  readonly automationsFile: string;
  readonly historyDir: string;

  constructor() {
    const dataDir = getAppDataDir();
    this.automationsDir = path.join(dataDir, "marshal-automations");
    this.automationsFile = path.join(this.automationsDir, "automations.json");
    this.historyDir = path.join(this.automationsDir, "history");

    this.migrateFromWorkflows(dataDir);
  }

  private migrateFromWorkflows(dataDir: string): void {
    const oldDir = path.join(dataDir, "marshal-workflows");
    if (fs.existsSync(this.automationsDir) || !fs.existsSync(oldDir)) return;

    try {
      fs.renameSync(oldDir, this.automationsDir);
      const oldFile = path.join(this.automationsDir, "workflows.json");
      if (fs.existsSync(oldFile)) {
        fs.renameSync(oldFile, this.automationsFile);
      }
      log.info("[AutomationStore] Migrated marshal-workflows/ → marshal-automations/");
    } catch (err) {
      log.warn("[AutomationStore] Migration failed, will retry on next read:", err);
    }
  }

  loadAutomations(): Automation[] {
    if (!fs.existsSync(this.automationsFile)) {
      const dataDir = getAppDataDir();
      this.migrateFromWorkflows(dataDir);
    }
    try {
      if (fs.existsSync(this.automationsFile)) {
        const raw = JSON.parse(fs.readFileSync(this.automationsFile, "utf-8")); // SF-4: validated per-entry below via AutomationSchema.safeParse;
        if (!Array.isArray(raw)) return [];
        const automations: Automation[] = [];
        for (const item of raw) {
          if (item && typeof item === "object" && !item.triggerType) {
            item.triggerType = "schedule";
          }
          if (isRecord(item) && isRecord(item.schedule)) {
            migrateScheduleInPlace(item.schedule);
          }
          const result = AutomationSchema.safeParse(item);
          if (result.success) {
            automations.push(result.data);
          } else {
            log.warn("[AutomationStore] Skipping invalid automation entry:", result.error.format());
          }
        }
        return automations;
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  saveAutomations(automations: Automation[]) {
    ensureDir(this.automationsDir);
    secureWriteFileSync(this.automationsFile, JSON.stringify(automations, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  loadHistory(automationId: string): AutomationRun[] {
    try {
      const file = path.join(this.historyDir, `${automationId}.json`);
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf-8")); // SF-4: validated per-entry below via AutomationRunSchema.safeParse;
        if (!Array.isArray(raw)) return [];
        const runs: AutomationRun[] = [];
        for (const item of raw) {
          if (item && typeof item === "object") {
            if (item.workflowId && !item.automationId) item.automationId = item.workflowId;
            if (item.workflowName && !item.automationName) item.automationName = item.workflowName;
          }
          const result = AutomationRunSchema.safeParse(item);
          if (result.success) {
            runs.push(result.data);
          } else {
            log.warn("[AutomationStore] Skipping invalid run entry:", result.error.format());
          }
        }
        return runs;
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  saveHistory(automationId: string, runs: AutomationRun[]) {
    ensureDir(this.historyDir);
    const trimmed = runs.slice(-MAX_HISTORY);
    secureWriteFileSync(
      path.join(this.historyDir, `${automationId}.json`),
      JSON.stringify(trimmed, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
  }

  /** Returns all run history across all automations, including deleted ones. */
  getAllHistory(): AutomationRun[] {
    const runs: AutomationRun[] = [];
    try {
      if (!fs.existsSync(this.historyDir)) return runs;
      const files = fs.readdirSync(this.historyDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(this.historyDir, file), "utf-8")); // SF-4: validated per-entry below via AutomationRunSchema.safeParse;
          if (!Array.isArray(raw)) continue;
          for (const item of raw) {
            if (item && typeof item === "object") {
              if (item.workflowId && !item.automationId) item.automationId = item.workflowId;
              if (item.workflowName && !item.automationName)
                item.automationName = item.workflowName;
            }
            const result = AutomationRunSchema.safeParse(item);
            if (result.success) runs.push(result.data);
          }
        } catch {
          /* skip malformed file */
        }
      }
    } catch {
      /* ignore */
    }
    return runs;
  }
}
