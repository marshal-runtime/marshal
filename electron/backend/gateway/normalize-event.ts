/**
 * Gateway event normalization — converts Marshal gateway `agent` events into
 * the BackendEvent contract.
 *
 * Extracted into its own module so it can be unit-tested without pulling in
 * Electron dependencies that are imported by gateway/provider.ts.
 *
 * The gateway sends events with the envelope:
 *   { "type": "event", "event": "<event_name>", "payload": { ... } }
 *
 * This function receives `eventName` and `payload` already extracted from the
 * envelope.
 */

import type { BackendEvent, SessionMessage } from "../types";

/** Safely extract a string from an unknown value. */
function str(val: unknown): string {
  return typeof val === "string" ? val : "";
}

/**
 * Narrowing predicates for the unknown payloads `normalizeGatewayEvent` and
 * `normalizeHistoryMessages` consume. Replace the `as Record<string, unknown>`
 * casts that TypeScript can't otherwise infer from `typeof === "object"` (which
 * narrows to `object`, no index signature) or `Array.isArray` (narrows to
 * `unknown[]`, not `Record<string, unknown>[]`).
 */
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isRecordArray(x: unknown): x is Array<Record<string, unknown>> {
  return Array.isArray(x) && x.every(isRecord);
}

/**
 * Pull a human-readable error string out of an Marshal tool result envelope.
 * Subset of the marshal extractor (`pi-embedded-subscribe.tools.ts:484`):
 * checks `result.details.error` then `result.error`. Returns undefined when
 * no obvious error field is present — the caller still marks the event as a
 * failure via `success:false`, but the UI falls back to a generic message.
 */
function extractToolError(result: unknown): string | undefined {
  if (typeof result === "string" && result.length > 0) return result;
  if (!isRecord(result)) return undefined;
  const details = result.details;
  if (isRecord(details) && typeof details.error === "string" && details.error.length > 0) {
    return details.error;
  }
  if (typeof result.error === "string" && result.error.length > 0) {
    return result.error;
  }
  return undefined;
}

/**
 * Convert a gateway event name + payload into zero or more normalized
 * BackendEvents. Events that don't map to the BackendEvent contract are
 * silently dropped (return []).
 */
export function normalizeGatewayEvent(
  eventName: string,
  payload: Record<string, unknown>,
): BackendEvent[] {
  // Handle chat events with state: "final" — these contain the complete committed message.
  // We emit turn-complete so TurnAccumulator commits the message.
  if (eventName === "chat") {
    const state = str(payload.state);
    if (state === "final") {
      const rawMessage: unknown = payload.message;
      const message = isRecord(rawMessage) ? rawMessage : undefined;
      if (message) {
        const role =
          message.role === "user" || message.role === "assistant" ? message.role : "assistant";
        const rawContent = isRecordArray(message.content)
          ? message.content
              .filter((b) => b.type === "text")
              .map((b) => str(b.text))
              // Drop bare tool-result JSON envelopes from assistant turns
              // (e.g. `{ "results": [], "provider": "none", ... }`) that
              // marshal sometimes intersperses with the model's real reply.
              .filter((text) => !(role === "assistant" && isLikelyToolResultJson(text.trim())))
              .join("")
          : "";
        const content = cleanMarshalMessageText(rawContent, role);
        if (content) {
          // Emit turn-complete (commits the message) followed by idle (resets UI to ready state).
          // This replaces the old lifecycle.end → idle path, which fired before chat.final
          // and caused the accumulator to reset before the complete message arrived.
          return [
            {
              type: "turn-complete",
              message: {
                id: str(payload.runId) || Date.now().toString(),
                role: "assistant",
                content,
              },
            },
            { type: "idle" },
          ];
        }
      }
    }
    // Server-side run error (e.g. "LLM request timed out.") — surface it as
    // turn-error so the renderer alert fires and the user isn't left staring
    // at an indefinite spinner. Mark recoverable so the UI shows a retry path
    // rather than a fatal banner — most of these are transient runtime/LLM
    // issues, not client misconfigurations.
    if (state === "error") {
      const errMsg = str(payload.errorMessage) || "Run failed (no error message from runtime)";
      return [{ type: "turn-error", error: errMsg, recoverable: true }];
    }
    // Ignore delta/other chat states — agent events handle streaming
    return [];
  }

  if (eventName !== "agent") {
    return [];
  }

  const stream = str(payload.stream);
  const rawData = payload.data;
  const data: Record<string, unknown> =
    rawData !== null && typeof rawData === "object" ? { ...rawData } : {};

  switch (stream) {
    case "assistant": {
      if (typeof data.delta === "string") {
        return [{ type: "text-delta", text: data.delta }];
      }
      if (typeof data.text === "string") {
        return [{ type: "text-snapshot", text: data.text }];
      }
      return [];
    }

    case "lifecycle": {
      if (data.phase === "end") {
        // Don't emit idle here — the chat "final" event (which arrives after
        // lifecycle.end) emits turn-complete with the full committed message.
        // Emitting idle here would cause TurnAccumulator to commit partial
        // content, then turn-complete would try to commit again on a reset
        // accumulator, producing a blank message that clears the view.
        return [];
      }
      return [];
    }

    case "tool": {
      const phase = str(data.phase);
      const toolCallId = str(data.toolCallId);
      if (!toolCallId) return [];

      if (phase === "start") {
        const toolName = str(data.name);
        const serverName = str(data.serverName);
        if (!toolName) return [];
        return [
          {
            type: "tool-start",
            toolCallId,
            toolName,
            ...(serverName ? { serverName } : {}),
            ...(data.args !== undefined ? { args: data.args } : {}),
            startedAtMs: Date.now(),
          },
        ];
      }
      if (phase === "result") {
        const isError = data.isError === true;
        const error = isError ? extractToolError(data.result) : undefined;
        return [
          {
            type: "tool-result",
            toolCallId,
            result: data.result,
            success: !isError,
            ...(error ? { error } : {}),
            completedAtMs: Date.now(),
          },
        ];
      }
      // phase:"update" (live partial results) is intentionally dropped: no tool-delta variant exists in the BackendEvent contract (Copilot parity).
      return [];
    }

    default:
      return [];
  }
}

/**
 * Flatten Marshal `chat.history` message entries into the SessionMessage
 * shape used by the renderer. Non-text content blocks (tool_call, tool_result,
 * attachments, reasoning) are silently dropped in Slice 1 — tool rendering
 * lives in a later slice. Roles outside the SessionMessage union ("tool",
 * "other") collapse to "system" so the renderer treats them as neutral info.
 */
export function normalizeHistoryMessages(raw: Array<Record<string, unknown>>): SessionMessage[] {
  const result: SessionMessage[] = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    const role: "user" | "assistant" | "system" =
      entry.role === "user" || entry.role === "assistant" ? entry.role : "system";
    const blocks = isRecordArray(entry.content) ? entry.content : [];
    const rawText = blocks
      .filter((b) => b.type === "text")
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .filter((text) => !(role === "assistant" && isLikelyToolResultJson(text.trim())))
      .join("");
    const content = cleanMarshalMessageText(rawText, role);
    // Skip messages whose content reduces to empty after cleaning — those are
    // pure marshal-injected context (cron headers, system events, bare
    // tool-result JSON blobs) that have no value to surface in the chat view.
    if (!content.trim()) continue;
    const timestamp =
      typeof entry.timestamp === "number"
        ? String(entry.timestamp)
        : typeof entry.timestamp === "string"
          ? entry.timestamp
          : "";
    const marshalMeta = isRecord(entry.__marshal) ? entry.__marshal : null;
    const marshalId = marshalMeta && typeof marshalMeta.id === "string" ? marshalMeta.id : null;
    const id = marshalId ?? `hist-${index}-${timestamp}`;
    result.push({
      id,
      role,
      content,
      timestamp,
    });
  }
  return result;
}

/**
 * Strip marshal-injected metadata from transcript text so the chat view
 * shows what the user actually typed / what the agent actually said, not the
 * server-side prompt plumbing.
 *
 * Marshal wraps cron-fired user prompts with a header like
 * `[cron:<jobId> <jobName>]` and appends a `Current time: …` suffix; the
 * assistant sometimes quotes raw tool-result JSON blobs back in the
 * transcript. None of that is meaningful chat content.
 */
function cleanMarshalMessageText(text: string, role: "user" | "assistant" | "system"): string {
  let out = text;
  // Leading cron context header, e.g. `[cron:<uuid> Morning briefing] `
  out = out.replace(/^\[cron:[A-Za-z0-9-]+\s+[^\]]+\]\s*/, "");
  // Trailing "Current time:" block marshal appends to cron-fired prompts.
  out = out.replace(/\s*Current time:[\s\S]*$/i, "");
  // Assistant messages sometimes open with a bare tool-result JSON envelope
  // inline with the actual reply (marshal concatenates search-tool output
  // into the assistant text stream rather than surfacing it as a tool block).
  // Strip the leading envelope if we can cleanly parse it and recognize the
  // signal keys — the subsequent prose is the actual message.
  if (role === "assistant") {
    out = stripLeadingToolResultJson(out);
  }
  return out.trim();
}

/**
 * If `text` begins with a balanced JSON object whose keys look like a
 * tool-result envelope (results / provider / citations / mode), strip that
 * object (and any trailing whitespace before the real content). Returns the
 * remaining text if we found an envelope, or the original text untouched.
 */
function stripLeadingToolResultJson(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return text;
  // Find the matching closing brace by balancing depth; honor string literals
  // so braces inside strings don't fool the counter.
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return text;
  const candidate = trimmed.slice(0, end + 1);
  if (!isLikelyToolResultJson(candidate)) return text;
  const remainder = trimmed.slice(end + 1);
  return remainder.replace(/^\s+/, "");
}

function isLikelyToolResultJson(text: string): boolean {
  if (!text.startsWith("{") || !text.endsWith("}")) return false;
  try {
    const parsed: unknown = JSON.parse(text); // SF-4: narrowed to object via typeof check below; only `results`/`provider`/`citations`/`mode` keys are read, never propagated upward.
    if (typeof parsed !== "object" || parsed === null) return false;
    // Signatures we've observed in marshal transcripts: search tool result
    // envelopes with `results` + `provider` + `mode`, or similar bare tool
    // payloads. Narrow enough to avoid eating legitimate JSON-in-reply text.
    const keys = Object.keys(parsed);
    const toolResultSignals = ["results", "provider", "citations", "mode"];
    const matches = keys.filter((k) => toolResultSignals.includes(k)).length;
    return matches >= 2;
  } catch {
    return false;
  }
}
