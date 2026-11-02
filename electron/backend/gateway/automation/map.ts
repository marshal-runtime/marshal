import { createHash } from "node:crypto";

import type {
  AutomationCreateInput,
  AutomationData,
  AutomationRunData,
  AutomationSchedule,
} from "../../../../common/marshal-ipc-contract";
import { createLogger } from "../../../../common/marshal-logger";
import { normalizeModelOverride } from "../../../automations/domain/model-override";
import {
  SCHEDULE_FORMAT_HINT,
  formatScheduleNL,
  parseSchedule,
} from "../../../automations/schedule";
import {
  WATCHER_TOOLS_ALLOW,
  WATCHER_PLACEHOLDER_ID,
  buildConditionWatcherPrompt,
  conditionIntervalToCronSchedule,
} from "./condition";

const log = createLogger("GatewayAutomationMap");

/**
 * Prefix for Marshal-defined keys in CronJob.state. Marshal treats state as an
 * opaque bag; the prefix scopes our keys to avoid collisions with any
 * server-side or other-client keys that may be added later. Add new entries
 * as `m.<feature>` (camelCase suffix).
 *
 * Marshal identity: the `m.` VALUES below are deliberately NOT rebranded to
 * `marshal.`. CronJob.state is persisted by the Gateway service (bic/lobster),
 * not by this repo, so these strings are already present in every existing
 * cron job stored server-side. Renaming them would silently orphan that state:
 * reads would miss the old keys and every automation would revert to defaults,
 * with no type error and no failing test. Only the TypeScript constant NAMES
 * are branded; the wire values are frozen.
 */
export const MARSHAL_STATE_KEY_BROWSER_HEADLESS = "m.browserHeadless";
export const MARSHAL_STATE_KEY_TEAMS_NOTIFY = "m.teamsNotify";

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function validateGatewayScope(
  data: Pick<AutomationCreateInput, "workspaceName" | "repoPath">,
): void {
  if (normalizeOptionalString(data.workspaceName) || normalizeOptionalString(data.repoPath)) {
    throw new Error(
      "gateway-automation-map: workspaceName and repoPath are only supported by the local automation backend",
    );
  }
}

function sessionTargetForTargetSession(
  targetSessionId: string | undefined,
): CronSessionTarget | null {
  const normalized = normalizeOptionalString(targetSessionId);
  return normalized ? `session:${normalized}` : null;
}

/**
 * Read the teamsNotify enum from a CronJob.state bag, narrowing through the
 * unknown payload marshal treats as opaque. Default ("always") and any
 * unrecognized value collapse to undefined locally — same observable behavior
 * as a missing field on the inverse (manager.ts treats unset as "always").
 */
function readTeamsNotifyFromState(
  state: Record<string, unknown> | undefined,
): "auto" | "never" | undefined {
  const raw = state?.[MARSHAL_STATE_KEY_TEAMS_NOTIFY];
  if (raw === "auto" || raw === "never") return raw;
  return undefined;
}

// ── Local structural types matching marshal/src/cron/{types,run-log}.ts ──
// Kept local so the m build has no dependency on the marshal source tree.

export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number };

export type CronSessionTarget = "main" | "isolated" | "current" | `session:${string}`;

export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | {
      kind: "agentTurn";
      message: string;
      model?: string;
      fallbacks?: string[];
      thinking?: string;
      timeoutSeconds?: number;
      toolsAllow?: string[];
    };

export interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode: "next-heartbeat" | "now";
  payload: CronPayload;
  delivery?: { mode: "none" | "announce" | "webhook"; [k: string]: unknown };
  state: Record<string, unknown>;
}

export type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state"> & {
  state?: Partial<CronJob["state"]>;
};

export interface CronJobPatch {
  name?: string;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  schedule?: CronSchedule;
  sessionTarget?: CronSessionTarget;
  wakeMode?: "next-heartbeat" | "now";
  payload?:
    | { kind: "agentTurn"; message?: string; model?: string; toolsAllow?: string[] }
    | { kind: "systemEvent"; text?: string };
  delivery?: Partial<NonNullable<CronJob["delivery"]>>;
  state?: Partial<CronJob["state"]>;
}

export interface CronRunLogEntry {
  ts: number;
  runAtMs?: number;
  status: "ok" | "error" | "skipped";
  sessionId?: string;
  sessionKey?: string;
  summary?: string;
  error?: string;
  durationMs?: number;
  model?: string;
}

// ── Forward map: AutomationData → CronJobCreate ────────────────────────

const DOW_ALL = [0, 1, 2, 3, 4, 5, 6];

export interface MapOptions {
  tz: string;
}

export function automationDataToCronJobCreate(
  data: AutomationCreateInput,
  opts: MapOptions,
): CronJobCreate {
  validateGatewayScope(data);
  if (data.triggerType === "condition") {
    return automationConditionDataToCronJobCreate(data);
  }
  if (data.steps.length < 1) {
    throw new Error("gateway-automation-map: automation must have at least one step");
  }
  if (!data.name.trim()) {
    throw new Error("gateway-automation-map: automation name must be non-empty");
  }

  // Phase 2b multi-step: step 1's prompt is the parent cron's agentTurn
  // payload (unchanged from 2a). Steps 2..N are encoded into the parent's
  // description via the multi-step sentinel. Single-step automations leave
  // the description untouched for parity with 2a. Spec §4.2.
  //
  // Strip any pre-existing sentinel from the incoming description before
  // re-encoding so we don't double-wrap. Mirrors the patch-path behavior so
  // a future "duplicate automation" or "import → save" flow that round-trips
  // a server-side description (which already carries a sentinel) produces a
  // single-encoded result. Preserves the `undefined → undefined` shape for
  // single-step automations with no description (avoid forcing "" on the
  // server when the renderer didn't supply a description at all).
  const isMultiStep = data.steps.length > 1;
  const model = normalizeModelOverride(data.model);
  const userDescription =
    data.description === undefined
      ? undefined
      : decodeMultiStepDescription(data.description).userDescription;
  const description = isMultiStep
    ? encodeMultiStepDescription(userDescription ?? "", {
        v: 1,
        stepCount: data.steps.length,
        steps: data.steps.slice(1).map((s) => ({
          id: s.id,
          label: s.label,
          prompt: s.prompt,
        })),
        stepsHash: computeStepsHash(data.steps),
      })
    : userDescription;

  return {
    name: data.name,
    description,
    // Creation-time input has enabled as optional (defaults true). Local
    // AutomationManager defaults to `enabled: true`; we mirror that for
    // gateway so toggle state is consistent when a renderer omits the flag.
    enabled: data.enabled ?? true,
    deleteAfterRun: data.oneShot ?? false,
    schedule: scheduleToCronExpr(data.schedule, opts.tz),
    // Placeholder — the server-assigned cron job id isn't known at cron.add
    // time. GatewayAutomationBackend.createAutomation follows up with a
    // cron.update that sets sessionTarget to `session:auto-<server-id>` so the
    // session key encodes the same id that appears in the automations list
    // (needed for sidebar name resolution via useSessions + useAutomations).
    // Future runs always use the patched target; no run fires between the
    // two RPCs because schedules are future-dated.
    sessionTarget: sessionTargetForTargetSession(data.targetSessionId) ?? "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: data.steps[0].prompt,
      ...(model !== undefined && { model }),
    },
    delivery: { mode: "none" },
    // Round-trip user-controlled toggles via cron state so they survive gateway
    // sync (the same automation may later run locally where these are honored).
    // Defaults are omitted so unset round-trips as unset on the inverse.
    ...(data.browserHeadless || (data.teamsNotify && data.teamsNotify !== "always")
      ? {
          state: {
            ...(data.browserHeadless ? { [MARSHAL_STATE_KEY_BROWSER_HEADLESS]: true } : {}),
            ...(data.teamsNotify && data.teamsNotify !== "always"
              ? { [MARSHAL_STATE_KEY_TEAMS_NOTIFY]: data.teamsNotify }
              : {}),
          },
        }
      : {}),
  };
}

function automationConditionDataToCronJobCreate(data: AutomationCreateInput): CronJobCreate {
  validateGatewayScope(data);
  const condition = data.condition?.trim();
  if (!condition) {
    throw new Error(
      "gateway-automation-map: condition is required and must be non-empty for triggerType='condition'",
    );
  }
  if (data.steps.length < 1) {
    throw new Error("gateway-automation-map: automation must have at least one step");
  }
  if (!data.name.trim()) {
    throw new Error("gateway-automation-map: automation name must be non-empty");
  }

  const message = buildConditionWatcherPrompt({
    condition,
    steps: data.steps,
    watcherCronId: WATCHER_PLACEHOLDER_ID,
  });
  const model = normalizeModelOverride(data.model);

  return {
    name: data.name,
    description: data.description,
    enabled: data.enabled ?? true,
    // deleteAfterRun: false — watcher self-removes via cron.remove(self) when
    // satisfied; deleteAfterRun would tear it down on every poll.
    deleteAfterRun: false,
    schedule: conditionIntervalToCronSchedule(data.conditionCheckInterval),
    sessionTarget: sessionTargetForTargetSession(data.targetSessionId) ?? "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message,
      ...(model !== undefined && { model }),
      // toolsAllow inside payload per cronAgentTurnPayloadSchema.
      toolsAllow: [...WATCHER_TOOLS_ALLOW],
    },
    delivery: { mode: "none" },
    // Round-trip user-controlled toggles via cron state so they survive gateway
    // sync (the same automation may later run locally where these are honored).
    // Defaults are omitted so unset round-trips as unset on the inverse.
    ...(data.browserHeadless || (data.teamsNotify && data.teamsNotify !== "always")
      ? {
          state: {
            ...(data.browserHeadless ? { [MARSHAL_STATE_KEY_BROWSER_HEADLESS]: true } : {}),
            ...(data.teamsNotify && data.teamsNotify !== "always"
              ? { [MARSHAL_STATE_KEY_TEAMS_NOTIFY]: data.teamsNotify }
              : {}),
          },
        }
      : {}),
  };
}

function automationConditionPatchToCronJobPatch(patch: Partial<AutomationData>): CronJobPatch {
  validateGatewayScope(patch);
  for (const forbidden of ["pinnedSessionId", "workingDir", "skillNames", "permissions"] as const) {
    if (patch[forbidden] !== undefined) {
      throw new Error(
        `gateway-automation-map: ${forbidden} is not supported on gateway ` +
          "(capability flag should have prevented this path)",
      );
    }
  }

  const out: CronJobPatch = {};
  const model = normalizeModelOverride(patch.model);
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.description !== undefined) out.description = patch.description;
  if (patch.enabled !== undefined) out.enabled = patch.enabled;
  if ("targetSessionId" in patch) {
    out.sessionTarget = sessionTargetForTargetSession(patch.targetSessionId) ?? "isolated";
  }
  if (patch.conditionCheckInterval !== undefined) {
    out.schedule = conditionIntervalToCronSchedule(patch.conditionCheckInterval);
  }

  // Rebuild the prompt only when its inputs change; interval doesn't appear in the prompt.
  if (patch.condition !== undefined || patch.steps !== undefined) {
    const condition = patch.condition?.trim();
    if (patch.condition !== undefined && !condition) {
      throw new Error(
        "gateway-automation-map: condition must be non-empty when patching triggerType='condition'",
      );
    }
    out.payload = {
      kind: "agentTurn",
      message: buildConditionWatcherPrompt({
        condition: condition ?? "",
        steps: patch.steps ?? [],
        // Caller (updateAutomation) substitutes the real cron id before cron.update.
        watcherCronId: WATCHER_PLACEHOLDER_ID,
      }),
      ...(model !== undefined && { model }),
      toolsAllow: [...WATCHER_TOOLS_ALLOW],
    };
  } else if ("model" in patch) {
    out.payload = { kind: "agentTurn", model, toolsAllow: [...WATCHER_TOOLS_ALLOW] };
  }

  // Mirror the schedule patch's state-bag forwarding so condition-triggered
  // automations also round-trip browserHeadless and teamsNotify changes.
  if (patch.browserHeadless !== undefined || patch.teamsNotify !== undefined) {
    const state: Record<string, unknown> = {};
    if (patch.browserHeadless !== undefined) {
      state[MARSHAL_STATE_KEY_BROWSER_HEADLESS] = patch.browserHeadless;
    }
    if (patch.teamsNotify !== undefined) {
      state[MARSHAL_STATE_KEY_TEAMS_NOTIFY] = patch.teamsNotify;
    }
    out.state = state;
  }

  return out;
}

export function scheduleToCronExpr(schedule: AutomationSchedule, tz: string): CronSchedule {
  // The renderer sends only `naturalLanguage` with placeholder zeros for the
  // structured fields (pending). Mirror copilot's resolution
  // (`AutomationManager.create`/`update`) so both backends agree on the NL
  // contract — throwing on unparseable input matches copilot and surfaces a
  // real error via IPC instead of silently saving `0 0 * * *`. Empty NL falls
  // through to the structured fields for call sites that pass a resolved
  // schedule directly.
  if (schedule.naturalLanguage) {
    const parsed = parseSchedule(schedule.naturalLanguage);
    if (!parsed) {
      throw new Error(
        `Could not parse schedule: "${schedule.naturalLanguage}". ${SCHEDULE_FORMAT_HINT}`,
      );
    }
    return scheduleExprFromParts(parsed.days, parsed.hour, parsed.minute, tz);
  }
  return scheduleExprFromParts(schedule.days, schedule.hour, schedule.minute, tz);
}

// ── Patch map: Partial<AutomationData> → CronJobPatch ──────────────────

/**
 * Convert a Partial<AutomationData> patch into a CronJobPatch. Only the
 * fields the UI actually patches today are forwarded; anything else becomes
 * a no-op. Condition-triggered or pin/skill/permission fields are rejected —
 * capability flags should have prevented those paths ever reaching us.
 *
 * Phase 2b multi-step parity with the create path: when patch.steps has
 * length > 1, step 1's prompt becomes the agentTurn payload message and
 * steps 2..N are encoded into the description sentinel (preserving the
 * patch's user description, if any). Single-step patches retain the 2a
 * inline form (no sentinel).
 */
export function automationPatchToCronJobPatch(
  patch: Partial<AutomationData>,
  opts: MapOptions,
): CronJobPatch {
  // Belt-and-braces rejection of fields the UI should have gated out for
  // gateway mode. Matches the create path's condition / capability guards:
  // if a renderer bug or a stale IPC payload ever leaks these through, we
  // fail loudly rather than silently drop data the user expected to save.
  if (patch.triggerType === "condition") {
    return automationConditionPatchToCronJobPatch(patch);
  }
  validateGatewayScope(patch);
  for (const forbidden of ["pinnedSessionId", "workingDir", "skillNames", "permissions"] as const) {
    if (patch[forbidden] !== undefined) {
      throw new Error(
        `gateway-automation-map: ${forbidden} is not supported on gateway ` +
          "(capability flag should have prevented this path)",
      );
    }
  }

  const out: CronJobPatch = {};
  const model = normalizeModelOverride(patch.model);
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.enabled !== undefined) out.enabled = patch.enabled;
  if (patch.oneShot !== undefined) out.deleteAfterRun = patch.oneShot;
  if ("targetSessionId" in patch) {
    out.sessionTarget = sessionTargetForTargetSession(patch.targetSessionId) ?? "isolated";
  }
  if (patch.schedule !== undefined) {
    out.schedule = scheduleToCronExpr(patch.schedule, opts.tz);
  }
  if (patch.steps !== undefined) {
    if (patch.steps.length < 1) {
      throw new Error("gateway-automation-map: patch must have at least one step");
    }
    // Phase 2b: step 1's prompt → payload.message (same as create-path).
    out.payload = {
      kind: "agentTurn",
      message: patch.steps[0].prompt,
      ...(model !== undefined && { model }),
    };
    // Strip any pre-existing sentinel from the incoming description so we
    // don't double-encode if a caller passes the raw server-side description
    // (which already contains the sentinel from a prior encode pass), AND so
    // a multi→single downgrade explicitly clears any stale sentinel.
    const baseUserDesc = decodeMultiStepDescription(patch.description ?? "").userDescription;
    if (patch.steps.length > 1) {
      // Multi-step patch: encode steps[1..N] into the description sentinel.
      if (patch.description === undefined) {
        log.warn(
          "automationPatchToCronJobPatch: multi-step patch with no description; " +
            "user description will be cleared. Pass description alongside steps to preserve.",
        );
      }
      out.description = encodeMultiStepDescription(baseUserDesc, {
        v: 1,
        stepCount: patch.steps.length,
        steps: patch.steps.slice(1).map((s) => ({
          id: s.id,
          label: s.label,
          prompt: s.prompt,
        })),
        stepsHash: computeStepsHash(patch.steps),
      });
      return out;
    }
    // Single-step downgrade: explicitly rewrite description to the bare user
    // portion (no sentinel). Without this, when patch.description is undefined
    // (today's UI form sends `description: formDescription.trim() || undefined`)
    // we would skip the description field on the cron.update, leaving any
    // prior multi-step sentinel intact on the server. The next
    // cronJobToAutomationData would then rehydrate the deleted steps.
    out.description = baseUserDesc;
    return out;
  }
  // No-step patch: forward description verbatim. We can't tell from the patch
  // alone whether the live cron is multi-step (the mapper is pure — no server
  // state). Forwarding a bare description for a multi-step parent would wipe
  // the sentinel and lose steps[1..N] on the next run; rejecting at the
  // boundary is safer than silent data loss for hypothetical future callers
  // (CLI, IPC bridge, automation import). Today's UI always sends `steps`
  // alongside `description`, so this throw is unreachable from production
  // paths but blocks the footgun.
  if (patch.description !== undefined) {
    throw new Error(
      "gateway-automation-map: description-only patches are not supported. If the " +
        "automation is multi-step, the parent description carries the encoded steps " +
        "sentinel — overwriting it without resubmitting `steps` would silently wipe " +
        "steps[1..N]. Resubmit `steps` alongside `description`.",
    );
  }
  if ("model" in patch) {
    out.payload = { kind: "agentTurn", model };
  }
  if (patch.browserHeadless !== undefined || patch.teamsNotify !== undefined) {
    // Write state explicitly so an off-toggle communicates the new value (cron
    // `state` patches merge server-side, so the key sticks until overwritten).
    const state: Record<string, unknown> = {};
    if (patch.browserHeadless !== undefined) {
      state[MARSHAL_STATE_KEY_BROWSER_HEADLESS] = patch.browserHeadless;
    }
    if (patch.teamsNotify !== undefined) {
      state[MARSHAL_STATE_KEY_TEAMS_NOTIFY] = patch.teamsNotify;
    }
    out.state = state;
  }
  return out;
}

/**
 * Shared cron-expression builder used by both forward map (create path) and
 * patch path (update path in GatewayAutomationBackend). Single source of
 * truth for the day-of-week encoding (range-or-list) so forward and inverse
 * can't drift.
 */
export function scheduleExprFromParts(
  days: number[],
  hour: number,
  minute: number,
  tz: string,
): CronSchedule {
  const dow =
    days.length === 0 || DOW_ALL.every((d) => days.includes(d))
      ? "*"
      : formatDays([...new Set(days)].sort((a, b) => a - b));
  const expr = `${minute} ${hour} * * ${dow}`;
  return { kind: "cron", expr, tz };
}

// Emit contiguous runs of days as a dash range (e.g. [1,2,3,4,5] → "1-5"),
// otherwise fall back to comma-separated list. Matches the round-trip format
// expected by the inverse parser below.
function formatDays(sortedDays: number[]): string {
  if (sortedDays.length === 0) return "";
  const isContiguous =
    sortedDays.length >= 2 && sortedDays.every((d, i) => i === 0 || d === sortedDays[i - 1] + 1);
  if (isContiguous) {
    return `${sortedDays[0]}-${sortedDays[sortedDays.length - 1]}`;
  }
  return sortedDays.join(",");
}

// ── Inverse map: CronJob → AutomationData ───────────────────────────────

// Accepts the exact shapes emitted by scheduleToCronExpr:
//   "<min> <hour> * * *"          — every day
//   "<min> <hour> * * d1,d2,..."  — explicit day list
//   "<min> <hour> * * dLo-dHi"    — contiguous day range
const CRON_EMIT_RE = /^(\d+) (\d+) \* \* (\*|\d+(?:-\d+|(?:,\d+)+)?)$/;

// Markers from buildConditionWatcherPrompt; used to round-trip condition+action.
const CONDITION_REGEX = /CONDITION:\n([\s\S]+?)\n\nUse available tools/;
const ACTION_REGEX =
  /ACTION \(only run when condition is met, via sessions_spawn\):\n([\s\S]+?)\n\nIf similar work/;

interface ParsedWatcher {
  condition: string;
  steps: AutomationData["steps"];
}

// Detection signal: agentTurn payload with toolsAllow containing "sessions_spawn"
// — schedule-trigger automations don't set toolsAllow at all.
function tryParseWatcher(job: CronJob): ParsedWatcher | null {
  if (job.payload.kind !== "agentTurn") return null;
  const toolsAllow = job.payload.toolsAllow;
  if (!toolsAllow || !toolsAllow.includes("sessions_spawn")) return null;

  const message = job.payload.message;
  const conditionMatch = message.match(CONDITION_REGEX);
  if (!conditionMatch?.[1]) {
    // toolsAllow says watcher but template doesn't match — manually-edited
    // payload. Fall back rather than misclassify as schedule-trigger.
    return { condition: "", steps: [{ id: "step-0", label: job.name, prompt: "" }] };
  }
  const condition = conditionMatch[1].trim();

  const actionMatch = message.match(ACTION_REGEX);
  const actionBody = actionMatch?.[1]?.trim() ?? "";

  // Lossy single-step round-trip: buildActionPrompt joins with "\n\n" so step
  // boundaries can't be unambiguously rebuilt. Multi-step+condition is out-of-scope.
  const steps: AutomationData["steps"] = [{ id: "step-0", label: job.name, prompt: actionBody }];

  return { condition, steps };
}

export function cronJobToAutomationData(job: CronJob): AutomationData {
  const createdAt = new Date(job.createdAtMs).toISOString();
  const updatedAt = new Date(job.updatedAtMs).toISOString();

  const { schedule, targetSessionId } = parseScheduleAndTarget(job);

  // Watcher detection runs before the schedule-trigger path so a reconnect's
  // cron.list doesn't surface watchers as schedule automations.
  const watcher = tryParseWatcher(job);
  if (watcher) {
    const everyMs = job.schedule.kind === "every" ? job.schedule.everyMs : 900_000;
    // Snap to canonical so a non-canonical server-side value doesn't round-trip
    // into a number that fails conditionIntervalToCronSchedule validation.
    const minutes = Math.round(everyMs / 60_000);
    const CANONICAL_INTERVALS = [5, 15, 30, 60] as const;
    const conditionCheckInterval =
      CANONICAL_INTERVALS.find((c) => c === minutes) ??
      CANONICAL_INTERVALS.reduce((nearest, c) =>
        Math.abs(c - minutes) < Math.abs(nearest - minutes) ? c : nearest,
      );
    const headlessState = job.state?.[MARSHAL_STATE_KEY_BROWSER_HEADLESS];
    const browserHeadless = headlessState === true ? true : undefined;
    const teamsNotify = readTeamsNotifyFromState(job.state);
    return {
      id: job.id,
      name: job.name,
      description: job.description,
      enabled: job.enabled,
      oneShot: job.deleteAfterRun ?? false,
      createdAt,
      updatedAt,
      triggerType: "condition",
      condition: watcher.condition,
      conditionCheckInterval,
      // Renderer's form expects `schedule` even for condition triggers; emit
      // a readOnly placeholder so it's well-typed.
      schedule: {
        naturalLanguage: `every ${conditionCheckInterval}m`,
        days: [],
        hour: 0,
        minute: 0,
        readOnly: true,
      },
      steps: watcher.steps,
      pinnedSessionId: undefined,
      ...(targetSessionId !== undefined ? { targetSessionId } : {}),
      ...(job.payload.kind === "agentTurn" && job.payload.model !== undefined
        ? { model: job.payload.model }
        : {}),
      ...(browserHeadless !== undefined ? { browserHeadless } : {}),
      ...(teamsNotify !== undefined ? { teamsNotify } : {}),
    };
  }

  // Phase 2b multi-step: if the description carries the multi-step
  // sentinel, decode steps 2..N from it. Step 1 always comes from
  // job.payload (agentTurn message). If the sentinel is absent or
  // malformed (e.g. a user edited the description externally and removed
  // it), fall back to single-step view of the parent payload. Spec §4.2.
  const sentinelDecoded = decodeMultiStepDescription(job.description ?? "");
  const userDescription = sentinelDecoded.userDescription;
  const multiStepState = sentinelDecoded.state;

  // Defense-in-depth: listAutomations filters `payload.kind === "agentTurn"`
  // before calling this mapper (see GatewayAutomationBackend.listAutomations),
  // so the systemEvent branch below is unreachable via the production call
  // path. We keep it so direct callers of cronJobToAutomationData (e.g.
  // future ad-hoc inverse-map tests) don't crash on foreign payloads.
  let steps: AutomationData["steps"];
  if (multiStepState && job.payload.kind === "agentTurn") {
    const step1 = { id: "step-0", label: job.name, prompt: job.payload.message };
    const tailSteps = multiStepState.steps.map((s) => ({
      id: s.id,
      label: s.label ?? "",
      prompt: s.prompt,
    }));
    steps = [step1, ...tailSteps];
  } else if (job.payload.kind === "agentTurn") {
    steps = [{ id: "step-0", label: job.name, prompt: job.payload.message }];
  } else {
    steps = [{ id: "step-0", label: "System event", prompt: "" }];
  }

  const headlessState = job.state?.[MARSHAL_STATE_KEY_BROWSER_HEADLESS];
  const browserHeadless = headlessState === true ? true : undefined;
  const teamsNotify = readTeamsNotifyFromState(job.state);

  return {
    id: job.id,
    name: job.name,
    description: userDescription,
    enabled: job.enabled,
    oneShot: job.deleteAfterRun ?? false,
    createdAt,
    updatedAt,
    triggerType: "schedule",
    schedule,
    steps,
    // pinnedSessionId is never populated — see spec §8 "Session semantics"
    pinnedSessionId: undefined,
    ...(targetSessionId !== undefined ? { targetSessionId } : {}),
    ...(job.payload.kind === "agentTurn" && job.payload.model !== undefined
      ? { model: job.payload.model }
      : {}),
    ...(browserHeadless !== undefined ? { browserHeadless } : {}),
    ...(teamsNotify !== undefined ? { teamsNotify } : {}),
  };
}

function parseScheduleAndTarget(job: CronJob): {
  schedule: AutomationSchedule;
  sessionPinnable: boolean;
  targetSessionId?: string;
} {
  const rawExplicitTarget =
    job.sessionTarget.startsWith("session:") && !job.sessionTarget.startsWith("session:auto-")
      ? job.sessionTarget.slice("session:".length)
      : undefined;
  const explicitTarget = normalizeOptionalString(rawExplicitTarget);
  const foreignTarget =
    job.sessionTarget !== "isolated" &&
    job.sessionTarget !== "main" &&
    job.sessionTarget !== "current" &&
    !job.sessionTarget.startsWith("session:auto-") &&
    explicitTarget === undefined;
  if (job.schedule.kind === "at") {
    return {
      schedule: {
        naturalLanguage: `one-shot at ${job.schedule.at}`,
        days: [],
        hour: 0,
        minute: 0,
        readOnly: true,
      },
      sessionPinnable: false,
      ...(explicitTarget !== undefined ? { targetSessionId: explicitTarget } : {}),
    };
  }
  if (job.schedule.kind === "every") {
    return {
      schedule: {
        naturalLanguage: `every ${humanizeMs(job.schedule.everyMs)}`,
        days: [],
        hour: 0,
        minute: 0,
        readOnly: true,
      },
      sessionPinnable: false,
      ...(explicitTarget !== undefined ? { targetSessionId: explicitTarget } : {}),
    };
  }
  const match = CRON_EMIT_RE.exec(job.schedule.expr);
  if (!match || foreignTarget) {
    return {
      schedule: {
        naturalLanguage: job.schedule.expr,
        days: [],
        hour: 0,
        minute: 0,
        readOnly: true,
      },
      sessionPinnable: false,
      ...(explicitTarget !== undefined ? { targetSessionId: explicitTarget } : {}),
    };
  }
  const [, minStr, hourStr, dowStr] = match;
  const days = dowStr === "*" ? [...DOW_ALL] : parseDayField(dowStr);
  const hour = Number(hourStr);
  const minute = Number(minStr);
  return {
    schedule: {
      naturalLanguage: formatScheduleNL(days, hour, minute),
      days,
      hour,
      minute,
    },
    sessionPinnable: true,
    ...(explicitTarget !== undefined ? { targetSessionId: explicitTarget } : {}),
  };
}

function parseDayField(dowStr: string): number[] {
  const dashMatch = /^(\d+)-(\d+)$/.exec(dowStr);
  if (dashMatch) {
    const lo = Number(dashMatch[1]);
    const hi = Number(dashMatch[2]);
    const out: number[] = [];
    for (let d = lo; d <= hi; d++) out.push(d);
    return out;
  }
  return dowStr.split(",").map((d) => Number(d));
}

function humanizeMs(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}

// ── Multi-step description sentinel (Phase 2b) ─────────────────────────
//
// Spec §4.2.

// Marshal identity: persisted Gateway automation descriptions already contain this sentinel.
const SENTINEL_PREFIX = "[__m_multistep_v1__:";
const SENTINEL_SUFFIX = "]";
const SENTINEL_REGEX = /\n\n\[__m_multistep_v1__:([A-Za-z0-9+/=]+)\]\s*$/;

export type MultiStepState = {
  v: 1;
  stepCount: number;
  steps: Array<{
    id: string;
    label?: string;
    prompt: string;
  }>;
  stepsHash: string;
};

export function encodeMultiStepDescription(userDescription: string, state: MultiStepState): string {
  const json = JSON.stringify(state);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  return `${userDescription}\n\n${SENTINEL_PREFIX}${b64}${SENTINEL_SUFFIX}`;
}

export function decodeMultiStepDescription(description: string): {
  userDescription: string;
  state: MultiStepState | null;
} {
  const match = description.match(SENTINEL_REGEX);
  if (!match) {
    return { userDescription: description, state: null };
  }
  const b64 = match[1];
  let parsed: unknown;
  try {
    const json = Buffer.from(b64, "base64").toString("utf8");
    parsed = JSON.parse(json) as unknown; // SF-4: validated structurally by isMultiStepState below before any field is read
  } catch {
    return { userDescription: description, state: null };
  }
  if (!isMultiStepState(parsed)) {
    return { userDescription: description, state: null };
  }
  const userDescription = description.slice(0, match.index).trimEnd();
  return { userDescription, state: parsed };
}

/**
 * sha256 over canonicalized steps[]. Used to detect when an automation's
 * steps were edited externally (CLI / marshal web) so the form can warn
 * the user that local state diverged from server state.
 */
export function computeStepsHash(
  steps: Array<{ id: string; label?: string; prompt: string }>,
): string {
  const canonical = steps.map((s) => ({
    id: s.id,
    label: s.label ?? "",
    prompt: s.prompt,
  }));
  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json).digest("hex");
}

function isMultiStepState(value: unknown): value is MultiStepState {
  if (typeof value !== "object" || value === null) return false;
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- value narrowed to non-null object above; cast widens to indexable Record for property reads guarded by typeof checks
  const v = value as Record<string, unknown>;
  if (v.v !== 1) return false;
  if (typeof v.stepCount !== "number" || !Number.isInteger(v.stepCount) || v.stepCount < 2)
    return false;
  if (!Array.isArray(v.steps)) return false;
  // stepCount counts ALL steps including step-0 (which lives in payload.message);
  // sentinel only carries steps[1..N], so steps.length must be stepCount - 1.
  if (v.steps.length !== v.stepCount - 1) return false;
  if (typeof v.stepsHash !== "string") return false;
  for (const step of v.steps) {
    if (typeof step !== "object" || step === null) return false;
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- step narrowed to non-null object above; cast widens to indexable Record for property reads guarded by typeof checks
    const s = step as Record<string, unknown>;
    if (typeof s.id !== "string") return false;
    if (typeof s.prompt !== "string") return false;
    if (s.label !== undefined && typeof s.label !== "string") return false;
  }
  return true;
}

// ── Tail-cron name encoding (Phase 2b) ──────────────────────────────────
//
// Spec §4.3.

const TAIL_NAME_REGEX = /^auto-(?<parentId>.+)-r(?<runInstanceId>\d+)-s(?<stepIndex>\d+)$/;

export function buildTailCronName(
  parentId: string,
  runInstanceId: string,
  stepIndex: number,
): string {
  return `auto-${parentId}-r${runInstanceId}-s${stepIndex}`;
}

export function parseTailCronName(
  name: string,
): { parentId: string; runInstanceId: string; stepIndex: number } | null {
  const m = name.match(TAIL_NAME_REGEX);
  if (!m?.groups) return null;
  const stepIndex = parseInt(m.groups.stepIndex, 10);
  if (!Number.isFinite(stepIndex)) return null;
  return {
    parentId: m.groups.parentId,
    runInstanceId: m.groups.runInstanceId,
    stepIndex,
  };
}

export function matchesParentTailPattern(parentId: string): RegExp {
  const escaped = parentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^auto-${escaped}-r\\d+-s\\d+$`);
}

// ── {{previousOutput}} substitution (Phase 2b) ──────────────────────────
//
// Spec §4.4.

const PREV_OUTPUT_REGEX = /\{\{\s*previousOutput\s*\}\}/g;

export function substitutePreviousOutput(prompt: string, previousOutput: string): string {
  return prompt.replace(PREV_OUTPUT_REGEX, previousOutput);
}

// ── Run log entry → AutomationRunData ───────────────────────────────────

export function cronRunLogEntryToAutomationRunData(
  entry: CronRunLogEntry,
  automationId: string,
  index: number,
): AutomationRunData {
  const startedAtMs = entry.runAtMs ?? entry.ts;
  const startedAt = new Date(startedAtMs).toISOString();
  const completedAt =
    entry.durationMs !== undefined
      ? new Date(startedAtMs + entry.durationMs).toISOString()
      : undefined;
  const status: AutomationRunData["status"] =
    entry.status === "ok" ? "completed" : entry.status === "error" ? "failed" : "skipped";
  const stepStatus = status === "failed" ? "failed" : "completed";

  return {
    id: `${automationId}:${startedAtMs}:${index}`,
    automationId,
    sessionId: entry.sessionId,
    startedAt,
    completedAt,
    status,
    stepResults: [
      {
        stepId: "step-0",
        status: stepStatus,
        output: entry.summary,
        error: entry.error,
      },
    ],
    finalOutput: entry.summary,
  };
}
