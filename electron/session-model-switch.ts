import { parseRuntimeTargetKey } from "../common/runtime-accounts";
import { getRuntimeDisplayName } from "../common/runtime-config";
import {
  type resolveSessionExecutionRuntimeId,
  resolveSessionExecutionTargetKey,
} from "../common/runtime-qualified-model";

/**
 * How a model change reaches the backend:
 * - `persist-only`: no backend session is running; the next start uses the new model.
 * - `live`: the running backend session switches model in place and keeps its native history.
 * - `recreate`: the backend session is destroyed and started again with the new model; the
 *   conversation is carried over by injecting it into the system message.
 */
export type SessionModelSwitchMode = "persist-only" | "live" | "recreate";

export type SessionBackendState = "none" | "starting" | "live";

export interface SessionModelSwitchPlan {
  mode: SessionModelSwitchMode;
  fromRuntimeId: string;
  toRuntimeId: string;
  crossRuntime: boolean;
}

type SwitchableSession = Parameters<typeof resolveSessionExecutionRuntimeId>[0];

/**
 * A session keeps its runtimeId partition; only the execution runtime and account follow the
 * model. Moving to another account of the same runtime is a cross-runtime switch: each account
 * has its own client, so the conversation is handed off like any other runtime change.
 */
export function planSessionModelSwitch(args: {
  session: SwitchableSession;
  nextModel: string;
  backend: SessionBackendState;
  /** Prefer an in-place switch when the execution runtime does not change. */
  liveSwitch: boolean;
}): SessionModelSwitchPlan {
  const fromRuntimeId = resolveSessionExecutionTargetKey(args.session);
  const toRuntimeId = resolveSessionExecutionTargetKey({ ...args.session, model: args.nextModel });
  const crossRuntime = fromRuntimeId !== toRuntimeId;
  const mode: SessionModelSwitchMode =
    args.backend === "none"
      ? "persist-only"
      : args.backend === "live" && args.liveSwitch && !crossRuntime
        ? "live"
        : "recreate";
  return { mode, fromRuntimeId, toRuntimeId, crossRuntime };
}

function targetDisplayName(targetKey: string): string {
  const target = parseRuntimeTargetKey(targetKey);
  const name = getRuntimeDisplayName(target?.runtimeId ?? targetKey);
  return target?.accountId ? `${name} (${target.accountId})` : name;
}

/**
 * The user-facing error for a model switch whose destination could not start. The chat stays
 * on its current runtime, so the message says so and names the next step.
 */
export function describeModelSwitchFailure(args: {
  fromRuntimeId: string;
  toRuntimeId: string;
  error: unknown;
}): string {
  const to = targetDisplayName(args.toRuntimeId);
  const from = targetDisplayName(args.fromRuntimeId);
  const detail = args.error instanceof Error ? args.error.message : String(args.error);
  const next = /not available in the/i.test(detail)
    ? `Pick a model from ${to}'s list, or check that account's plan.`
    : /usage limit|quota|rate limit|\b429\b|limit reached/i.test(detail)
      ? `That ${to} account hit a usage limit. Pick another account or try again later.`
      : /sign.?in|signed in|log.?in|auth|credential|unauthori[sz]ed|\b401\b|\b403\b|api key|token/i.test(
            detail,
          )
        ? `${to} isn't signed in. Sign in under Settings → Runtime accounts, then pick the model again.`
        : `Check ${to} under Settings → Runtime accounts, then pick the model again.`;
  const reason = /[.!?]$/.test(detail.trim()) ? detail.trim() : `${detail.trim()}.`;
  return `Couldn't switch this chat to ${to}: ${reason} The chat stays on ${from}. ${next}`;
}

/** A handoff needs an idle chat; model switches turn this into a pending switch. */
export class RuntimeHandoffBusyError extends Error {
  constructor() {
    super("Wait for the current response to finish before changing its runtime");
    this.name = "RuntimeHandoffBusyError";
  }
}

export const SWITCH_CONTEXT_MAX_MESSAGES = 24;
export const SWITCH_CONTEXT_MAX_MESSAGE_CHARS = 4_000;
export const SWITCH_CONTEXT_MAX_CHARS = 40_000;

interface ContextMessage {
  id: string;
  role: string;
  content: string;
}

function formatMessage(message: ContextMessage): string {
  const speaker = message.role === "user" ? "User" : "Assistant";
  const content =
    message.content.length > SWITCH_CONTEXT_MAX_MESSAGE_CHARS
      ? `${message.content.slice(0, SWITCH_CONTEXT_MAX_MESSAGE_CHARS)}… [truncated]`
      : message.content;
  return `${speaker}: ${content}`;
}

function boundedTranscript(messages: readonly ContextMessage[], budget: number): string {
  const kept: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (kept.length >= SWITCH_CONTEXT_MAX_MESSAGES) break;
    const formatted = formatMessage(messages[index]);
    if (kept.length > 0 && used + formatted.length > budget) break;
    kept.unshift(formatted);
    used += formatted.length + 2;
  }
  const omitted = messages.length - kept.length;
  const note = omitted > 0 ? `(${omitted} earlier messages omitted)\n\n` : "";
  return `${note}${kept.join("\n\n")}`;
}

/**
 * Conversation context for a backend restarted by a model switch, built without a model call:
 * the cached summary (when one exists) followed by the most recent messages verbatim, bounded by
 * message count and characters.
 */
export function buildBoundedSwitchContext(
  messages: readonly ContextMessage[],
  cached?: { summary?: string; upToMessageId?: string },
): string | null {
  if (messages.length === 0) return null;
  const summaryIndex =
    cached?.summary && cached.upToMessageId
      ? messages.findIndex((message) => message.id === cached.upToMessageId)
      : -1;
  if (summaryIndex < 0 || !cached?.summary) {
    return boundedTranscript(messages, SWITCH_CONTEXT_MAX_CHARS);
  }
  const tail = messages.slice(summaryIndex + 1);
  if (tail.length === 0) return cached.summary;
  const budget = Math.max(SWITCH_CONTEXT_MAX_CHARS - cached.summary.length, 0);
  return `${cached.summary}\n\n### Messages since that summary\n\n${boundedTranscript(tail, budget)}`;
}
