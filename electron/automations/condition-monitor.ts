import { createLogger } from "../../common/marshal-logger";
const log = createLogger("AutomationConditionMonitor");
import type { PermissionsConfig } from "../../common/marshal-ipc-contract";
import type { PermissionPolicy } from "../permission-policy";
import type { SessionManager } from "../sessions";
import type { Automation, AutomationRun } from "./domain/contracts";

/** Callback interface for actions the condition monitor needs from the manager */
export interface AutomationConditionMonitorDeps {
  loadAutomations(): Automation[];
  executeAutomation(automation: Automation, isManual: boolean): Promise<AutomationRun>;
  makePermissionPersistCallback(automationId: string): (updated: PermissionsConfig) => void;
}

/**
 * Manages condition-based automation checking.
 * Owns all condition timer state and delegates execution back to the manager via callbacks.
 */
export class AutomationConditionMonitor {
  private conditionsInFlight = new Set<string>();
  private conditionTimers = new Map<string, ReturnType<typeof setInterval>>();
  private conditionSessionIds = new Map<string, string>();
  private conditionLastCheck = new Map<string, string>();
  private conditionLastError = new Map<string, string>();
  private conditionTimerStarted = new Map<string, string>();
  /** Cached interval from startFor(), avoids re-reading disk in getStatus(). */
  private conditionCheckIntervalMs = new Map<string, number>();

  private sessionManager: SessionManager | null = null;
  private permissionPolicy!: PermissionPolicy;
  private deps!: AutomationConditionMonitorDeps;

  setSessionManager(sm: SessionManager) {
    this.sessionManager = sm;
  }

  setPermissionPolicy(policy: PermissionPolicy) {
    this.permissionPolicy = policy;
  }

  resetRuntimeSessions(): void {
    this.conditionSessionIds.clear();
  }

  setDeps(deps: AutomationConditionMonitorDeps) {
    this.deps = deps;
  }

  /** Start a per-condition check timer */
  startFor(automation: Automation) {
    this.stopFor(automation.id);
    const VALID_INTERVALS = [5, 15, 30, 60];
    const rawInterval = automation.conditionCheckInterval ?? 15;
    const interval = VALID_INTERVALS.includes(rawInterval) ? rawInterval : 15;
    const intervalMs = interval * 60_000;
    const timer = setInterval(() => this.check(automation.id), intervalMs);
    this.conditionTimers.set(automation.id, timer);
    this.conditionCheckIntervalMs.set(automation.id, intervalMs);
    this.conditionTimerStarted.set(automation.id, new Date().toISOString());
    log.info(
      `[AutomationConditionMonitor] Timer started for "${automation.name}" (every ${interval}m)`,
    );
    // Run first check immediately
    void this.check(automation.id);
  }

  /** Stop a per-condition check timer */
  stopFor(automationId: string) {
    const timer = this.conditionTimers.get(automationId);
    if (timer) {
      clearInterval(timer);
      this.conditionTimers.delete(automationId);
    }
    // Clean up the dedicated condition-check session
    const sessionId = this.conditionSessionIds.get(automationId);
    if (sessionId && this.sessionManager) {
      this.sessionManager
        .deleteSession(sessionId, { suppressChangeEvent: true, cause: "condition-check" })
        .catch((err) =>
          log.error(
            `[AutomationConditionMonitor] Failed to delete condition session: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
    this.conditionSessionIds.delete(automationId);
    this.conditionLastCheck.delete(automationId);
    this.conditionLastError.delete(automationId);
    this.conditionTimerStarted.delete(automationId);
    this.conditionCheckIntervalMs.delete(automationId);
  }

  /** Check a single condition */
  private async check(automationId: string) {
    if (this.conditionsInFlight.has(automationId)) return;
    if (!this.sessionManager) return;
    this.conditionsInFlight.add(automationId);

    try {
      const automation = this.deps
        .loadAutomations()
        .find((w) => w.id === automationId && w.enabled);
      if (!automation || automation.triggerType !== "condition") {
        this.stopFor(automationId);
        return;
      }

      // Get or create dedicated session
      let sessionId = this.conditionSessionIds.get(automationId);
      if (!sessionId) {
        const meta = await this.sessionManager.createSession(automation.model, undefined, {
          setActive: false,
          source: "automation",
          name: `Condition check: ${automation.name}`,
          workspaceName: automation.workspaceName,
          repoPath: automation.repoPath,
        });
        sessionId = meta.id;
        this.conditionSessionIds.set(automationId, sessionId);
      } else {
        const existing = this.sessionManager.getSession(sessionId);
        const effectiveModel = automation.model ?? this.sessionManager.getDefaultModel();
        if (existing && existing.model !== effectiveModel) {
          await this.sessionManager.updateSessionModelQuietly(sessionId, effectiveModel);
        }
      }

      const hasCustomPermissions = !!automation.permissions;
      try {
        if (hasCustomPermissions) {
          this.permissionPolicy.registerSessionPermissions(
            sessionId,
            automation.permissions!,
            this.deps.makePermissionPersistCallback(automation.id),
          );
        }

        // Condition checks run in background — deny instead of hanging on prompts.
        // markUnattended: restrict custom-tool auto-approve to unattended-safe tools only.
        this.permissionPolicy.setDenyPrompt(sessionId);
        this.permissionPolicy.markUnattended(sessionId);

        const prompt = this.buildCheckPrompt(automation.condition!);
        const result = await this.sessionManager.sendAndCollect(
          prompt,
          180_000,
          undefined,
          sessionId,
        );

        if (result.kind !== "ok") {
          const msg = `Condition check produced no response (${result.kind})`;
          this.conditionLastError.set(automationId, msg);
          this.conditionLastCheck.set(automationId, new Date().toISOString());
          log.warn(`[AutomationConditionMonitor] ${msg} for: ${automation.name}`);
          return;
        }

        this.conditionLastCheck.set(automationId, new Date().toISOString());
        this.conditionLastError.delete(automationId);

        if (result.text.includes("CONDITION_MET")) {
          this.stopFor(automationId);
          log.info(`[AutomationConditionMonitor] Condition met for: ${automation.name}`);
          try {
            await this.deps.executeAutomation(automation, false);
          } catch (err) {
            log.error(
              `[AutomationConditionMonitor] Condition automation failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } finally {
        if (hasCustomPermissions) {
          this.permissionPolicy.unregisterSessionPermissions(sessionId);
        }
        this.permissionPolicy.clearDenyPrompt(sessionId);
        this.permissionPolicy.clearUnattended(sessionId);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(
        `[AutomationConditionMonitor] Condition check failed for ${automationId}: ${errMsg}`,
      );
      this.conditionLastCheck.set(automationId, new Date().toISOString());
      this.conditionLastError.set(automationId, errMsg);
      this.conditionSessionIds.delete(automationId);
    } finally {
      this.conditionsInFlight.delete(automationId);
    }
  }

  private buildCheckPrompt(condition: string): string {
    let prompt = "You are checking whether a condition is met.\n\n";
    prompt += `## Condition\n${condition}\n\n`;
    prompt += "Check this condition using available tools. ";
    prompt += "If the condition is NOW satisfied, output: CONDITION_MET\n";
    prompt += "If NOT satisfied, output: CONDITION_NOT_MET\n\n";
    prompt += "Check now and report.";
    return prompt;
  }

  /** Get condition check status for an automation */
  getStatus(automationId: string): {
    lastCheck: string | null;
    nextCheck: string | null;
    lastError: string | null;
  } {
    const lastCheck = this.conditionLastCheck.get(automationId) ?? null;
    const lastError = this.conditionLastError.get(automationId) ?? null;
    const intervalMs = this.conditionCheckIntervalMs.get(automationId);
    if (!intervalMs) return { lastCheck, nextCheck: null, lastError };
    const referenceTime = lastCheck ?? this.conditionTimerStarted.get(automationId) ?? null;
    if (!referenceTime) return { lastCheck, nextCheck: null, lastError };
    const next = new Date(new Date(referenceTime).getTime() + intervalMs).toISOString();
    return { lastCheck, nextCheck: next, lastError };
  }

  /** Stop all condition timers */
  destroy() {
    for (const [id] of this.conditionTimers) {
      this.stopFor(id);
    }
  }
}
