import type {
  AutomationCreateInput,
  AutomationData,
  AutomationRunData,
  ConditionStatusRecord,
  HeartbeatSettings,
} from "../../../../common/marshal-ipc-contract";
import { createLogger } from "../../../../common/marshal-logger";
import { migrateScheduleInPlace } from "../../../automations/schedule";
import { AutomationImportSchema } from "../../../automations/schemas";
import type {
  HeartbeatControllableMap,
  HeartbeatOperationResult,
  HeartbeatSettingsEnvelope,
  HeartbeatStatusEnvelope,
  IAutomationBackend,
} from "../../types";
import { isRecord } from "../record-guard";
import {
  buildConditionWatcherPrompt,
  WATCHER_PLACEHOLDER_ID,
  WATCHER_TOOLS_ALLOW,
} from "./condition";
import type { IConditionSupervisor } from "./condition-supervisor";
import {
  cronJobCreateToParams,
  parseCronJobId,
  parseCronJobList,
  parseCronRunLogEntries,
} from "./cron-decoders";
import {
  extractHeartbeatSubtree,
  mapHeartbeatPatchToMarshalPatch,
  mapLastHeartbeatToStatus,
  mapMarshalHeartbeatToSettings,
  wrapHeartbeatPatchAtConfigPath,
} from "./heartbeat-map";
import { aggregateMultiStepRuns } from "./history-aggregator";
import {
  automationDataToCronJobCreate,
  automationPatchToCronJobPatch,
  cronJobToAutomationData,
  cronRunLogEntryToAutomationRunData,
  decodeMultiStepDescription,
  matchesParentTailPattern,
  parseTailCronName,
  type CronJob,
  type CronRunLogEntry,
} from "./map";

const log = createLogger("GatewayAutomationBackend");

/**
 * Maximum number of automations getAllAutomationRuns will fan out to on
 * gateway. Sized to bound the worst-case "all history" panel load when a
 * user has many gateway automations and no server-side bulk RPC exists yet.
 * Older automations' runs are excluded; once marshal exposes a bulk
 * `cron.runs-all` (or equivalent), drop the cap entirely.
 */
const GATEWAY_ALL_HISTORY_FANOUT_CAP = 50;

/**
 * Minimal client shape; production wiring uses GatewayWsClient, tests pass
 * a fake. Declared locally so this module has no compile-time dependency
 * on the concrete WebSocket client.
 */
export interface RpcClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/**
 * Per-field controllable map for gateway heartbeat. `enabled` flows through
 * `set-heartbeats` (cheap, no concurrency); the rest flow through
 * `config.patch` against `agents.defaults.heartbeat` (base-hash CAS — see
 * `updateHeartbeatConfig`). `permissions` and `workDays` have no marshal
 * equivalent and stay hidden permanently (spec §2 "Hidden permanently").
 */
const GATEWAY_CONTROLLABLE: HeartbeatControllableMap = {
  enabled: true,
  intervalMinutes: true,
  schedule: true,
  prompt: true,
  permissions: false,
  workDays: false,
  workStartHour: true,
  workEndHour: true,
};

export class GatewayAutomationBackend implements IAutomationBackend {
  private client: RpcClient | null = null;
  private readonly tz: string;
  private knownConditionAutomations = new Map<string, AutomationData>();
  private knownScheduleAutomations = new Map<string, AutomationData>();
  private automationsChangedListeners = new Set<(automation: AutomationData) => void>();
  private conditionSupervisor: IConditionSupervisor | null = null;

  constructor(opts: { tz: string }) {
    this.tz = opts.tz;
  }

  attachClient(client: RpcClient): void {
    this.client = client;
  }

  detachClient(): void {
    this.client = null;
    this.automationsChangedListeners.clear();
  }

  attachConditionSupervisor(supervisor: IConditionSupervisor): void {
    this.conditionSupervisor = supervisor;
  }

  private requireClient(): RpcClient {
    if (!this.client) {
      throw new Error("GatewayAutomationBackend: no client attached");
    }
    return this.client;
  }

  // ── Heartbeat sentinels (Phase 3a — see spec §4) ─────────────────────

  async getHeartbeatConfig(): Promise<HeartbeatSettingsEnvelope> {
    const resp = await this.requireClient().request("config.get", {});
    const subtree = extractHeartbeatSubtree(resp);
    const settings = mapMarshalHeartbeatToSettings(subtree);
    return {
      supported: true,
      ...settings,
      controllable: GATEWAY_CONTROLLABLE,
    };
  }

  async getHeartbeatStatus(): Promise<HeartbeatStatusEnvelope> {
    const event = await this.requireClient().request("last-heartbeat", {});
    // `running` is a recency heuristic — see `mapLastHeartbeatToStatus` for
    // the threshold and rationale. (No per-poll log here: the panel polls
    // every 2s and we'd flood the log. If "running flickered to false but
    // heartbeat was still going" reports surface, add gated logging on the
    // running→stopped transition.)
    return { supported: true, ...mapLastHeartbeatToStatus(event) };
  }

  async updateHeartbeatConfig(
    patch: Partial<HeartbeatSettings>,
  ): Promise<HeartbeatOperationResult> {
    const client = this.requireClient();

    // Order matters. marshal's `HeartbeatSchema`
    // (marshal/src/config/zod-schema.agent-runtime.ts) does NOT include an
    // `enabled` field — the runtime toggle is exposed only through the
    // dedicated `set-heartbeats` RPC, so we can't fold it into config.patch.
    // Run config.patch FIRST so a hash conflict doesn't strand a half-applied
    // `enabled` toggle on the server (the user would see "settings changed
    // externally" while their toggle silently committed). `set-heartbeats` is
    // a no-concurrency RPC and almost never fails, so the reverse
    // inconsistency (config.patch ok, set-heartbeats fails) is much less
    // likely.
    const marshalPatch = mapHeartbeatPatchToMarshalPatch(patch);
    if (Object.keys(marshalPatch).length > 0) {
      const configResp = await client.request("config.get", {});
      if (!isRecord(configResp) || typeof configResp.hash !== "string") {
        return {
          ok: false,
          reason: "unknown-error",
          message: "config.get did not return a usable hash",
        };
      }
      const baseHash = configResp.hash;

      try {
        // marshal's `config.patch` schema (ConfigApplyLikeParamsSchema in
        // marshal/src/gateway/protocol/schema/config.ts): `raw` is a JSON5
        // string of a merge-patch object, NOT a nested patch object. The
        // server parses, applies via merge-patch, and re-validates. `baseHash`
        // is optional CAS — included so a stale read is rejected.
        // The `wrapHeartbeatPatchAtConfigPath` helper owns the marshal
        // config-tree path so this file doesn't repeat it; see heartbeat-map.ts.
        await client.request("config.patch", {
          baseHash,
          raw: JSON.stringify(wrapHeartbeatPatchAtConfigPath(marshalPatch)),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = isRecord(err) && typeof err.code === "string" ? err.code : null;
        if (code === "CONFIG_HASH_MISMATCH" || message.toLowerCase().includes("hash")) {
          return {
            ok: false,
            reason: "config-conflict",
            message: "Settings changed externally; please refresh and try again.",
          };
        }
        return {
          ok: false,
          reason: "unknown-error",
          message,
        };
      }
    }

    // Toggle runs only after a successful config.patch (or no patch at all).
    // Wrap in try/catch so the failure shape matches config.patch's structured
    // envelope: a network/marshal error must surface as { ok: false, ... }
    // with a usable `message`, not bubble up to the IPC layer's String(error)
    // outer catch. (No `code` reliably distinguishes hash-conflict here — the
    // hash gate is on config.patch, not set-heartbeats.)
    if (patch.enabled !== undefined) {
      try {
        await client.request("set-heartbeats", { enabled: patch.enabled });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("updateHeartbeatConfig: set-heartbeats failed:", err);
        return {
          ok: false,
          reason: "unknown-error",
          message: `Failed to ${patch.enabled ? "enable" : "disable"} heartbeat: ${message}`,
        };
      }
    }

    return { ok: true };
  }

  async triggerHeartbeatNow(): Promise<HeartbeatOperationResult> {
    // marshal has the CLI command `system event --mode now` but no RPC
    // exposure. m hides the Run Now button via the heartbeatRunNow
    // capability; this method exists for interface symmetry and surfaces
    // a clear message if anyone bypasses the UI gate. Lobster issue tracks
    // adding the RPC.
    return {
      ok: false,
      reason: "not-supported",
      message:
        "Run-now isn't exposed by marshal yet. " +
        "Heartbeat continues to fire on its configured schedule.",
    };
  }

  // ── Automations (cron.*) ─────────────────────────────────────────────

  async listAutomations(): Promise<AutomationData[]> {
    const raw = await this.requireClient().request("cron.list", {});
    const jobs = parseCronJobList(raw);
    // Tails are scheduled with payload.kind === "agentTurn" and deleteAfterRun: false
    // (intentional — multi-device catch-up safety, see orchestrator §4.5). Without
    // the parseTailCronName guard here, every multi-step automation that ran once
    // leaks its tails (`auto-<parentId>-r<runInstance>-s<stepIndex>`) into the
    // user-visible list.
    const list = jobs
      .filter((job) => job.payload.kind === "agentTurn" && parseTailCronName(job.name) === null)
      .map(cronJobToAutomationData);
    const currentIds = new Set(list.map((automation) => automation.id));
    for (const id of this.knownConditionAutomations.keys()) {
      if (!currentIds.has(id)) {
        this.knownConditionAutomations.delete(id);
        this.conditionSupervisor?.unregisterWatcher(id);
      }
    }
    for (const id of this.knownScheduleAutomations.keys()) {
      if (!currentIds.has(id)) {
        this.knownScheduleAutomations.delete(id);
      }
    }
    // Re-register on every list so the in-memory map survives reconnects
    // without a separate hydration step.
    for (const automation of list) {
      if (automation.triggerType === "condition") {
        this.recordKnownConditionAutomation(automation);
      } else {
        this.knownConditionAutomations.delete(automation.id);
        this.conditionSupervisor?.unregisterWatcher(automation.id);
        this.knownScheduleAutomations.set(automation.id, automation);
      }
    }
    return list;
  }

  recordKnownConditionAutomation(automation: AutomationData): void {
    this.knownScheduleAutomations.delete(automation.id);
    this.knownConditionAutomations.set(automation.id, automation);
    this.conditionSupervisor?.registerWatcher({ cronId: automation.id });
  }

  onAutomationsChanged(listener: (automation: AutomationData) => void): () => void {
    this.automationsChangedListeners.add(listener);
    return () => {
      this.automationsChangedListeners.delete(listener);
    };
  }

  handleCronEvent(event: { action: string; jobId?: string }): void {
    if (event.action !== "removed" || !event.jobId) return;

    const known = this.knownConditionAutomations.get(event.jobId);
    if (!known) return;
    if (known.triggerType !== "condition") return;

    const now = new Date().toISOString();
    const updated: AutomationData = {
      ...known,
      enabled: false,
      firedAt: now,
      updatedAt: now,
    };
    this.knownConditionAutomations.set(event.jobId, updated);
    this.conditionSupervisor?.unregisterWatcher(event.jobId);
    for (const listener of this.automationsChangedListeners) {
      listener(updated);
    }
  }

  // After reconnect, mark any condition automations whose watcher disappeared
  // while offline. Spawned-action session observed → fired (firedAt set);
  // otherwise enabled: false only.
  async reconcileConditionAutomations(): Promise<void> {
    const cronListRaw = await this.requireClient().request("cron.list", {});
    const cronJobs = parseCronJobList(cronListRaw);
    const liveCronIds = new Set(cronJobs.map((j) => j.id));

    const missing = [...this.knownConditionAutomations.values()].filter(
      (a) => a.enabled && a.triggerType === "condition" && !liveCronIds.has(a.id),
    );
    if (missing.length === 0) return;

    const sessionListRaw = await this.requireClient().request("sessions.list", {});
    const sessions: unknown[] =
      isRecord(sessionListRaw) && Array.isArray(sessionListRaw.sessions)
        ? sessionListRaw.sessions
        : [];

    const firedCronIds = new Set<string>();
    for (const s of sessions) {
      if (!isRecord(s)) continue;
      const parentKey = typeof s.parentSessionKey === "string" ? s.parentSessionKey : "";
      const m = parentKey.match(/:cron:([^:]+):run:/);
      if (m?.[1]) firedCronIds.add(m[1]);
    }

    const now = new Date().toISOString();
    for (const automation of missing) {
      const current = this.knownConditionAutomations.get(automation.id);
      if (!current || !current.enabled || current.firedAt) continue;
      const fired = firedCronIds.has(automation.id);
      const updated: AutomationData = {
        ...current,
        enabled: false,
        ...(fired ? { firedAt: now } : {}),
        updatedAt: now,
      };
      this.knownConditionAutomations.set(automation.id, updated);
      this.conditionSupervisor?.unregisterWatcher(automation.id);
      for (const listener of this.automationsChangedListeners) {
        listener(updated);
      }
    }
  }

  async createAutomation(def: AutomationCreateInput): Promise<AutomationData> {
    // Two-phase: cron.add with a placeholder sessionTarget ("isolated"),
    // then cron.update to session:auto-<server-id>. The placeholder is
    // necessary because marshal assigns the id only on add, and the session
    // key needs to encode that id so the automations-list lookup in
    // useSessions finds the row. Schedule is future-dated so no run fires
    // between the two RPCs.
    //
    // ATOMICITY: if the update RPC fails (socket drop, server restart,
    // auth expiry mid-sequence), the job would be orphaned with a placeholder
    // sessionTarget and any future run would target an isolated session
    // instead of the automation's named session. Roll back via cron.remove
    // so the user isn't left with an invisibly-broken automation; the caller
    // retries at the UI level.
    const body = automationDataToCronJobCreate(def, { tz: this.tz });
    const raw = await this.requireClient().request("cron.add", cronJobCreateToParams(body));
    const id = parseCronJobId(raw);
    // Condition triggers also substitute the watcher placeholder id in
    // payload.message so the watcher's agent receives the real cron id
    // for cron.remove(self).
    const secondPhasePatch: Record<string, unknown> = {};
    if (!def.targetSessionId?.trim()) {
      secondPhasePatch.sessionTarget = `session:auto-${id}`;
    }
    if (def.triggerType === "condition") {
      const condition = def.condition?.trim() ?? "";
      secondPhasePatch.payload = {
        kind: "agentTurn",
        message: buildConditionWatcherPrompt({
          condition,
          steps: def.steps,
          watcherCronId: id,
        }),
        toolsAllow: [...WATCHER_TOOLS_ALLOW],
      };
    }
    if (Object.keys(secondPhasePatch).length > 0) {
      try {
        await this.requireClient().request("cron.update", {
          id,
          patch: secondPhasePatch,
        });
      } catch (updateErr) {
        try {
          await this.requireClient().request("cron.remove", { id });
        } catch (removeErr) {
          // Best-effort rollback — if the remove also fails, the job is
          // already orphaned. Use removeErr as the cause (the immediate
          // caught error) and include the original update error in the
          // message so operators can diagnose the full sequence.
          throw new Error(
            `cron.update failed and rollback cron.remove also failed. ` +
              `The cron job ${id} may be orphaned on the server. ` +
              `update: ${String(updateErr)} | remove: ${String(removeErr)}`,
            { cause: removeErr },
          );
        }
        throw updateErr;
      }
    }
    // Re-fetch the canonical row so the IPC handler can return the full
    // AutomationData without a follow-up listAutomations() round-trip. The
    // server has the patched sessionTarget now, so this is the authoritative
    // shape.
    const list = await this.listAutomations();
    const created = list.find((a) => a.id === id);
    if (!created) {
      throw new Error(
        `createAutomation: cron.add returned id ${id} but cron.list doesn't surface it — ` +
          "inconsistent server state or sessionTarget patch silently dropped",
      );
    }
    return created;
  }

  async updateAutomation(id: string, patch: Partial<AutomationData>): Promise<void> {
    const cronPatch = automationPatchToCronJobPatch(patch, { tz: this.tz });
    if ("targetSessionId" in patch && !patch.targetSessionId?.trim()) {
      cronPatch.sessionTarget = `session:auto-${id}`;
    }

    // Map layer emits the placeholder; substitute the real id before cron.update.
    // For partial patches, fill missing condition/steps from the in-memory copy
    // so the rebuilt prompt has both fields.
    if (
      cronPatch.payload?.kind === "agentTurn" &&
      cronPatch.payload.message?.includes(WATCHER_PLACEHOLDER_ID) &&
      patch.triggerType === "condition" &&
      (patch.condition !== undefined || patch.steps !== undefined)
    ) {
      const existing = this.knownConditionAutomations.get(id);
      const condition = patch.condition?.trim() ?? existing?.condition?.trim();
      if (!condition) {
        throw new Error(
          `updateAutomation(${id}): cannot rebuild watcher prompt — condition is missing from both patch and in-memory state. ` +
            `This likely means the automation list hasn't hydrated; refresh and retry.`,
        );
      }
      const steps = patch.steps ?? existing?.steps ?? [];
      cronPatch.payload = {
        ...cronPatch.payload,
        message: buildConditionWatcherPrompt({
          condition,
          steps,
          watcherCronId: id,
        }),
      };
    }

    if (cronPatch.payload?.kind === "agentTurn" && cronPatch.payload.message === undefined) {
      const conditionAutomation = this.knownConditionAutomations.get(id);
      if (conditionAutomation) {
        cronPatch.payload = {
          ...cronPatch.payload,
          message: buildConditionWatcherPrompt({
            condition: conditionAutomation.condition ?? "",
            steps: conditionAutomation.steps,
            watcherCronId: id,
          }),
          toolsAllow: [...WATCHER_TOOLS_ALLOW],
        };
      } else {
        const scheduleAutomation = this.knownScheduleAutomations.get(id);
        const prompt = scheduleAutomation?.steps[0]?.prompt;
        if (!prompt) {
          throw new Error(
            `updateAutomation(${id}): cannot patch model without steps - prompt is missing from in-memory state. ` +
              `Refresh automations and retry, or resubmit steps alongside model.`,
          );
        }
        cronPatch.payload = {
          ...cronPatch.payload,
          message: prompt,
        };
      }
    }

    await this.requireClient().request("cron.update", { id, patch: cronPatch });

    const prev = this.knownConditionAutomations.get(id);
    if (prev && (patch.triggerType === "condition" || prev.triggerType === "condition")) {
      const updated = { ...prev, ...patch, id };
      if (updated.triggerType === "condition") {
        this.recordKnownConditionAutomation(updated);
      } else {
        this.knownConditionAutomations.delete(id);
        this.conditionSupervisor?.unregisterWatcher(id);
        this.knownScheduleAutomations.set(id, updated);
      }
    } else {
      const prevSchedule = this.knownScheduleAutomations.get(id);
      if (prevSchedule) {
        const updated = { ...prevSchedule, ...patch, id };
        if (updated.triggerType === "condition") {
          this.recordKnownConditionAutomation(updated);
        } else {
          this.knownScheduleAutomations.set(id, updated);
        }
      }
    }
  }

  async toggleAutomation(id: string, enabled: boolean): Promise<void> {
    await this.requireClient().request("cron.update", { id, patch: { enabled } });
  }

  async deleteAutomation(id: string): Promise<void> {
    // Phase 2b multi-step: a parent owns N-1 tail crons named
    // auto-<parentId>-r<runInstanceId>-s<stepIndex>. Cancel those tails
    // first so they don't fire as orphans after the parent is gone. Single-
    // step automations have no tails, so this loop is a no-op for them.
    // Tail removes are best-effort: a transient failure on one tail must
    // not block the parent removal — the user is fixing a broken state by
    // deleting and partial cleanup is better than refusing the operation.
    const client = this.requireClient();
    const listRaw = await client.request("cron.list", {});
    const jobs = isRecord(listRaw) && Array.isArray(listRaw.jobs) ? listRaw.jobs : [];
    const tailPattern = matchesParentTailPattern(id);
    const tailIds: string[] = [];
    for (const j of jobs) {
      if (
        isRecord(j) &&
        typeof j.id === "string" &&
        typeof j.name === "string" &&
        tailPattern.test(j.name)
      ) {
        tailIds.push(j.id);
      }
    }
    for (const tailId of tailIds) {
      // eslint-disable-next-line no-await-in-loop -- sequential cron.remove; marshal isn't guaranteed parallel-safe
      await client.request("cron.remove", { id: tailId }).catch(() => {
        /* best-effort: see method comment */
      });
    }
    await client.request("cron.remove", { id });
    // `{ removed: false }` on the parent is ignored: delete is idempotent.
    this.knownConditionAutomations.delete(id);
    this.knownScheduleAutomations.delete(id);
    this.conditionSupervisor?.unregisterWatcher(id);
  }

  async triggerAutomationNow(id: string): Promise<AutomationRunData | null> {
    await this.requireClient().request("cron.run", { id, mode: "force" });
    // Marshal's cron.run acks fire-and-forget; the run record lands in the
    // cron run log asynchronously. No synchronous AutomationRunData to
    // return here — the activities panel's live-run indicator reads
    // getCurrentRun, which we already return null for on gateway. The
    // `cron` lifecycle event drives the sidebar refresh in provider.ts.
    return null;
  }

  async getCurrentRun(): Promise<AutomationRunData | null> {
    // Marshal cron fires asynchronously and doesn't surface a "currently
    // running" state to the operator protocol — cron events (start/end) are
    // visible, but there's no RPC to query a pending run by automation id.
    // Returning null is the right shape: the activities panel shows no
    // live-run indicator for gateway automations in 2a.
    return null;
  }

  async getAllAutomationRuns(): Promise<AutomationRunData[]> {
    // No bulk RPC on marshal's cron surface — fan out per automation.
    // Accepted cost for gateway mode: the activities panel's all-history
    // view fires N+1 network calls. Tracked as a server-side follow-up.
    //
    // Cap the fan-out so a user with many automations doesn't silently hang
    // the panel while a server-side bulk RPC is being designed. The activities
    // panel's "all history" view sorts by recency anyway; capping at the most
    // recently-updated 50 automations preserves the displayed top while
    // keeping the worst case bounded at 50 RPCs.
    //
    // Single cron.list at the top is shared with each per-automation lookup
    // via getAutomationRunsWithCache, so we don't pay an extra cron.list
    // inside every getAutomationRuns call (previously N+1 cron.list RPCs).
    const client = this.requireClient();
    const listRaw = await client.request("cron.list", {});
    const jobs = parseCronJobList(listRaw);
    // Same tail-cron filter as listAutomations — tails surface as their own
    // agentTurn cron jobs and would double-count against the parent run's
    // aggregated history if not excluded here.
    const automations = jobs
      .filter((job) => job.payload.kind === "agentTurn" && parseTailCronName(job.name) === null)
      .map(cronJobToAutomationData);
    if (automations.length > GATEWAY_ALL_HISTORY_FANOUT_CAP) {
      log.warn(
        `getAllAutomationRuns: capping fan-out at ${GATEWAY_ALL_HISTORY_FANOUT_CAP} of ${automations.length} ` +
          "automations until server-side bulk RPC lands. Older automations' runs are not shown in the activities panel.",
      );
    }
    const sorted = [...automations].sort((a, b) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
    const sliced = sorted.slice(0, GATEWAY_ALL_HISTORY_FANOUT_CAP);
    const runsPerAutomation = await Promise.all(
      sliced.map((a) => this.getAutomationRunsWithCache(a.id, jobs)),
    );
    return runsPerAutomation.flat();
  }

  async getAutomationRuns(id: string): Promise<AutomationRunData[]> {
    const client = this.requireClient();
    const listRaw = await client.request("cron.list", {});
    const jobs = parseCronJobList(listRaw);
    return this.getAutomationRunsWithCache(id, jobs);
  }

  /**
   * Variant of getAutomationRuns that takes an already-fetched cron.list
   * snapshot. Used by getAllAutomationRuns to amortize one cron.list across N
   * automations instead of paying N+1 RPCs. Public surface
   * (`IAutomationBackend.getAutomationRuns`) is unchanged.
   */
  private async getAutomationRunsWithCache(
    id: string,
    cachedJobs: CronJob[],
  ): Promise<AutomationRunData[]> {
    // Phase 2b multi-step: detect whether the parent's description carries
    // the multi-step sentinel. Single-step parents preserve 2a behavior
    // (one AutomationRunData per cron run-log entry). Multi-step parents
    // fan out to per-tail cron.runs and delegate aggregation to the pure
    // automation-history-aggregator.
    const client = this.requireClient();
    const parent = cachedJobs.find((j) => j.id === id);
    if (!parent) {
      // Parent vanished between caller snapshot and this call — treat as
      // empty rather than throwing; the activities panel can re-fetch the
      // automations list to discover the deletion.
      return [];
    }

    const parentRunsRaw = await client.request("cron.runs", { id, sortDir: "asc" });
    const parentEntries = parseCronRunLogEntries(parentRunsRaw);

    const sentinel = decodeMultiStepDescription(parent.description ?? "");
    const stepCount = sentinel.state?.stepCount ?? 1;
    if (stepCount <= 1) {
      // Single-step parity with the 2a behavior — same mapper, same shape.
      return parentEntries.map((entry, index) =>
        cronRunLogEntryToAutomationRunData(entry, id, index),
      );
    }

    // Multi-step: collect tail crons owned by this parent and per-tail runs.
    const tailPattern = matchesParentTailPattern(id);
    const tailMeta = cachedJobs
      .filter((j) => tailPattern.test(j.name))
      .map((j) => ({ id: j.id, name: j.name }));
    const tailRunsById = new Map<string, CronRunLogEntry[]>();
    for (const tail of tailMeta) {
      // eslint-disable-next-line no-await-in-loop -- sequential cron.runs; marshal isn't guaranteed parallel-safe
      const tailRunsRaw = await client.request("cron.runs", { id: tail.id, sortDir: "asc" });
      tailRunsById.set(tail.id, parseCronRunLogEntries(tailRunsRaw));
    }
    return aggregateMultiStepRuns({
      parentId: id,
      stepCount,
      parentRuns: parentEntries,
      tailMeta,
      tailRunsById,
    });
  }

  async exportAutomation(id: string): Promise<string | null> {
    const list = await this.listAutomations();
    const automation = list.find((a) => a.id === id);
    if (!automation) return null;
    return JSON.stringify({ ...automation, enabled: false }, null, 2);
  }

  async importAutomations(json: string, opts?: { overwrite?: boolean }): Promise<AutomationData[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown; // SF-4: cast to unknown; AutomationImportSchema validates each entry below.
    } catch {
      return [];
    }
    const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const existing = await this.listAutomations();
    const existingByName = new Map(existing.map((a) => [a.name, a]));
    const results: AutomationData[] = [];
    // Sequential awaits: cron.add/cron.update are server-side state mutations
    // and marshal doesn't guarantee parallel-safety on concurrent writes.
    for (const raw of items) {
      if (isRecord(raw) && isRecord(raw.schedule)) {
        migrateScheduleInPlace(raw.schedule);
      }
      const result = AutomationImportSchema.safeParse(raw);
      if (!result.success) continue;
      const def = result.data;
      const collision = existingByName.get(def.name);
      if (collision && !opts?.overwrite) continue;
      const steps = def.steps.map((s) => ({
        id: s.id ?? crypto.randomUUID(),
        label: s.label || "",
        prompt: s.prompt || "",
      }));
      const common = {
        description: def.description,
        steps,
        schedule: def.schedule,
        ...(def.triggerType !== undefined && { triggerType: def.triggerType }),
        ...(def.condition !== undefined && { condition: def.condition }),
        ...(def.conditionCheckInterval !== undefined && {
          conditionCheckInterval: def.conditionCheckInterval,
        }),
        ...(def.model !== undefined && { model: def.model }),
        ...(def.permissions !== undefined && { permissions: def.permissions }),
        ...(def.browserHeadless !== undefined && {
          browserHeadless: def.browserHeadless,
        }),
      };
      try {
        if (collision) {
          // eslint-disable-next-line no-await-in-loop -- sequential cron.update; marshal isn't guaranteed parallel-safe
          await this.updateAutomation(collision.id, common);
          // eslint-disable-next-line no-await-in-loop -- refetch the canonical row after update
          const refreshed = await this.listAutomations();
          const updated = refreshed.find((a) => a.id === collision.id);
          if (updated) results.push(updated);
        } else {
          // eslint-disable-next-line no-await-in-loop -- sequential cron.add; marshal isn't guaranteed parallel-safe
          const created = await this.createAutomation({ name: def.name, ...common });
          results.push(created);
        }
      } catch (err) {
        log.warn(`importAutomations: failed to import "${def.name}":`, err);
      }
    }
    return results;
  }

  async getConditionStatus(_automationId: string): Promise<ConditionStatusRecord> {
    // Marshal cron schedules fire on time, not on conditions — no data here.
    return { lastCheck: null, nextCheck: null, lastError: null };
  }
}
