import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RuntimeUiInstance } from "../../common/runtime-ui";
import type { RuntimeUiDesktopLayout } from "../../common/runtime-ui-layout";
import { secureAtomicWriteFileSync } from "../platform-security";

const STORE_VERSION = 1;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** One session's persisted views and desktop arrangement. */
export interface StoredSessionViews {
  readonly version: typeof STORE_VERSION;
  readonly sessionId: string;
  readonly workspaceName: string;
  readonly updatedAt: string;
  readonly instances: readonly RuntimeUiInstance[];
  readonly desktop?: RuntimeUiDesktopLayout;
}

/**
 * Per-machine store of each session's docked tabs, permanent cards, and
 * desktop layout (one small JSON file per session). Transient cards are never
 * written. Session content itself stays in the session store.
 */
export class RuntimeUiViewStore {
  constructor(
    private readonly root: string,
    private readonly clock: () => number = Date.now,
  ) {}

  read(sessionId: string): StoredSessionViews | undefined {
    return this.readFile(this.fileFor(sessionId));
  }

  writeInstances(
    sessionId: string,
    workspaceName: string,
    instances: readonly RuntimeUiInstance[],
  ): void {
    const previous = this.read(sessionId);
    if (instances.length === 0 && !previous?.desktop) {
      this.remove(sessionId);
      return;
    }
    this.write({
      ...(previous?.desktop ? { desktop: previous.desktop } : {}),
      version: STORE_VERSION,
      sessionId,
      workspaceName,
      updatedAt: new Date(this.clock()).toISOString(),
      instances: instances.filter((instance) => !instance.transient),
    });
  }

  writeDesktopLayout(
    sessionId: string,
    workspaceName: string,
    desktop: RuntimeUiDesktopLayout,
  ): void {
    const previous = this.read(sessionId);
    this.write({
      version: STORE_VERSION,
      sessionId,
      workspaceName,
      updatedAt: new Date(this.clock()).toISOString(),
      instances: previous?.instances ?? [],
      desktop,
    });
  }

  /** Recently updated sessions, newest first; older files are pruned. */
  recent(limit: number, maxAgeMs: number): StoredSessionViews[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.root).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const cutoff = this.clock() - maxAgeMs;
    const files: { readonly file: string; readonly mtime: number }[] = [];
    for (const name of names) {
      const file = path.join(this.root, name);
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (mtime < cutoff) fs.rmSync(file, { force: true });
        else files.push({ file, mtime });
      } catch {
        // A file that disappears or cannot be read is skipped.
      }
    }
    return files
      .sort((left, right) => right.mtime - left.mtime)
      .slice(0, limit)
      .flatMap(({ file }) => this.readFile(file) ?? []);
  }

  remove(sessionId: string): void {
    fs.rmSync(this.fileFor(sessionId), { force: true });
  }

  private write(record: StoredSessionViews): void {
    secureAtomicWriteFileSync(this.fileFor(record.sessionId), JSON.stringify(record), {
      mode: 0o600,
    });
  }

  private fileFor(sessionId: string): string {
    const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 40);
    return path.join(this.root, `${digest}.json`);
  }

  private readFile(file: string): StoredSessionViews | undefined {
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) return undefined;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return isStoredSessionViews(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape check only; every restored instance is re-validated by the controller
 * and every layout is replayed defensively by the renderer.
 */
function isStoredSessionViews(value: unknown): value is StoredSessionViews {
  if (!isRecord(value)) return false;
  if (value.version !== STORE_VERSION) return false;
  if (typeof value.sessionId !== "string" || typeof value.workspaceName !== "string") return false;
  if (!Array.isArray(value.instances) || !value.instances.every(isRecord)) return false;
  if (value.desktop !== undefined) {
    const desktop = value.desktop;
    if (!isRecord(desktop) || !isRecord(desktop.dockview) || !isRecord(desktop.summary)) {
      return false;
    }
    if (!Array.isArray(desktop.summary.placements)) return false;
  }
  return true;
}
