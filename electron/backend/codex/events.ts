import { randomUUID } from "node:crypto";

import { AUTH_REQUIRED_ERROR_CODE } from "../../../common/foundation/auth/auth-errors";
import type { RuntimeSessionEvent } from "../../../common/runtime-events";
import { USAGE_LIMIT_ERROR_CODE } from "../../../common/runtime-usage-limit";
import {
  type CodexThread,
  type CodexThreadItem,
  type CodexTurn,
  isRecord,
  nullableNumber,
  nullableString,
  optionalString,
  requireArray,
  requireNumber,
  requireRecord,
  requireString,
  type UnknownRecord,
} from "./protocol";

interface EventContext {
  timestamp?: string;
  parentId?: string | null;
}

/** Shown when Codex reports its ChatGPT/API sign-in is missing, revoked, or cannot refresh. */
export const CODEX_SIGN_IN_REQUIRED_MESSAGE =
  "Codex isn't signed in or its sign-in expired. Sign in under Settings → Runtime accounts.";

export const CODEX_PROCESS_LOST_MESSAGE =
  "Codex stopped unexpectedly and this reply was cut short. Send your message again to reconnect.";
export interface CodexTurnError {
  message: string;
  codexErrorInfo: unknown;
}

/** `unauthorized`, or any transport variant that carries an upstream HTTP 401. */
export function isCodexAuthFailure(info: unknown): boolean {
  if (info === "unauthorized") return true;
  if (!isRecord(info)) return false;
  return Object.values(info).some(
    (variant) => isRecord(variant) && variant["httpStatusCode"] === 401,
  );
}

export function isCodexUsageLimit(info: unknown): boolean {
  return info === "usageLimitExceeded" || info === "sessionBudgetExceeded";
}

/** Rate-limit usage at or above this share is surfaced as a status line during a turn. */
const RATE_LIMIT_STATUS_THRESHOLD_PERCENT = 80;

function rateLimitWindows(snapshot: unknown): UnknownRecord[] {
  if (!isRecord(snapshot)) return [];
  return [snapshot["primary"], snapshot["secondary"]].filter(isRecord);
}

function windowResetMs(window: UnknownRecord): number | undefined {
  const resetsAt = window["resetsAt"];
  return typeof resetsAt === "number" ? resetsAt * 1_000 : undefined;
}

function windowUsedPercent(window: UnknownRecord): number {
  const used = window["usedPercent"];
  return typeof used === "number" ? used : 0;
}

/**
 * Epoch ms when every exhausted window of a `RateLimitSnapshot` has reset
 * (`resetsAt` is unix seconds). Undefined when no window reports exhaustion.
 */
export function rateLimitRetryAt(snapshot: unknown, now = Date.now()): number | undefined {
  const resets = rateLimitWindows(snapshot)
    .filter((window) => windowUsedPercent(window) >= 100)
    .map(windowResetMs)
    .filter((ms): ms is number => ms !== undefined && ms > now);
  return resets.length > 0 ? Math.max(...resets) : undefined;
}

function formatResetTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function codexUsageLimitMessage(retryAt: number | undefined): string {
  return retryAt === undefined
    ? "Codex usage limit reached. Try again later, or switch this chat to another runtime."
    : `Codex usage limit reached. It resets ${formatResetTime(retryAt)}.`;
}

function windowLabel(window: UnknownRecord): string {
  const minutes = window["windowDurationMins"];
  if (typeof minutes !== "number") return "usage";
  if (minutes === 7 * 24 * 60) return "weekly";
  return minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
}

/** A short status line when the account is close to (or at) a usage limit, else null. */
export function codexRateLimitStatus(snapshot: unknown): string | null {
  const busiest = rateLimitWindows(snapshot).reduce<UnknownRecord | null>(
    (current, window) =>
      current === null || windowUsedPercent(window) > windowUsedPercent(current) ? window : current,
    null,
  );
  if (!busiest || windowUsedPercent(busiest) < RATE_LIMIT_STATUS_THRESHOLD_PERCENT) return null;
  const reset = windowResetMs(busiest);
  return `Codex has used ${Math.min(100, windowUsedPercent(busiest))}% of its ${windowLabel(busiest)} limit${
    reset === undefined ? "" : `; resets ${formatResetTime(reset)}`
  }.`;
}

function timestampFromMs(value: number | null | undefined): string {
  return new Date(value ?? Date.now()).toISOString();
}

function base(context: EventContext = {}): {
  id: string;
  timestamp: string;
  parentId: string | null;
} {
  return {
    id: randomUUID(),
    timestamp: context.timestamp ?? new Date().toISOString(),
    parentId: context.parentId ?? null,
  };
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  return optionalString(value, "message", "error");
}

function statusType(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "unknown";
  return optionalString(value, "type", "status") ?? "unknown";
}

function itemToolName(item: CodexThreadItem): string | null {
  switch (item.type) {
    case "commandExecution":
      return "shell";
    case "fileChange":
      return "apply_patch";
    case "mcpToolCall":
      return optionalString(item, "tool", "item") ?? "mcp";
    case "dynamicToolCall":
      return optionalString(item, "tool", "item") ?? "dynamic_tool";
    case "collabAgentToolCall":
      return optionalString(item, "tool", "item") ?? "collab_agent";
    case "webSearch":
      return "web_search";
    case "imageView":
      return "view_image";
    case "sleep":
      return "sleep";
    case "imageGeneration":
      return "image_generation";
    default:
      return null;
  }
}

function itemArguments(item: CodexThreadItem): unknown {
  switch (item.type) {
    case "commandExecution":
      return {
        command: optionalString(item, "command", "item"),
        cwd: optionalString(item, "cwd", "item"),
        commandActions: item["commandActions"],
      };
    case "fileChange":
      return item["changes"];
    case "mcpToolCall":
    case "dynamicToolCall":
      return item["arguments"];
    default:
      return item;
  }
}

function itemResult(item: CodexThreadItem): unknown {
  switch (item.type) {
    case "commandExecution":
      return item["aggregatedOutput"];
    case "fileChange":
      return item["changes"];
    case "mcpToolCall":
      return item["result"];
    case "dynamicToolCall":
      return item["contentItems"];
    default:
      return item;
  }
}

function itemSucceeded(item: CodexThreadItem): boolean {
  const status = optionalString(item, "status", "item");
  if (item.type === "dynamicToolCall" && typeof item["success"] === "boolean") {
    return item["success"];
  }
  return status === undefined || status === "completed";
}

function itemFailure(item: CodexThreadItem): string | undefined {
  return (
    errorMessage(item["error"]) ??
    (itemSucceeded(item) ? undefined : optionalString(item, "status", "item"))
  );
}

function decodeItemNotification(
  params: unknown,
  method: string,
): {
  item: CodexThreadItem;
  threadId: string;
  turnId: string;
  timestamp: string;
} {
  const record = requireRecord(params, "params", method);
  const itemRecord = requireRecord(record["item"], "params.item", method);
  const item: CodexThreadItem = {
    ...itemRecord,
    type: requireString(itemRecord, "type", "params.item", method),
    id: requireString(itemRecord, "id", "params.item", method),
  };
  const timestampKey = method === "item/started" ? "startedAtMs" : "completedAtMs";
  return {
    item,
    threadId: requireString(record, "threadId", "params", method),
    turnId: requireString(record, "turnId", "params", method),
    timestamp: timestampFromMs(requireNumber(record, timestampKey, "params", method)),
  };
}

export function notificationThreadId(method: string, params: unknown): string | null {
  if (!isRecord(params)) return null;
  const direct = params["threadId"];
  if (typeof direct === "string") return direct;
  if (method === "thread/started" && isRecord(params["thread"])) {
    const nested = params["thread"]["id"];
    return typeof nested === "string" ? nested : null;
  }
  return null;
}

export class CodexEventTranslator {
  private readonly reasoningByTurn = new Map<string, string>();
  private readonly reasoningItemsWithDelta = new Set<string>();
  private readonly items = new Map<string, CodexThreadItem>();
  private readonly itemTurnIds = new Map<string, string>();
  private readonly emittedAssistantItems = new Set<string>();
  // A non-retrying `error` notification is always followed by `turn/completed`
  // status "failed"; the completion is the single place a turn failure is
  // emitted, and this keeps the error detail in case the completion omits it.
  private readonly turnErrors = new Map<string, CodexTurnError>();
  private readonly authRefusedTurns = new Set<string>();
  private readonly usageLimitResets = new Map<string, number>();

  constructor(private readonly model: () => string) {}

  /** Track an item without emitting events (items of a native sub-agent thread). */
  rememberItem(method: "item/started" | "item/completed", params: unknown): void {
    const { item, turnId } = decodeItemNotification(params, method);
    this.items.set(item.id, item);
    this.itemTurnIds.set(item.id, turnId);
  }

  /** Marshal declined an external token refresh during `turnId`; its failure is a sign-in problem. */
  noteAuthRefreshRefused(turnId: string): void {
    this.authRefusedTurns.add(turnId);
  }

  /** When the usage limit that failed `turnId` resets (epoch ms), read before its completion is translated. */
  noteUsageLimitReset(turnId: string, retryAt: number): void {
    this.usageLimitResets.set(turnId, retryAt);
  }

  getItem(itemId: string): CodexThreadItem | undefined {
    return this.items.get(itemId);
  }

  findActiveMcpItem(serverName: string, toolName?: string): CodexThreadItem | undefined {
    const items = [...this.items.values()].reverse();
    return items.find(
      (item) =>
        item.type === "mcpToolCall" &&
        optionalString(item, "server", "item") === serverName &&
        (toolName === undefined || optionalString(item, "tool", "item") === toolName) &&
        optionalString(item, "status", "item") === "inProgress",
    );
  }

  completeTurn(turnId: string): void {
    for (const [itemId, itemTurnId] of this.itemTurnIds) {
      if (itemTurnId !== turnId) continue;
      this.itemTurnIds.delete(itemId);
      this.items.delete(itemId);
      this.reasoningItemsWithDelta.delete(itemId);
      this.emittedAssistantItems.delete(itemId);
    }
    this.reasoningByTurn.delete(turnId);
    this.turnErrors.delete(turnId);
    this.authRefusedTurns.delete(turnId);
    this.usageLimitResets.delete(turnId);
  }

  /** The error that failed `turnId`, from the completion or the preceding `error` notification. */
  failedTurnError(params: unknown): CodexTurnError | undefined {
    if (!isRecord(params) || !isRecord(params["turn"])) return undefined;
    const turn = params["turn"];
    if (turn["status"] !== "failed") return undefined;
    const turnId = typeof turn["id"] === "string" ? turn["id"] : undefined;
    if (turnId && this.authRefusedTurns.has(turnId)) {
      return { message: CODEX_SIGN_IN_REQUIRED_MESSAGE, codexErrorInfo: "unauthorized" };
    }
    const error = isRecord(turn["error"]) ? turn["error"] : undefined;
    const message = error ? optionalString(error, "message", "turn.error") : undefined;
    if (message !== undefined) {
      return { message, codexErrorInfo: error?.["codexErrorInfo"] };
    }
    return turnId ? this.turnErrors.get(turnId) : undefined;
  }

  translate(method: string, params: unknown): RuntimeSessionEvent[] {
    switch (method) {
      case "item/agentMessage/delta":
        return this.translateTextDelta(params, method);
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
      case "item/plan/delta":
        return this.translateReasoningDelta(params, method);
      case "item/started":
        return this.translateItemStarted(params);
      case "item/completed":
        return this.translateItemCompleted(params);
      case "turn/started":
        return this.translateTurnStarted(params);
      case "turn/completed":
        return this.translateTurnCompleted(params);
      case "thread/tokenUsage/updated":
        return this.translateUsage(params);
      case "thread/compacted":
        return [
          {
            ...base({ parentId: this.turnId(params, method) }),
            type: "session.compaction_complete",
            data: {},
          },
        ];
      case "error":
        return this.translateError(params, method);
      case "thread/status/changed":
        return this.translateThreadStatus(params, method);
      case "thread/settings/updated":
        return this.translateThreadSettings(params, method);
      case "model/rerouted":
        return this.translateModelRerouted(params, method);
      case "mcpServer/startupStatus/updated":
        return this.translateMcpStatus(params, method);
      case "mcpServer/oauthLogin/completed":
        return [{ ...base(), type: "mcp.oauth_completed", data: {} }];
      case "warning":
      case "guardianWarning":
      case "configWarning":
      case "deprecationNotice":
        return this.translateWarning(params, method);
      case "thread/closed":
        return [{ ...base(), type: "session.status", data: { status: "closed" } }];
      case "serverRequest/resolved":
      case "item/reasoning/summaryPartAdded":
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
      case "item/fileChange/patchUpdated":
      case "item/mcpToolCall/progress":
        return [];
      default:
        return [
          {
            ...base(),
            type: "runtime.unknown",
            data: { runtimeType: method, payload: params },
          },
        ];
    }
  }

  history(thread: CodexThread): RuntimeSessionEvent[] {
    const events: RuntimeSessionEvent[] = [];
    for (const turn of thread.turns) {
      for (const item of turn.items) {
        const completed = this.completedItemEvents(item, turn.id, turn);
        events.push(...completed);
      }
      if (turn.status === "failed" && turn.error) {
        events.push({
          ...base({
            timestamp: timestampFromMs(
              turn.completedAt === null ? undefined : turn.completedAt * 1_000,
            ),
            parentId: turn.id,
          }),
          type: "session.error",
          data: this.turnErrorData({
            message: turn.error.message,
            codexErrorInfo: turn.error.codexErrorInfo,
          }),
        });
      }
    }
    return events;
  }

  private translateTextDelta(params: unknown, method: string): RuntimeSessionEvent[] {
    const record = requireRecord(params, "params", method);
    const itemId = requireString(record, "itemId", "params", method);
    return [
      {
        ...base({ parentId: requireString(record, "turnId", "params", method) }),
        type: "assistant.message_delta",
        data: {
          messageId: itemId,
          deltaContent: requireString(record, "delta", "params", method),
        },
      },
    ];
  }

  private translateReasoningDelta(params: unknown, method: string): RuntimeSessionEvent[] {
    const record = requireRecord(params, "params", method);
    const turnId = requireString(record, "turnId", "params", method);
    const itemId = requireString(record, "itemId", "params", method);
    const delta = requireString(record, "delta", "params", method);
    this.reasoningItemsWithDelta.add(itemId);
    this.reasoningByTurn.set(turnId, `${this.reasoningByTurn.get(turnId) ?? ""}${delta}`);
    return [
      {
        ...base({ parentId: turnId }),
        type: "assistant.reasoning_delta",
        data: { reasoningId: itemId, deltaContent: delta },
      },
    ];
  }

  private translateItemStarted(params: unknown): RuntimeSessionEvent[] {
    const method = "item/started";
    const { item, turnId, timestamp } = decodeItemNotification(params, method);
    this.items.set(item.id, item);
    this.itemTurnIds.set(item.id, turnId);
    const toolName = itemToolName(item);
    if (!toolName) return [];
    return [
      {
        ...base({ timestamp, parentId: turnId }),
        type: "tool.execution_start",
        data: {
          toolName,
          toolCallId: item.id,
          arguments: itemArguments(item),
          ...(item.type === "mcpToolCall"
            ? {
                mcpServerName: optionalString(item, "server", "item"),
                mcpToolName: optionalString(item, "tool", "item"),
              }
            : {}),
          ...(item.type === "commandExecution" ? { shellToolInfo: item } : {}),
        },
      },
    ];
  }

  private translateItemCompleted(params: unknown): RuntimeSessionEvent[] {
    const method = "item/completed";
    const { item, turnId, timestamp } = decodeItemNotification(params, method);
    this.items.set(item.id, item);
    this.itemTurnIds.set(item.id, turnId);
    const events = this.completedItemEvents(item, turnId, undefined, timestamp);
    this.reasoningItemsWithDelta.delete(item.id);
    return events;
  }

  private completedItemEvents(
    item: CodexThreadItem,
    turnId: string,
    turn?: CodexTurn,
    timestamp?: string,
  ): RuntimeSessionEvent[] {
    const context = {
      timestamp:
        timestamp ??
        timestampFromMs(
          turn?.completedAt === null || turn?.completedAt === undefined
            ? undefined
            : turn.completedAt * 1_000,
        ),
      parentId: turnId,
    };
    if (item.type === "agentMessage" || item.type === "exitedReviewMode") {
      this.emittedAssistantItems.add(item.id);
      return [
        {
          ...base(context),
          type: "assistant.message",
          data: {
            messageId: item.id,
            content:
              item.type === "agentMessage"
                ? (optionalString(item, "text", "item") ?? "")
                : (optionalString(item, "review", "item") ?? ""),
            ...(this.reasoningByTurn.get(turnId)
              ? { reasoningText: this.reasoningByTurn.get(turnId) }
              : {}),
          },
        },
      ];
    }
    if (
      (item.type === "reasoning" || item.type === "plan") &&
      !this.reasoningItemsWithDelta.has(item.id)
    ) {
      const text =
        item.type === "plan"
          ? (optionalString(item, "text", "item") ?? "")
          : this.reasoningItemText(item);
      if (!text) return [];
      this.reasoningByTurn.set(turnId, `${this.reasoningByTurn.get(turnId) ?? ""}${text}`);
      return [
        {
          ...base(context),
          type: "assistant.reasoning_delta",
          data: { reasoningId: item.id, deltaContent: text },
        },
      ];
    }
    if (item.type === "contextCompaction") {
      return [{ ...base(context), type: "session.compaction_complete", data: {} }];
    }
    const toolName = itemToolName(item);
    if (!toolName) return [];
    const success = itemSucceeded(item);
    return [
      {
        ...base(context),
        type: "tool.execution_complete",
        data: {
          toolCallId: item.id,
          success,
          result: itemResult(item),
          ...(success ? {} : { error: itemFailure(item) ?? "Tool execution failed" }),
        },
      },
    ];
  }

  private translateTurnStarted(params: unknown): RuntimeSessionEvent[] {
    const method = "turn/started";
    const record = requireRecord(params, "params", method);
    const turn = requireRecord(record["turn"], "params.turn", method);
    requireString(turn, "id", "params.turn", method);
    // SessionView.status already represents turn activity; "running" adds a duplicate banner.
    return [];
  }

  private translateTurnCompleted(params: unknown): RuntimeSessionEvent[] {
    const method = "turn/completed";
    const record = requireRecord(params, "params", method);
    const turnRecord = requireRecord(record["turn"], "params.turn", method);
    const turnId = requireString(turnRecord, "id", "params.turn", method);
    const status = requireString(turnRecord, "status", "params.turn", method);
    const completedAt = nullableNumber(turnRecord, "completedAt", "params.turn", method);
    const context = {
      timestamp: timestampFromMs(completedAt === null ? undefined : completedAt * 1_000),
      parentId: turnId,
    };
    const events: RuntimeSessionEvent[] = [];
    const items = requireArray(turnRecord, "items", "params.turn", method);
    for (const rawItem of items) {
      const itemRecord = requireRecord(rawItem, "params.turn.items[]", method);
      const item: CodexThreadItem = {
        ...itemRecord,
        type: requireString(itemRecord, "type", "params.turn.items[]", method),
        id: requireString(itemRecord, "id", "params.turn.items[]", method),
      };
      if (item.type === "agentMessage" && !this.emittedAssistantItems.has(item.id)) {
        events.push(...this.completedItemEvents(item, turnId, undefined, context.timestamp));
      }
    }
    if (status === "failed") {
      const failure = this.failedTurnError(record);
      events.push({
        ...base(context),
        type: "session.error",
        data: failure
          ? this.turnErrorData(failure, this.usageLimitResets.get(turnId))
          : { errorType: "turn-failed" },
      });
    } else if (status === "interrupted") {
      events.push({ ...base(context), type: "abort", data: {} });
    }
    events.push({ ...base(context), type: "session.status", data: { status } });
    events.push({ ...base(context), type: "session.idle", data: {} });
    this.reasoningByTurn.delete(turnId);
    this.turnErrors.delete(turnId);
    this.authRefusedTurns.delete(turnId);
    this.usageLimitResets.delete(turnId);
    return events;
  }

  private translateUsage(params: unknown): RuntimeSessionEvent[] {
    const method = "thread/tokenUsage/updated";
    const record = requireRecord(params, "params", method);
    const turnId = requireString(record, "turnId", "params", method);
    const usage = requireRecord(record["tokenUsage"], "params.tokenUsage", method);
    const last = requireRecord(usage["last"], "params.tokenUsage.last", method);
    const events: RuntimeSessionEvent[] = [
      {
        ...base({ parentId: turnId }),
        type: "assistant.usage",
        data: {
          model: this.model(),
          inputTokens: requireNumber(last, "inputTokens", "params.tokenUsage.last", method),
          outputTokens: requireNumber(last, "outputTokens", "params.tokenUsage.last", method),
          cacheReadTokens: requireNumber(
            last,
            "cachedInputTokens",
            "params.tokenUsage.last",
            method,
          ),
          cacheWriteTokens: requireNumber(
            last,
            "cacheWriteInputTokens",
            "params.tokenUsage.last",
            method,
          ),
          reasoningTokens: requireNumber(
            last,
            "reasoningOutputTokens",
            "params.tokenUsage.last",
            method,
          ),
        },
      },
    ];
    const contextWindow = nullableNumber(usage, "modelContextWindow", "params.tokenUsage", method);
    if (contextWindow !== null) {
      events.push({
        ...base({ parentId: turnId }),
        type: "session.usage_info",
        data: {
          // `last` is the latest request's whole context; `total` is the thread's
          // cumulative spend across every request and outgrows the window.
          currentTokens: requireNumber(last, "totalTokens", "params.tokenUsage.last", method),
          tokenLimit: contextWindow,
        },
      });
    }
    return events;
  }

  private translateError(params: unknown, method: string): RuntimeSessionEvent[] {
    const record = requireRecord(params, "params", method);
    const error = requireRecord(record["error"], "params.error", method);
    const message = requireString(error, "message", "params.error", method);
    const turnId = requireString(record, "turnId", "params", method);
    if (record["willRetry"] === true) {
      return [
        {
          ...base({ parentId: turnId }),
          type: "session.status",
          data: { status: "retrying", message },
        },
      ];
    }
    // Terminal: `turn/completed` (status "failed") follows and reports it once.
    this.turnErrors.set(turnId, { message, codexErrorInfo: error["codexErrorInfo"] });
    return [];
  }

  turnErrorData(
    failure: CodexTurnError,
    retryAt?: number,
  ): { message: string; errorType?: string; retryAt?: number } {
    if (isCodexUsageLimit(failure.codexErrorInfo)) {
      return {
        message: codexUsageLimitMessage(retryAt),
        errorType: USAGE_LIMIT_ERROR_CODE,
        ...(retryAt !== undefined ? { retryAt } : {}),
      };
    }
    if (isCodexAuthFailure(failure.codexErrorInfo)) {
      return { message: CODEX_SIGN_IN_REQUIRED_MESSAGE, errorType: AUTH_REQUIRED_ERROR_CODE };
    }
    const errorType = this.codexErrorType(failure.codexErrorInfo);
    return { message: failure.message, ...(errorType ? { errorType } : {}) };
  }

  private translateThreadStatus(params: unknown, method: string): RuntimeSessionEvent[] {
    const record = requireRecord(params, "params", method);
    const status = statusType(record["status"]);
    return [{ ...base(), type: "session.status", data: { status } }];
  }

  private translateThreadSettings(params: unknown, method: string): RuntimeSessionEvent[] {
    const record = requireRecord(params, "params", method);
    const settings = requireRecord(record["threadSettings"], "params.threadSettings", method);
    const model = optionalString(settings, "model", "params.threadSettings", method);
    if (!model) return [];
    return [
      { ...base(), type: "session.model_change", data: { newModel: model } },
      { ...base(), type: "session.metadata_updated", data: { newModel: model } },
    ];
  }

  private translateModelRerouted(params: unknown, method: string): RuntimeSessionEvent[] {
    const record = requireRecord(params, "params", method);
    const newModel = requireString(record, "toModel", "params", method);
    return [
      { ...base(), type: "session.model_change", data: { newModel } },
      { ...base(), type: "session.metadata_updated", data: { newModel } },
    ];
  }

  private translateMcpStatus(params: unknown, method: string): RuntimeSessionEvent[] {
    const record = requireRecord(params, "params", method);
    const serverName = requireString(record, "name", "params", method);
    const rawStatus = requireString(record, "status", "params", method);
    const failureReason = nullableString(record, "failureReason", "params", method);
    const status =
      rawStatus === "ready"
        ? "connected"
        : rawStatus === "starting"
          ? "pending"
          : rawStatus === "cancelled"
            ? "disabled"
            : failureReason === "reauthenticationRequired"
              ? "needs-auth"
              : "failed";
    const events: RuntimeSessionEvent[] = [
      {
        ...base(),
        type: "session.mcp_server_status_changed",
        data: {
          serverName,
          status,
          error: nullableString(record, "error", "params", method) ?? undefined,
        },
      },
    ];
    if (status === "needs-auth") {
      events.push({
        ...base(),
        type: "mcp.oauth_required",
        data: { serverName },
      });
    }
    return events;
  }

  private translateWarning(params: unknown, method: string): RuntimeSessionEvent[] {
    const record = requireRecord(params, "params", method);
    const message =
      optionalString(record, "message", "params", method) ??
      optionalString(record, "summary", "params", method);
    return [
      {
        ...base(),
        type: "session.status",
        data: { status: "warning", message: message ?? method },
      },
    ];
  }

  private turnId(params: unknown, method: string): string {
    const record = requireRecord(params, "params", method);
    return requireString(record, "turnId", "params", method);
  }

  private codexErrorType(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (!isRecord(value)) return undefined;
    return optionalString(value, "type", "codexErrorInfo") ?? Object.keys(value)[0];
  }

  private reasoningItemText(item: CodexThreadItem): string {
    const sections: string[] = [];
    for (const key of ["summary", "content"]) {
      const value = item[key];
      if (!Array.isArray(value)) continue;
      for (const part of value) {
        if (typeof part === "string") sections.push(part);
      }
    }
    return sections.join("\n");
  }
}
