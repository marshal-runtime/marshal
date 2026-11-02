import { EventEmitter } from "events";

import { createLogger } from "../../common/marshal-logger";
const log = createLogger("AutomationManager");
import type {
  AutomationCreateInput,
  AutomationApplicationJob,
  AutomationData,
  PermissionsConfig,
} from "../../common/marshal-ipc-contract";
import type { IAutomationManager } from "../backend/types";
import type { PermissionPolicy } from "../permission-policy";
import type { RelayNotificationPublisher } from "../relay/experience-coordinator";
import { formatRelaySessionMessage } from "../relay/message-format";
import { getRelayRouteAlias } from "../relay/route-aliases";
import type { SessionManager } from "../sessions";
import { PermissionsConfigSchema } from "../settings-store";
import { AutomationConditionMonitor } from "./condition-monitor";
import type {
  Automation,
  AutomationRun,
  StrictAutomationSchedule,
  AutomationStep,
} from "./domain/contracts";
import { normalizeModelOverride } from "./domain/model-override";
import {
  generateId,
  isRecord,
  migrateScheduleInPlace,
  normalizeSchedule,
  parseSchedule,
  SCHEDULE_FORMAT_HINT,
} from "./schedule";
import { AutomationImportSchema } from "./schemas";
import { AutomationStore } from "./store";
import { shouldTriggerSchedule } from "./triggering";

/** When a pinned session exceeds this many messages, a fresh session is created
 *  to avoid hitting the context window limit. */
const MAX_PINNED_SESSION_MESSAGES = 200;

export interface AutomationActiveExecution {
  readonly automationId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly sessionId: string;
  readonly clientMessageId: string;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function automationHasExplicitTarget(automation: Pick<Automation, "targetSessionId">): boolean {
  return !!normalizeOptionalString(automation.targetSessionId);
}

function validateAutomationSessionScope(
  data: Pick<Automation, "targetSessionId" | "workspaceName" | "repoPath">,
): void {
  if (
    normalizeOptionalString(data.targetSessionId) &&
    (normalizeOptionalString(data.workspaceName) || normalizeOptionalString(data.repoPath))
  ) {
    throw new Error("targetSessionId cannot be combined with workspaceName or repoPath");
  }
}

export class AutomationManager extends EventEmitter implements IAutomationManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sessionManager: SessionManager | null = null;
  private relayPublisher: RelayNotificationPublisher | null = null;
  /** Set via setPermissionPolicy() in main.ts before any execution. */
  private permissionPolicy!: PermissionPolicy;
  private tenantPolicyProvider: { get: () => { disableAutomations?: boolean } } | null = null;
  private runningAutomationId: string | null = null;
  private pendingQueue: string[] = [];
  private currentRun: AutomationRun | null = null;
  private activeExecution: AutomationActiveExecution | null = null;
  private applicationJobPolicy: ((automation: Automation) => boolean | Promise<boolean>) | null =
    null;
  private onRunUpdate: ((run: AutomationRun) => void) | null = null;
  private lastCheckTime: Date | null = null;
  private onSessionCreated: ((sessionId: string) => void) | null = null;

  private store: AutomationStore;
  private conditionMonitor: AutomationConditionMonitor;

  private persistAutomations(automations: Automation[]): void {
    this.store.saveAutomations(automations);
    this.emit("changed");
  }

  constructor() {
    super();
    this.store = new AutomationStore();
    this.conditionMonitor = new AutomationConditionMonitor();
    // Wire condition monitor deps early so getConditionStatus works before setSessionManager
    this.conditionMonitor.setDeps({
      loadAutomations: () => this.store.loadAutomations(),
      executeAutomation: (automation, isManual) => this.executeAutomation(automation, isManual),
      makePermissionPersistCallback: (id) => this.makePermissionPersistCallback(id),
    });
  }

  setSessionManager(sm: SessionManager) {
    this.sessionManager = sm;
    this.conditionMonitor.setSessionManager(sm);
  }

  setApplicationJobPolicy(policy: (automation: Automation) => boolean | Promise<boolean>): void {
    this.applicationJobPolicy = policy;
  }

  /** Host-only scheduler attestation; never inferred from an agent-supplied session ID. */
  getActiveExecution(sessionId: string): AutomationActiveExecution | undefined {
    const execution = this.activeExecution;
    return execution?.sessionId === sessionId &&
      this.sessionManager?.isActiveTurnMessage(sessionId, execution.clientMessageId)
      ? execution
      : undefined;
  }

  /** Host-owned binding. General create/update/import cannot mint arm authority. */
  setApplicationJobMarker(
    id: string,
    marker: AutomationApplicationJob,
    enabled: boolean,
  ): Automation {
    const automations = this.store.loadAutomations();
    const automation = automations.find((entry) => entry.id === id);
    if (!automation) throw new Error("Automation not found");
    automation.applicationJob = marker;
    automation.enabled = enabled;
    automation.updatedAt = new Date().toISOString();
    this.persistAutomations(automations);
    if (enabled) this.start();
    return automation;
  }

  /** Create a persist callback for "Always allow" routing to entity permissions. */
  private makePermissionPersistCallback(automationId: string) {
    return (updated: PermissionsConfig) => {
      const automations = this.store.loadAutomations();
      const idx = automations.findIndex((w) => w.id === automationId);
      if (idx !== -1) {
        automations[idx].permissions = updated;
        this.persistAutomations(automations);
      }
    };
  }

  setRelayPublisher(publisher: RelayNotificationPublisher) {
    this.relayPublisher = publisher;
  }

  setPermissionPolicy(policy: PermissionPolicy) {
    this.permissionPolicy = policy;
    this.conditionMonitor.setPermissionPolicy(policy);
  }

  setTenantPolicyProvider(provider: { get: () => { disableAutomations?: boolean } }) {
    this.tenantPolicyProvider = provider;
  }

  resetRuntimeSessions(): void {
    this.conditionMonitor.resetRuntimeSessions();
  }

  setRunUpdateCallback(cb: (run: AutomationRun) => void) {
    this.onRunUpdate = cb;
  }

  setSessionCreatedCallback(cb: (sessionId: string) => void) {
    this.onSessionCreated = cb;
  }

  /** Get condition check status for an automation */
  getConditionStatus(automationId: string): {
    lastCheck: string | null;
    nextCheck: string | null;
    lastError: string | null;
  } {
    return this.conditionMonitor.getStatus(automationId);
  }

  /** Start the minute-level timer for schedule checking */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkSchedules(), 60_000);
    log.info("[AutomationManager] Scheduler started");
  }

  /** Stop the timer */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Restore on app launch */
  restore() {
    // If automations are disabled by tenant policy, don't start anything
    if (this.tenantPolicyProvider?.get()?.disableAutomations) {
      log.info("[AutomationManager] Disabled by tenant policy — skipping restore");
      return;
    }
    this.repairSchedules();
    const automations = this.store.loadAutomations();
    // Arm authority is deliberately process-local. Persist only a visible suspended marker.
    for (const automation of automations) {
      if (automation.applicationJob?.state === "armed") {
        automation.applicationJob.state = "suspended-restart";
        automation.enabled = false;
      }
    }
    if (automations.some((entry) => entry.applicationJob?.state === "suspended-restart"))
      this.persistAutomations(automations);
    if (automations.some((w) => w.enabled)) {
      this.start();
    }
    for (const wf of automations) {
      if (wf.enabled && wf.triggerType === "condition" && wf.condition) {
        this.conditionMonitor.startFor(wf);
      }
    }
  }

  destroy() {
    this.stop();
    this.pendingQueue = [];
    this.activeExecution = null;
    this.conditionMonitor.destroy();
  }

  // --- CRUD ---

  list(): Automation[] {
    return this.store.loadAutomations();
  }

  /**
   * Insert an automation that already has a stable id assigned by an external
   * source of truth (currently: cloud-sync first-arrival from another device).
   * Bypasses `create()` because that mints a new id; the cloud id must be
   * preserved so subsequent snapshots emit a key that aligns with the cloud
   * record, avoiding a fake-rename ping-pong on every pull.
   *
   * The caller is responsible for spec-§9-case-9 defaults
   * (e.g. `enabled: false`, `pinnedSessionId: undefined`); this method only
   * persists what it's given. Schema validation runs on the next
   * `loadAutomations()` pass.
   */
  insertFromCloud(automation: Automation): void {
    const automations = this.store.loadAutomations();
    automations.push(automation);
    this.persistAutomations(automations);
  }

  create(data: AutomationCreateInput): Automation {
    const schedule = normalizeSchedule(data.schedule);
    // Validate permissions through Zod if provided (renderer sends untyped data)
    if (data.permissions !== undefined && data.permissions !== null) {
      const parsed = PermissionsConfigSchema.safeParse(data.permissions);
      if (!parsed.success) {
        log.warn(
          "[AutomationManager] Invalid permissions dropped on create:",
          parsed.error.message,
        );
        data = { ...data, permissions: undefined };
      }
    }
    const automations = this.store.loadAutomations();
    const effectiveTriggerType = data.triggerType ?? "schedule";
    const model = normalizeModelOverride(data.model);
    validateAutomationSessionScope(data);
    // Validate schedule is parseable for schedule-triggered automations
    let resolvedSchedule = schedule;
    if (effectiveTriggerType === "schedule") {
      const parsed = parseSchedule(schedule.naturalLanguage);
      if (!parsed) {
        throw new Error(
          `Could not parse schedule: "${schedule.naturalLanguage}". ` + SCHEDULE_FORMAT_HINT,
        );
      }
      resolvedSchedule = parsed;
    }
    const automation: Automation = {
      id: generateId(),
      name: data.name,
      description: data.description,
      steps: data.steps.map((s) => ({ ...s, id: s.id || generateId() })),
      schedule: resolvedSchedule,
      enabled: data.enabled ?? true,
      oneShot: data.triggerType === "condition" ? true : data.oneShot,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      triggerType: data.triggerType ?? "schedule",
      ...(data.condition !== undefined && { condition: data.condition }),
      conditionCheckInterval: data.conditionCheckInterval,
      ...(data.workingDir !== undefined && { workingDir: data.workingDir }),
      ...(data.skillNames && data.skillNames.length > 0 && { skillNames: data.skillNames }),
      ...(normalizeOptionalString(data.targetSessionId) !== undefined && {
        targetSessionId: normalizeOptionalString(data.targetSessionId),
      }),
      ...(normalizeOptionalString(data.workspaceName) !== undefined && {
        workspaceName: normalizeOptionalString(data.workspaceName),
      }),
      ...(normalizeOptionalString(data.repoPath) !== undefined && {
        repoPath: normalizeOptionalString(data.repoPath),
      }),
      ...(model !== undefined && { model }),
      ...(data.permissions !== undefined && { permissions: data.permissions }),
      ...(data.browserHeadless !== undefined && {
        browserHeadless: data.browserHeadless,
      }),
      ...(data.teamsNotify !== undefined && {
        teamsNotify: data.teamsNotify,
      }),
    };
    automations.push(automation);
    this.persistAutomations(automations);
    if (automation.enabled) this.start();
    if (automation.triggerType === "condition" && automation.enabled && automation.condition) {
      this.conditionMonitor.startFor(automation);
    }
    return automation;
  }

  update(
    id: string,
    rawUpdates: Partial<Omit<Automation, "id" | "createdAt">> | Partial<AutomationData>,
  ): Automation | null {
    // Normalize: always ensure schedule is in strict union format if present
    const { schedule: rawSchedule, applicationJob: _applicationJob, ...rest } = rawUpdates;
    let updates: Partial<Omit<Automation, "id" | "createdAt">> = rawSchedule
      ? { ...rest, schedule: normalizeSchedule(rawSchedule) }
      : rest;
    if ("model" in rawUpdates) {
      updates = { ...updates, model: normalizeModelOverride(rawUpdates.model) };
    }
    // Validate permissions through Zod if provided (renderer sends untyped data)
    if (updates.permissions !== undefined && updates.permissions !== null) {
      const parsed = PermissionsConfigSchema.safeParse(updates.permissions);
      if (!parsed.success) {
        log.warn(
          "[AutomationManager] Invalid permissions dropped on update:",
          parsed.error.message,
        );
        updates = { ...updates, permissions: undefined };
      }
    }
    const automations = this.store.loadAutomations();
    const idx = automations.findIndex((w) => w.id === id);
    if (idx === -1) return null;
    const previous = automations[idx];
    updates = {
      ...updates,
      ...("targetSessionId" in rawUpdates
        ? { targetSessionId: normalizeOptionalString(rawUpdates.targetSessionId) }
        : {}),
      ...("workspaceName" in rawUpdates
        ? { workspaceName: normalizeOptionalString(rawUpdates.workspaceName) }
        : {}),
      ...("repoPath" in rawUpdates
        ? { repoPath: normalizeOptionalString(rawUpdates.repoPath) }
        : {}),
    };
    if (updates.schedule) {
      const scheduleNL = updates.schedule.naturalLanguage;
      const parsed = parseSchedule(scheduleNL);
      if (parsed) {
        updates = { ...updates, schedule: parsed };
      }
      // Validate the new schedule for schedule-triggered automations
      const effectiveTriggerType = updates.triggerType ?? previous.triggerType ?? "schedule";
      if (effectiveTriggerType === "schedule" && !parsed) {
        throw new Error(`Could not parse schedule: "${scheduleNL}". ` + SCHEDULE_FORMAT_HINT);
      }
    } else if (updates.triggerType === "schedule" && previous.triggerType !== "schedule") {
      // Switching to schedule trigger — validate the existing schedule is parseable
      const effectiveSchedule = previous.schedule;
      if (!effectiveSchedule.naturalLanguage || !parseSchedule(effectiveSchedule.naturalLanguage)) {
        throw new Error(
          `A valid schedule is required when switching to schedule trigger. ` +
            SCHEDULE_FORMAT_HINT,
        );
      }
    }
    // Enforce oneShot for condition automations (matches create() semantics)
    const effectiveTriggerType = updates.triggerType ?? previous.triggerType ?? "schedule";
    if (effectiveTriggerType === "condition" && !updates.oneShot) {
      updates = { ...updates, oneShot: true };
    }
    validateAutomationSessionScope({ ...previous, ...updates });
    // Any native edit requires fresh arm authority, even disable/re-enable within one clock tick.
    if (previous.applicationJob?.state === "armed") {
      updates = {
        ...updates,
        enabled: false,
        applicationJob: { ...previous.applicationJob, state: "disarmed" },
      };
    }
    automations[idx] = { ...previous, ...updates, updatedAt: new Date().toISOString() };
    this.persistAutomations(automations);
    if (automations.some((w) => w.enabled)) this.start();

    const updated = automations[idx];

    // Sync the pinned session name when the automation is renamed
    if (
      updates.name &&
      updates.name !== previous.name &&
      updated.pinnedSessionId &&
      !automationHasExplicitTarget(updated) &&
      this.sessionManager
    ) {
      this.sessionManager
        .renameSession(updated.pinnedSessionId, updates.name)
        .catch((err) =>
          log.error(
            `[AutomationManager] Failed to rename pinned session: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }

    // Reconcile condition timer when trigger type changes
    if (updated.triggerType === "condition") {
      if (updated.enabled && updated.condition) {
        this.conditionMonitor.startFor(updated);
      } else {
        this.conditionMonitor.stopFor(id);
      }
    } else if (previous.triggerType === "condition") {
      // Switching away from condition — stop stale timer
      this.conditionMonitor.stopFor(id);
    }

    return updated;
  }

  delete(id: string): boolean {
    this.conditionMonitor.stopFor(id);
    const automations = this.store.loadAutomations();
    const automation = automations.find((w) => w.id === id);
    const filtered = automations.filter((w) => w.id !== id);
    if (filtered.length === automations.length) return false;
    this.persistAutomations(filtered);
    // Clean up the pinned session so it doesn't linger as an orphan
    if (automation?.pinnedSessionId && this.sessionManager) {
      this.sessionManager
        .deleteSession(automation.pinnedSessionId, { cause: "automation" })
        .catch((err) =>
          log.error(
            `[AutomationManager] Failed to delete pinned session: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
    // Backfill automationName onto any history runs that don't have it yet,
    // so the name is preserved after the automation is gone.
    if (automation) {
      try {
        const history = this.store.loadHistory(id);
        const updated = history.map((run) =>
          run.automationName ? run : { ...run, automationName: automation.name },
        );
        this.store.saveHistory(id, updated);
      } catch {
        /* ignore */
      }
    }
    return true;
  }

  toggle(id: string, enabled: boolean): boolean {
    // update() now handles condition registration via the sync block
    const automation = this.update(id, { enabled });
    if (!automation) return false;
    if (enabled) this.start();
    return true;
  }

  /** Re-parse schedules for all automations with empty days (repairs broken data) */
  repairSchedules(): number {
    const automations = this.store.loadAutomations();
    let repaired = 0;
    for (const wf of automations) {
      if (wf.schedule.days.length === 0 && wf.schedule.naturalLanguage) {
        const parsed = parseSchedule(wf.schedule.naturalLanguage);
        if (parsed) {
          wf.schedule = parsed;
          repaired++;
        }
      }
    }
    if (repaired > 0) {
      this.persistAutomations(automations);
      log.info(`[AutomationManager] Repaired ${repaired} automation schedule(s)`);
    }
    return repaired;
  }

  // --- History ---

  getHistory(automationId: string): AutomationRun[] {
    return this.store.loadHistory(automationId);
  }

  /** Returns all run history across all automations, including deleted ones. */
  getAllHistory(): AutomationRun[] {
    return this.store.getAllHistory();
  }

  getCurrentRun(): AutomationRun | null {
    return this.currentRun;
  }

  // --- Export / Import ---

  exportAutomation(id: string): string | null {
    const automations = this.store.loadAutomations();
    const automation = automations.find((w) => w.id === id);
    if (!automation) return null;
    // Export without internal state
    const { pinnedSessionId: _, ...rest } = automation;
    const exported = { ...rest, enabled: false };
    return JSON.stringify(exported, null, 2);
  }

  /** Import one or more automations from a JSON string (single object or array).
   * If `opts.overwrite` is true, automations whose name matches an existing one are updated
   * in place (preserving enabled state and id). Otherwise duplicates are silently skipped.
   */
  importAutomations(
    json: string,
    opts?: { overwrite?: boolean; workingDir?: string; skillNames?: string[] },
  ): Automation[] {
    try {
      const parsed = JSON.parse(json); // SF-4: validated per-entry below
      const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      const results: Automation[] = [];
      // Snapshot existing automations once so we can detect name conflicts.
      // Use this.list() instead of the module-level loadAutomations() to work
      // around a vitest module-scope resolution issue on macOS.
      const existingAutomations = this.list();
      for (const raw of items) {
        // Migrate schedule to discriminated union format before validation
        if (isRecord(raw) && isRecord(raw.schedule)) {
          migrateScheduleInPlace(raw.schedule);
        }
        const schemaResult = AutomationImportSchema.safeParse(raw);
        if (!schemaResult.success) continue;
        const d = schemaResult.data;
        try {
          const existing = existingAutomations.find((w) => w.name === d.name);
          if (existing) {
            if (opts?.overwrite) {
              // Update in place — preserves id, createdAt, and enabled state
              const updated = this.update(existing.id, {
                description: d.description,
                steps: d.steps.map((s) => ({
                  id: generateId(),
                  label: s.label || "",
                  prompt: s.prompt || "",
                })),
                schedule: d.schedule,
                triggerType: d.triggerType ?? "schedule",
                ...(d.condition !== undefined && { condition: d.condition }),
                conditionCheckInterval: d.conditionCheckInterval,
                ...(opts.workingDir !== undefined && { workingDir: opts.workingDir }),
                ...(opts.skillNames &&
                  opts.skillNames.length > 0 && { skillNames: opts.skillNames }),
                ...(d.model !== undefined && { model: d.model }),
                ...(d.permissions !== undefined && { permissions: d.permissions }),
              });
              if (updated) results.push(updated);
            }
            // else: skip duplicate — do not add to results
          } else {
            const wf = this.create({
              name: d.name,
              description: d.description,
              steps: d.steps.map((s) => ({
                id: generateId(),
                label: s.label || "",
                prompt: s.prompt || "",
              })),
              schedule: d.schedule,
              triggerType: d.triggerType,
              condition: d.condition,
              conditionCheckInterval: d.conditionCheckInterval,
              workingDir: opts?.workingDir,
              skillNames: opts?.skillNames,
              model: d.model,
              enabled: false, // imported automations start disabled
              permissions: d.permissions,
            });
            results.push(wf);
          }
        } catch {
          /* skip invalid entries */
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  // --- Execution ---

  /** Runs an automation now; `focus: false` keeps the window on the current session. */
  async runNow(automationId: string, options: { focus?: boolean } = {}): Promise<AutomationRun> {
    const automations = this.store.loadAutomations();
    const automation = automations.find((w) => w.id === automationId);
    if (!automation) throw new Error("Automation not found");
    return this.executeAutomation(automation, true, options.focus ?? true);
  }

  private checkSchedules() {
    const now = new Date();
    const lastCheck = this.lastCheckTime ?? null;
    this.lastCheckTime = now;

    const automations = this.store
      .loadAutomations()
      .filter((w) => w.enabled && w.triggerType !== "condition");
    for (const automation of automations) {
      if (
        this.shouldTrigger(automation.schedule, now, lastCheck) &&
        !this.pendingQueue.includes(automation.id) &&
        this.runningAutomationId !== automation.id
      ) {
        this.pendingQueue.push(automation.id);
      }
    }
    this.drainQueue();
  }

  private drainQueue() {
    if (this.runningAutomationId || this.pendingQueue.length === 0) return;
    const nextId = this.pendingQueue.shift()!;
    const automations = this.store.loadAutomations();
    const automation = automations.find((w) => w.id === nextId && w.enabled);
    if (!automation) {
      this.drainQueue();
      return;
    }
    log.info(`[AutomationManager] Running scheduled automation: ${automation.name}`);
    this.executeAutomation(automation, false).catch((err) =>
      log.error(
        `[AutomationManager] Automation failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  /** Check if a schedule should trigger: the scheduled time falls between lastCheck and now */
  shouldTrigger(schedule: StrictAutomationSchedule, now: Date, lastCheck: Date | null): boolean {
    return shouldTriggerSchedule(schedule, now, lastCheck);
  }

  /**
   * Get or create the pinned session for an automation.
   * If the automation already has a pinnedSessionId and the session still exists,
   * reuse it (ensuring the SDK session is active). Otherwise create a new session
   * named after the automation and persist the pin.
   *
   * If the pinned session exceeds MAX_PINNED_SESSION_MESSAGES, the pin is cleared
   * and a fresh session is created to avoid hitting context limits.
   */
  private async getOrCreatePinnedSession(
    automation: Automation,
    focus: boolean,
    playwrightHeadless: boolean,
  ): Promise<string> {
    if (!this.sessionManager) throw new Error("No session manager");

    // Try to reuse existing pinned session.
    if (automation.pinnedSessionId) {
      const existing =
        this.sessionManager.getSession(automation.pinnedSessionId) ??
        (await this.sessionManager.getSessionAsync(automation.pinnedSessionId));
      if (existing) {
        // If the stored headless flag differs from the effective flag,
        // rotate: the Playwright MCP launch args are baked in at session creation
        // time, so a session created with one flag cannot be reused for the other.
        // Coerce undefined → false (legacy sessions predate the flag).
        const storedHeadless = existing.playwrightHeadless ?? false;
        if (storedHeadless !== playwrightHeadless) {
          log.info(
            `[AutomationManager] Pinned session ${automation.pinnedSessionId} was created with playwrightHeadless=${storedHeadless}, but this run needs ${playwrightHeadless}. Rotating session for: ${automation.name}`,
          );
          // Fall through to create a new session
        } else if (existing.messages.length >= MAX_PINNED_SESSION_MESSAGES) {
          // Check if the session has grown too large (context limit risk)
          log.info(
            `[AutomationManager] Pinned session ${automation.pinnedSessionId} has ${existing.messages.length} messages (limit ${MAX_PINNED_SESSION_MESSAGES}), creating fresh session for: ${automation.name}`,
          );
          // Fall through to create a new session
        } else {
          // Session exists and is within limits — ensure it's active in the SDK
          // (may have been paused when the active-session limit was reached)

          // Sync model to the automation override or current default before resuming.
          // Handles both live sessions (backend setModel) and evicted sessions
          // (disk update read by switchSession on resume).
          const effectiveModel = automation.model ?? this.sessionManager.getDefaultModel();
          if (existing.model !== effectiveModel) {
            log.info(
              `Syncing automation '${automation.name}' model: ${existing.model ?? "unset"} → ${effectiveModel}`,
            );
            try {
              await this.sessionManager.updateSessionModelQuietly(
                automation.pinnedSessionId,
                effectiveModel,
              );
            } catch (err) {
              log.warn(
                `Model sync failed for '${automation.name}', continuing with existing model: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          const switchResult = await this.sessionManager.switchSession(automation.pinnedSessionId);
          // If the pinned index entry was removed between getSessionAsync and
          // switchSession (cross-window delete, index GC), fall through to
          // create instead of running against a stale id.
          if (switchResult.kind === "notFound") {
            log.info(
              `[AutomationManager] Pinned session ${automation.pinnedSessionId} disappeared mid-switch, creating new one for: ${automation.name}`,
            );
          } else {
            return automation.pinnedSessionId;
          }
        }
      } else {
        // Session was deleted — clear the stale pin and fall through to create
        log.info(
          `[AutomationManager] Pinned session ${automation.pinnedSessionId} was deleted, creating new one for: ${automation.name}`,
        );
      }
    }

    // Create a new session named after the automation
    const meta = await this.sessionManager.createSession(automation.model, undefined, {
      name: automation.name,
      source: "automation",
      automationId: automation.id,
      setActive: focus,
      playwrightHeadless,
      ...(automation.workspaceName !== undefined && { workspaceName: automation.workspaceName }),
      ...(automation.repoPath !== undefined && { repoPath: automation.repoPath }),
    });

    // Persist the pinned session ID on the automation
    const automations = this.store.loadAutomations();
    const idx = automations.findIndex((w) => w.id === automation.id);
    if (idx !== -1) {
      automations[idx].pinnedSessionId = meta.id;
      this.persistAutomations(automations);
    }

    return meta.id;
  }

  private async resolveTargetSession(automation: Automation): Promise<string> {
    if (!this.sessionManager) throw new Error("No session manager");
    const targetSessionId = normalizeOptionalString(automation.targetSessionId);
    if (!targetSessionId) throw new Error("No target session configured");

    const existing =
      this.sessionManager.getSession(targetSessionId) ??
      (await this.sessionManager.getSessionAsync(targetSessionId));
    if (!existing) {
      throw new Error(
        `Target session '${targetSessionId}' for automation '${automation.name}' not found`,
      );
    }

    const switchResult = await this.sessionManager.switchSession(targetSessionId);
    if (switchResult.kind === "notFound") {
      throw new Error(
        `Target session '${targetSessionId}' for automation '${automation.name}' not found`,
      );
    }
    return targetSessionId;
  }

  private async resolveRunSession(
    automation: Automation,
    focus: boolean,
    playwrightHeadless: boolean,
  ): Promise<string> {
    if (automationHasExplicitTarget(automation)) {
      return this.resolveTargetSession(automation);
    }
    return this.getOrCreatePinnedSession(automation, focus, playwrightHeadless);
  }

  private async executeAutomation(
    automation: Automation,
    isManual: boolean,
    focus: boolean = isManual,
  ): Promise<AutomationRun> {
    if (!this.sessionManager) throw new Error("No session manager");
    if (this.runningAutomationId) throw new Error("Another automation is already running");

    this.runningAutomationId = automation.id;

    // Instrumentation tag included in every enter/exit log line below. When a
    // user reports the singleton lock is wedged again, the last "enter:" with
    // no matching "exit:" pinpoints which await never settled. Once we have a
    // captured hang point we can fix it directly (or add a targeted recovery
    // mechanism with real evidence).
    const tag = `[AutomationManager] run=${automation.id} name=${JSON.stringify(automation.name)}`;
    log.info(`${tag} executeAutomation: enter`);

    // Honor browserHeadless on every trigger (manual + scheduled + condition). Users
    // who opt in want the browser hidden universally; the manual carve-out from the
    // earlier --start-minimized design didn't translate to headless mode.
    const playwrightHeadless = automation.browserHeadless ?? false;

    const run: AutomationRun = {
      id: generateId(),
      automationId: automation.id,
      startedAt: new Date().toISOString(),
      status: "running",
      stepResults: automation.steps.map((s) => ({ stepId: s.id, status: "pending" as const })),
    };
    this.currentRun = run;
    this.emitUpdate(run);

    // Track whether we registered per-entity permissions (for cleanup in finally).
    // sendNotification is auto-approved via DEFAULT_TOOL_APPROVALS — no per-run
    // overlay needed for the auto-mode dispatch path.
    const hasCustomPermissions = !!automation.permissions;
    let sessionId: string | undefined;
    // Non-manual runs can't show permission prompts — deny instead of hanging
    const useDenyPrompt = !isManual;

    try {
      if (
        automation.applicationJob &&
        (automation.applicationJob.state !== "armed" ||
          !(await this.applicationJobPolicy?.(automation)))
      ) {
        const latest = this.store.loadAutomations().find((entry) => entry.id === automation.id);
        if (
          latest?.applicationJob?.jobId === automation.applicationJob.jobId &&
          latest.applicationJob.state === "armed"
        )
          this.setApplicationJobMarker(
            automation.id,
            { ...latest.applicationJob, state: "disarmed" },
            false,
          );
        throw new Error("Application job is suspended; re-arm it from its application UI.");
      }
      // Resolve the session: explicit target, pinned session, or a new automation-owned session
      log.info(`${tag} getOrCreatePinnedSession: enter`);
      sessionId = await this.resolveRunSession(automation, focus, playwrightHeadless);
      log.info(`${tag} getOrCreatePinnedSession: exit sessionId=${sessionId}`);
      run.sessionId = sessionId;

      // Register per-automation permissions (if configured), otherwise
      // automations run under global permissions (no registration needed).
      if (hasCustomPermissions) {
        this.permissionPolicy.registerSessionPermissions(
          sessionId,
          automation.permissions!,
          this.makePermissionPersistCallback(automation.id),
        );
      }

      if (useDenyPrompt) {
        this.permissionPolicy.setDenyPrompt(sessionId);
        this.permissionPolicy.markUnattended(sessionId);
      }

      // Insert a run-start divider so multiple runs are visually separated
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const dateStr = now.toLocaleDateString([], { month: "short", day: "numeric" });
      this.sessionManager.appendMessage(sessionId, {
        id: `run-start-${run.id}`,
        role: "system",
        content: `▶ Run started — ${dateStr}, ${timeStr}`,
        timestamp: now.toISOString(),
      });

      // Notify renderer about the session (for manual runs, switch to it)
      if (focus && this.onSessionCreated) {
        this.onSessionCreated(sessionId);
      }

      let previousOutput = "";

      for (let i = 0; i < automation.steps.length; i++) {
        const step = automation.steps[i];
        run.stepResults[i].status = "running";
        this.emitUpdate(run);

        // Insert system message for step transition
        if (automation.steps.length > 1) {
          this.sessionManager.appendMessage(sessionId, {
            id: `step-${run.id}-${i}`,
            role: "system",
            content: `▶ Running step ${i + 1}/${automation.steps.length}: ${step.label}`,
            timestamp: new Date().toISOString(),
          });
        }

        const prompt = this.buildStepPrompt(
          step,
          previousOutput,
          i,
          automation.steps.length,
          automation.workingDir,
          automation.teamsNotify ?? "always",
        );

        // Save user message so it appears in the session
        this.sessionManager.appendMessage(sessionId, {
          id: `user-${run.id}-${i}`,
          role: "user",
          content: step.prompt,
          timestamp: new Date().toISOString(),
        });

        try {
          const execution: AutomationActiveExecution = {
            automationId: automation.id,
            runId: run.id,
            stepId: step.id,
            sessionId,
            clientMessageId: `automation:${run.id}:${i}`,
          };
          log.info(`${tag} sendAndCollect[step ${i + 1}/${automation.steps.length}]: enter`);
          // eslint-disable-next-line no-await-in-loop -- sequential processing
          const stepResult = await this.sessionManager.sendAndCollect(
            prompt,
            5 * 60 * 1000,
            undefined,
            sessionId,
            undefined,
            {
              clientMessageId: execution.clientMessageId,
              onBackendDispatchStarting: async () => {
                if (automation.applicationJob && !(await this.applicationJobPolicy?.(automation)))
                  throw new Error("Application job was revoked before dispatch.");
                this.activeExecution = execution;
              },
            },
          );
          log.info(
            `${tag} sendAndCollect[step ${i + 1}/${automation.steps.length}]: exit kind=${stepResult.kind}`,
          );
          // A non-ok result means the LLM went silent past the rolling
          // timeout or finished with no content. Treating the step as
          // "completed" would propagate empty/partial text through
          // `previousOutput`, `finalOutput`, run history, and (for relay-
          // forwarded automations) to the end user. Mark the step as failed.
          if (stepResult.kind !== "ok") {
            run.stepResults[i].status = "failed";
            run.stepResults[i].error =
              stepResult.kind === "timeout"
                ? "Step timed out — the model did not respond before the step timeout expired."
                : "Step produced no response — the model finished without emitting any content.";
            run.status = "failed";
            break;
          }
          run.stepResults[i].status = "completed";
          run.stepResults[i].output = stepResult.text;
          previousOutput = stepResult.text;
        } catch (err) {
          run.stepResults[i].status = "failed";
          run.stepResults[i].error = err instanceof Error ? err.message : String(err);
          run.status = "failed";
          break;
        } finally {
          this.activeExecution = null;
        }

        this.emitUpdate(run);
      }

      if (run.status !== "failed") {
        run.status = "completed";
        run.finalOutput = previousOutput;
      }

      run.completedAt = new Date().toISOString();
      this.emitUpdate(run);

      // Mark unread for scheduled (non-manual) runs
      if (!isManual) {
        this.sessionManager.markUnread(sessionId);
      }

      // Auto-disable one-shot automations after successful completion
      if (automation.oneShot && run.status === "completed") {
        const automations = this.store.loadAutomations();
        const idx = automations.findIndex((w) => w.id === automation.id);
        if (idx !== -1) {
          automations[idx].enabled = false;
          automations[idx].updatedAt = new Date().toISOString();
          this.persistAutomations(automations);
          log.info(
            `[AutomationManager] One-shot automation disabled after run: ${automation.name}`,
          );
        }
      }

      // Save to history (include name so it survives automation deletion)
      run.automationName = automation.name;
      const history = this.store.loadHistory(automation.id);
      history.push(run);
      this.store.saveHistory(automation.id, history);

      // Send to the relay if a destination is configured and the automation
      // completed (fire-and-forget). Skip when the relay is actively processing
      // an inbound message — the result already flows back through the
      // conversation via sendResponse().
      // Skip in e2e mode to avoid token acquisition delays on Windows CI.
      // Mode semantics live on the AutomationFields.teamsNotify JSDoc.
      const teamsNotify = automation.teamsNotify ?? "always";
      if (
        teamsNotify === "always" &&
        run.status === "completed" &&
        run.finalOutput &&
        !process.env.MARSHAL_E2E
      ) {
        if (this.relayPublisher?.hasDestinations("default")) {
          this.sendToRelay(automation.name, run.finalOutput, sessionId).catch((err) => {
            log.warn(
              `[AutomationManager] Failed to send relay notification for: ${automation.name}`,
              err,
            );
          });
        }
      }

      return run;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`${tag} executeAutomation failed: ${message}`);
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      run.finalOutput = message;
      run.automationName = automation.name;
      const firstPending = run.stepResults.find((step) => step.status === "pending");
      if (firstPending) {
        firstPending.status = "failed";
        firstPending.error = message;
      }
      this.emitUpdate(run);
      const history = this.store.loadHistory(automation.id);
      history.push(run);
      this.store.saveHistory(automation.id, history);
      return run;
    } finally {
      // Clean up per-automation permissions so they don't leak between runs
      if (hasCustomPermissions && sessionId) {
        this.permissionPolicy.unregisterSessionPermissions(sessionId);
      }
      if (useDenyPrompt && sessionId) {
        this.permissionPolicy.clearDenyPrompt(sessionId);
        this.permissionPolicy.clearUnattended(sessionId);
      }
      this.runningAutomationId = null;
      this.activeExecution = null;
      this.currentRun = null;
      log.info(`${tag} executeAutomation: exit status=${run.status}`);
      this.drainQueue();
    }
  }

  private buildStepPrompt(
    step: AutomationStep,
    previousOutput: string,
    stepIndex: number,
    totalSteps: number,
    workingDir?: string,
    teamsNotify: "always" | "auto" | "never" = "always",
  ): string {
    let prompt = `You are running step ${stepIndex + 1} of ${totalSteps} in a scheduled automation.\n\n`;
    if (workingDir) {
      prompt += `## Automation resources\nThis automation has a resource directory at: ${workingDir}\nUse the filesystem tool to read config files, templates, data, and other assets from this directory.\n\n`;
    }
    prompt += `## Step: ${step.label}\n${step.prompt}\n`;
    if (previousOutput) {
      prompt += `\n## Output from previous step\n${previousOutput}\n`;
    }
    prompt +=
      "\nRun this step now. Output ONLY the result — no preamble, thought process, or narration.";
    if (teamsNotify === "auto") {
      // Teach the per-run notify contract for `auto` mode. The framework
      // sends nothing on completion in this mode; the agent must opt in by
      // calling sendNotification when the run is worth surfacing. The
      // "always end with a summary line" clause is load-bearing: without
      // it the model will frequently end the turn with no assistant text
      // (especially after a tool call returns "nothing to report"), which
      // trips sendAndCollect's fail-closed empty-content guard and marks
      // the step as failed.
      prompt +=
        "\n\n## Relay notifications\n" +
        "If the user should be notified on their connected messaging relay about " +
        "the result of this run, call `sendNotification` with the exact message text. " +
        "If there is nothing actionable, do not call it — sending nothing " +
        "is the correct outcome. Either way, always end your turn with a " +
        'brief one-line summary of what happened (e.g. "No matching emails." ' +
        'or "Sent a notice about 3 new alerts."); the framework records ' +
        "that line in run history for in-app review and never forwards it " +
        "to the relay.";
    }
    return prompt;
  }

  private async sendToRelay(automationName: string, output: string, sourceSessionId?: string) {
    if (!this.relayPublisher || !this.sessionManager) {
      log.warn(`[AutomationManager] No relay publisher/session manager for: ${automationName}`);
      return;
    }
    const tag = `[AutomationManager] sendToRelay name=${JSON.stringify(automationName)}`;
    const relaySessionId = sourceSessionId ?? null;
    try {
      const prompt =
        `[A scheduled automation "${automationName}" just completed. ` +
        `Present these results to the user concisely using markdown. Do not use any tools.]\n\n${output}`;

      const response = relaySessionId
        ? await this.sessionManager.sendAndCollect(prompt, 60_000, undefined, relaySessionId)
        : { kind: "no-response" as const, text: "" };

      // When the LLM's reformat succeeds, forward it; otherwise send the raw
      // automation output (the step-level guard above ensures `output` is
      // already a real result, not a sentinel).
      const formatted = response.kind === "ok" && response.text ? response.text : output;
      const relaySession = relaySessionId
        ? (this.sessionManager.getSession(relaySessionId) ?? { id: relaySessionId })
        : null;
      log.info(`${tag} publish: enter`);
      await this.relayPublisher.publish(
        "default",
        formatRelaySessionMessage(
          formatted,
          relaySession,
          relaySession?.id ? { routeId: getRelayRouteAlias(relaySession) } : undefined,
        ),
        relaySessionId ?? undefined,
      );
      log.info(`${tag} publish: exit`);
      log.info(
        `[AutomationManager] Sent result to configured relay destinations: ${automationName}`,
      );
    } catch (err) {
      log.error(
        `[AutomationManager] Failed to publish relay result: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Fallback: send raw output directly if SDK call fails
      try {
        const relaySession = relaySessionId
          ? (this.sessionManager.getSession(relaySessionId) ?? { id: relaySessionId })
          : null;
        const fallback = formatRelaySessionMessage(
          `🔄 **Automation: ${automationName}**\n\n${output}`,
          relaySession,
          relaySession?.id ? { routeId: getRelayRouteAlias(relaySession) } : undefined,
        );
        await this.relayPublisher.publish("default", fallback, relaySessionId ?? undefined);
      } catch (fallbackErr) {
        log.warn(
          `[AutomationManager] Fallback relay publication also failed: ${String(fallbackErr)}`,
        );
      }
    }
  }

  private emitUpdate(run: AutomationRun) {
    if (this.onRunUpdate) this.onRunUpdate({ ...run });
  }
}
