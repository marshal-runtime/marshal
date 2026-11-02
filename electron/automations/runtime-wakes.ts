import { randomUUID } from "node:crypto";
import path from "node:path";

import { RUNTIME_SCHEDULE_EFFECT_KINDS } from "@marshal/agent-runtime-core";
import type { RuntimeScheduleSnapshot } from "@marshal/agent-runtime-core";
import {
  AGENT_WAKE_TASK_KIND,
  createAgentWakeRunner,
  FileScheduleStore,
  RuntimeScheduleService,
  type RuntimeScheduleEvent,
  type RuntimeWakePort,
} from "@marshal/agent-runtime-effects";

import { createLogger } from "../../common/marshal-logger";
import type { PermissionPolicy } from "../permission-policy";
import type { SessionManager } from "../sessions";
import type {
  RuntimeOneOffWake,
  RuntimeOneOffWakeInput,
  RuntimeOneOffWakes,
} from "./runtime-wakes-types";

const log = createLogger("RuntimeWakes");

const SCHEDULES_DIRECTORY = "schedules";
const PROTOCOL_VERSION = "1";
const PRINCIPAL = { id: "marshal-desktop", kind: "agent" } as const;
const MS_PER_MINUTE = 60_000;
export const WAKE_TURN_TIMEOUT_MS = 5 * MS_PER_MINUTE;
const RUNNER_TIMEOUT_MS = WAKE_TURN_TIMEOUT_MS + MS_PER_MINUTE;
const CLAIM_LEASE_MS = 2 * RUNNER_TIMEOUT_MS;
export const WAKE_TICK_MS = 15_000;
export const MAX_LIVE_WAKES = 50;
const WAKE_CLIENT_MESSAGE_PREFIX = "runtime-wake:";
const WAKE_DIVIDER_PREFIX = "wake-start-";
const WAKE_MESSAGE_PREFIX = "wake-";

type WakeSessionManager = Pick<
  SessionManager,
  "getSession" | "getSessionAsync" | "switchSession" | "appendMessage" | "sendAndCollect"
>;
type WakePermissionPolicy = Pick<PermissionPolicy, "setDenyPrompt" | "markUnattended">;

export interface SessionWakePortDeps {
  sessionManager: WakeSessionManager;
  permissionPolicy: WakePermissionPolicy;
}

/** Resumes the target session with the wake message; a wake raises an error only when the message was not delivered. */
export function createSessionWakePort(deps: SessionWakePortDeps): RuntimeWakePort {
  return {
    async wake({ target, message, fire }) {
      const sessionId = target.sessionId;
      if (!sessionId) throw new Error("A desktop wake needs a target sessionId.");
      const { sessionManager, permissionPolicy } = deps;
      const existing =
        sessionManager.getSession(sessionId) ?? (await sessionManager.getSessionAsync(sessionId));
      if (!existing) throw new Error(`Target session '${sessionId}' not found`);
      if ((await sessionManager.switchSession(sessionId)).kind === "notFound") {
        throw new Error(`Target session '${sessionId}' not found`);
      }
      permissionPolicy.setDenyPrompt(sessionId);
      permissionPolicy.markUnattended(sessionId);
      const now = new Date();
      sessionManager.appendMessage(sessionId, {
        id: `${WAKE_DIVIDER_PREFIX}${fire.fireId}`,
        role: "system",
        content: `⏰ Scheduled wake — ${now.toLocaleDateString([], { month: "short", day: "numeric" })}, ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
        timestamp: now.toISOString(),
      });
      sessionManager.appendMessage(sessionId, {
        id: `${WAKE_MESSAGE_PREFIX}${fire.fireId}`,
        role: "user",
        content: message,
        timestamp: now.toISOString(),
      });
      const result = await sessionManager.sendAndCollect(
        message,
        WAKE_TURN_TIMEOUT_MS,
        undefined,
        sessionId,
        undefined,
        {
          clientMessageId: `${WAKE_CLIENT_MESSAGE_PREFIX}${fire.fireId}`,
        },
      );
      if (result.kind !== "ok") {
        log.warn(
          `wake ${fire.scheduleId} delivered to ${sessionId}; the turn ended with ${result.kind}`,
        );
      }
    },
  };
}

export interface DesktopRuntimeWakesOptions {
  userDataDirectory: string;
  wakePort: RuntimeWakePort;
  now?: () => Date;
  onEvent?: (event: RuntimeScheduleEvent) => void;
}

/** The runtime scheduler of the desktop app: one-off session wakes that fire without AutomationManager. */
export interface DesktopRuntimeWakes extends RuntimeOneOffWakes {
  service: RuntimeScheduleService;
}

const logEvent = (event: RuntimeScheduleEvent): void => {
  const detail = `schedule ${event.fire.scheduleId} attempt ${event.fire.attempt}`;
  if (event.type === "fired") log.info(`${detail} fired`);
  else log.warn(`${detail} ${event.type}: ${event.error}`);
};

export function createDesktopRuntimeWakes(
  options: DesktopRuntimeWakesOptions,
): DesktopRuntimeWakes {
  const service = new RuntimeScheduleService({
    store: new FileScheduleStore({
      rootDirectory: path.join(options.userDataDirectory, SCHEDULES_DIRECTORY),
    }),
    runners: { [AGENT_WAKE_TASK_KIND]: createAgentWakeRunner(options.wakePort) },
    tickMs: WAKE_TICK_MS,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
    claimLeaseMs: CLAIM_LEASE_MS,
    maxLivePerOwner: MAX_LIVE_WAKES,
    ...(options.now ? { now: options.now } : {}),
    onEvent: (event) => {
      logEvent(event);
      options.onEvent?.(event);
    },
  });
  const call = async <T>(
    operation: keyof typeof RUNTIME_SCHEDULE_EFFECT_KINDS,
    input: Record<string, unknown>,
  ) => {
    const result = await service.handle<Record<string, unknown>, T>(
      {
        protocolVersion: PROTOCOL_VERSION,
        kind: RUNTIME_SCHEDULE_EFFECT_KINDS[operation],
        input,
        idempotencyKey: randomUUID(),
      },
      { principal: PRINCIPAL },
    );
    if (result.status !== "success") {
      throw new Error(
        result.status === "failed"
          ? result.error.message
          : `the scheduler answered ${result.status}`,
      );
    }
    return result.output;
  };
  return {
    service,
    async schedule({ sessionId, message, at }: RuntimeOneOffWakeInput): Promise<RuntimeOneOffWake> {
      const snapshot = await call<RuntimeScheduleSnapshot>("create", {
        timing: { kind: "once", at: at.toISOString() },
        task: { kind: AGENT_WAKE_TASK_KIND, input: { target: { sessionId }, message } },
      });
      return { scheduleId: snapshot.scheduleId, at: at.toISOString() };
    },
    async cancel(scheduleId) {
      const live = await call<{ schedules: RuntimeScheduleSnapshot[] }>("list", {
        state: "active",
      });
      if (!live.schedules.some((snapshot) => snapshot.scheduleId === scheduleId)) return false;
      await call("cancel", { scheduleId });
      return true;
    },
  };
}
