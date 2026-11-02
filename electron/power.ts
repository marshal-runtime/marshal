import { powerSaveBlocker } from "electron";

import { createLogger } from "../common/marshal-logger";

const log = createLogger("Power");

export class PowerManager {
  private blockerId: number | null = null;
  private displayBlockerId: number | null = null;
  private displaySleepRefs = new Set<string>();
  private busySessions: Set<string> = new Set();

  /**
   * Mark a session as busy (actively processing).
   * Starts power save blocker if this is the first busy session.
   */
  markBusy(sessionId: string): void {
    this.busySessions.add(sessionId);
    if (this.busySessions.size === 1 && this.blockerId === null) {
      this.blockerId = powerSaveBlocker.start("prevent-app-suspension");
      log.info(
        `Sleep blocker started (id=${this.blockerId}), busy sessions: ${this.busySessions.size}`,
      );
    }
  }

  /**
   * Mark a session as idle (finished processing).
   * Stops power save blocker if no sessions remain busy.
   */
  markIdle(sessionId: string): void {
    this.busySessions.delete(sessionId);
    if (this.busySessions.size === 0 && this.blockerId !== null) {
      powerSaveBlocker.stop(this.blockerId);
      log.info(`Sleep blocker stopped (id=${this.blockerId})`);
      this.blockerId = null;
    }
  }

  /**
   * Prevent system idle sleep for the given reason (e.g. "heartbeat", "relay").
   * Uses `prevent-app-suspension` so the display can still sleep and the screen can lock —
   * only system-level idle sleep / hibernate is blocked. Ref-counted across reasons.
   */
  preventSleep(reason: string): void {
    this.displaySleepRefs.add(reason);
    if (this.displayBlockerId === null) {
      this.displayBlockerId = powerSaveBlocker.start("prevent-app-suspension");
      log.info(`System sleep blocker started (reason: ${reason})`);
    } else {
      log.info(
        `System sleep hold acquired: ${reason} (active: ${[...this.displaySleepRefs].join(", ")})`,
      );
    }
  }

  /**
   * Release a system sleep hold. Blocker stops when all holds are released.
   */
  allowSleep(reason: string): void {
    this.displaySleepRefs.delete(reason);
    if (this.displaySleepRefs.size === 0 && this.displayBlockerId !== null) {
      powerSaveBlocker.stop(this.displayBlockerId);
      log.info(`System sleep blocker stopped (released: ${reason})`);
      this.displayBlockerId = null;
    } else if (this.displayBlockerId !== null) {
      log.info(
        `System sleep hold released: ${reason} (remaining: ${[...this.displaySleepRefs].join(", ")})`,
      );
    }
  }

  /**
   * Check if power save blocker is active.
   */
  isBlocking(): boolean {
    return (
      (this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId)) ||
      (this.displayBlockerId !== null && powerSaveBlocker.isStarted(this.displayBlockerId))
    );
  }

  /**
   * Get count of currently busy sessions.
   */
  busyCount(): number {
    return this.busySessions.size;
  }

  /**
   * Force-stop the blocker and clear all state.
   * Called on app quit for clean shutdown.
   */
  destroy(): void {
    if (this.blockerId !== null) {
      try {
        powerSaveBlocker.stop(this.blockerId);
      } catch {
        // ignore — may already be stopped
      }
      this.blockerId = null;
    }
    if (this.displayBlockerId !== null) {
      try {
        powerSaveBlocker.stop(this.displayBlockerId);
      } catch {
        // ignore — may already be stopped
      }
      this.displayBlockerId = null;
    }
    this.busySessions.clear();
    this.displaySleepRefs.clear();
  }
}
