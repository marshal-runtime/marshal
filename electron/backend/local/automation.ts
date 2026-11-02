import type {
  AutomationCreateInput,
  AutomationData,
  AutomationRunData,
  ConditionStatusRecord,
  HeartbeatSettings,
} from "../../../common/marshal-ipc-contract";
import { withRollingTimeout } from "../../ipc/with-timeout";
import type {
  HeartbeatOperationResult,
  HeartbeatSettingsEnvelope,
  HeartbeatStatusEnvelope,
  IAutomationBackend,
  IHeartbeatManager,
} from "../types";

const RUN_NOW_INACTIVITY_TIMEOUT_MS = 30_000;

type RunActivitySubscriber = (listener: () => void) => () => void;

export interface IAutomationManagerForBackend {
  list(): AutomationData[];
  create(def: AutomationCreateInput): AutomationData;
  update(id: string, patch: Partial<AutomationData>): AutomationData | null;
  toggle(id: string, enabled: boolean): boolean;
  delete(id: string): boolean;
  getHistory(id: string): AutomationRunData[];
  getAllHistory(): AutomationRunData[];
  getCurrentRun(): AutomationRunData | null;
  runNow(id: string): Promise<AutomationRunData | null>;
  exportAutomation(id: string): string | null;
  importAutomations(
    json: string,
    opts?: { overwrite?: boolean; workingDir?: string; skillNames?: string[] },
  ): AutomationData[];
  getConditionStatus(automationId: string): ConditionStatusRecord;
}

/**
 * IAutomationBackend implementation that delegates to the existing
 * HeartbeatManager and AutomationManager. Managers are injected via setters
 * after construction (same pattern as other local-backend dependencies).
 */
export class LocalAutomationBackend implements IAutomationBackend {
  private hb: IHeartbeatManager | null = null;
  private am: IAutomationManagerForBackend | null = null;
  private runActivitySubscriber: RunActivitySubscriber | null = null;

  setHeartbeatManager(hb: IHeartbeatManager): void {
    this.hb = hb;
  }
  setAutomationManager(am: IAutomationManagerForBackend): void {
    this.am = am;
  }
  setRunActivitySubscriber(subscriber: RunActivitySubscriber): void {
    this.runActivitySubscriber = subscriber;
  }

  private requireHB(): IHeartbeatManager {
    if (!this.hb) throw new Error("LocalAutomationBackend: HeartbeatManager not wired yet");
    return this.hb;
  }
  private requireAM(): IAutomationManagerForBackend {
    if (!this.am) throw new Error("LocalAutomationBackend: AutomationManager not wired yet");
    return this.am;
  }

  async getHeartbeatConfig(): Promise<HeartbeatSettingsEnvelope> {
    return {
      supported: true,
      ...this.requireHB().getSettings(),
      // Every field is editable in local mode; the local HeartbeatManager
      // is the source of truth and accepts arbitrary patches.
      controllable: {
        enabled: true,
        intervalMinutes: true,
        schedule: true,
        prompt: true,
        permissions: true,
        workDays: true,
        workStartHour: true,
        workEndHour: true,
      },
    };
  }
  async updateHeartbeatConfig(
    config: Partial<HeartbeatSettings>,
  ): Promise<HeartbeatOperationResult> {
    const hb = this.requireHB();
    // `enabled` is a lifecycle change (timer + power management) — only
    // `start()` / `stop()` handle the off↔on transitions correctly.
    // `saveSettings` restarts the timer when something like the interval
    // changes mid-run, but it doesn't START a stopped timer (the old
    // `if (this.timer)` guard). Route the toggle through start/stop and
    // pass everything else through saveSettings.
    const { enabled, ...rest } = config;
    if (Object.keys(rest).length > 0) {
      hb.saveSettings(rest);
    }
    if (enabled === true) hb.start();
    else if (enabled === false) hb.stop();
    return { ok: true };
  }
  async getHeartbeatStatus(): Promise<HeartbeatStatusEnvelope> {
    return { supported: true, ...this.requireHB().getStatus() };
  }
  async triggerHeartbeatNow(): Promise<HeartbeatOperationResult> {
    // Same shape as triggerAutomationNow: SDK calls can hang on a stuck
    // tool/network/auth — wrap in a rolling timeout that resets on every
    // session event (subscriber). Without this, the IPC handler can hang
    // indefinitely. The pre-refactor `heartbeat:runNow` IPC handler had
    // `withRollingTimeout(30_000, ...)`; routing through the backend
    // dropped it. Restoring at the backend so both IPC entry points (and
    // any future caller) get the same guard.
    const hb = this.requireHB();
    const subscribe = this.runActivitySubscriber;
    if (!subscribe) {
      await hb.runNow();
      return { ok: true };
    }
    await withRollingTimeout<boolean | void>(RUN_NOW_INACTIVITY_TIMEOUT_MS, (heartbeat) => {
      const unsub = subscribe(() => heartbeat());
      return { promise: hb.runNow(), cleanup: unsub };
    });
    return { ok: true };
  }

  async listAutomations(): Promise<AutomationData[]> {
    return this.requireAM().list();
  }
  async createAutomation(def: AutomationCreateInput): Promise<AutomationData> {
    return this.requireAM().create(def);
  }
  async updateAutomation(id: string, patch: Partial<AutomationData>): Promise<void> {
    this.requireAM().update(id, patch);
  }
  async toggleAutomation(id: string, enabled: boolean): Promise<void> {
    this.requireAM().toggle(id, enabled);
  }
  async deleteAutomation(id: string): Promise<void> {
    // Manager returns boolean; idempotent contract: ignore `false` (already gone).
    this.requireAM().delete(id);
  }
  async getAutomationRuns(id: string): Promise<AutomationRunData[]> {
    return this.requireAM().getHistory(id);
  }
  async getAllAutomationRuns(): Promise<AutomationRunData[]> {
    // O(1) disk scan — bulk path exists on the local manager. The interface
    // contract matters here: automations-ipc.ts used to call this directly
    // pre-refactor, and fanning out per-automation would regress the activities
    // panel's all-history view.
    return this.requireAM().getAllHistory();
  }
  async getCurrentRun(): Promise<AutomationRunData | null> {
    return this.requireAM().getCurrentRun();
  }
  async triggerAutomationNow(id: string): Promise<AutomationRunData | null> {
    const am = this.requireAM();
    const subscribe = this.runActivitySubscriber;
    if (!subscribe) return am.runNow(id);
    return withRollingTimeout<AutomationRunData | null>(
      RUN_NOW_INACTIVITY_TIMEOUT_MS,
      (heartbeat) => {
        const unsub = subscribe(() => heartbeat());
        return { promise: am.runNow(id), cleanup: unsub };
      },
    );
  }

  async exportAutomation(id: string): Promise<string | null> {
    return this.requireAM().exportAutomation(id);
  }

  async importAutomations(json: string, opts?: { overwrite?: boolean }): Promise<AutomationData[]> {
    return this.requireAM().importAutomations(json, opts);
  }

  async getConditionStatus(automationId: string): Promise<ConditionStatusRecord> {
    return this.requireAM().getConditionStatus(automationId);
  }
}
