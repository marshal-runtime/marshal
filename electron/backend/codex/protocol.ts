/**
 * Narrow protocol projections generated from:
 * @openai/codex 0.162.1
 * codex app-server generate-ts --experimental
 *
 * Source:
 * https://github.com/openai/codex/tree/rust-v0.162.1/codex-rs/app-server-protocol
 */

export const CODEX_PACKAGE_VERSION = "0.162.1";
export const CODEX_PROTOCOL_SOURCE =
  "https://github.com/openai/codex/tree/rust-v0.162.1/codex-rs/app-server-protocol";

export type CodexRequestId = string | number;
export type UnknownRecord = Record<string, unknown>;

export class CodexProtocolError extends Error {
  readonly name = "CodexProtocolError";

  constructor(
    message: string,
    readonly method?: string,
  ) {
    super(method ? `[codex-app-server] ${method}: ${message}` : `[codex-app-server] ${message}`);
  }
}

export class CodexRpcError extends Error {
  readonly name = "CodexRpcError";

  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`[codex-app-server] ${method} failed (${code}): ${message}`);
  }

  get retryable(): boolean {
    return this.code === -32001;
  }
}

export interface CodexRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export type CodexWireMessage =
  | {
      kind: "response";
      id: CodexRequestId;
      result?: unknown;
      error?: CodexRpcErrorBody;
    }
  | {
      kind: "request";
      id: CodexRequestId;
      method: string;
      params: unknown;
    }
  | {
      kind: "notification";
      method: string;
      params: unknown;
    };

export interface CodexInitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface CodexThreadItem extends UnknownRecord {
  type: string;
  id: string;
}

export interface CodexTurnError {
  message: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
}

export interface CodexTurn {
  id: string;
  items: CodexThreadItem[];
  status: string;
  error: CodexTurnError | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface CodexThread {
  path?: string;
  id: string;
  sessionId?: string;
  modelProvider?: string;
  cwd?: string;
  status?: UnknownRecord;
  /** Set when the thread is a native sub-agent spawned by another thread. */
  parentThreadId?: string;
  turns: CodexTurn[];
}

export interface CodexThreadResponse {
  thread: CodexThread;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string | null;
}

export interface CodexTurnStartResponse {
  turn: CodexTurn;
}

export interface CodexReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  defaultReasoningEffort: string;
  inputModalities: string[];
  isDefault: boolean;
}

export interface CodexModelListResponse {
  data: CodexModel[];
  nextCursor: string | null;
}

export type CodexAccount =
  | { type: "apiKey" }
  | { type: "chatgpt"; email: string | null; planType: string }
  | { type: "amazonBedrock"; usesCodexManagedCredentials: boolean };

export interface CodexAccountReadResponse {
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
}

export type CodexAccountLoginResponse =
  | { type: "apiKey" }
  | { type: "chatgpt"; loginId: string; authUrl: string }
  | {
      type: "chatgptDeviceCode";
      loginId: string;
      verificationUrl: string;
      userCode: string;
    }
  | { type: "chatgptAuthTokens" }
  | { type: "amazonBedrock" };

export interface CodexMcpServerStatus extends UnknownRecord {
  name: string;
  authStatus: unknown;
}

export interface CodexMcpStatusListResponse {
  data: CodexMcpServerStatus[];
  nextCursor: string | null;
}

export interface CodexMcpOauthLoginResponse {
  authorizationUrl: string;
}

export type ResultDecoder<T> = (value: unknown) => T;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, label: string, method?: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new CodexProtocolError(`${label} must be an object`, method);
  }
  return value;
}

export function requireString(
  record: UnknownRecord,
  key: string,
  label: string,
  method?: string,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new CodexProtocolError(`${label}.${key} must be a string`, method);
  }
  return value;
}

export function optionalString(
  record: UnknownRecord,
  key: string,
  label: string,
  method?: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new CodexProtocolError(`${label}.${key} must be a string when present`, method);
  }
  return value;
}

export function nullableString(
  record: UnknownRecord,
  key: string,
  label: string,
  method?: string,
): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new CodexProtocolError(`${label}.${key} must be a string or null`, method);
  }
  return value;
}

export function requireNumber(
  record: UnknownRecord,
  key: string,
  label: string,
  method?: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CodexProtocolError(`${label}.${key} must be a finite number`, method);
  }
  return value;
}

export function nullableNumber(
  record: UnknownRecord,
  key: string,
  label: string,
  method?: string,
): number | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CodexProtocolError(`${label}.${key} must be a finite number or null`, method);
  }
  return value;
}

export function requireBoolean(
  record: UnknownRecord,
  key: string,
  label: string,
  method?: string,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new CodexProtocolError(`${label}.${key} must be a boolean`, method);
  }
  return value;
}

export function optionalBoolean(
  record: UnknownRecord,
  key: string,
  label: string,
  method?: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new CodexProtocolError(`${label}.${key} must be a boolean when present`, method);
  }
  return value;
}

export function requireArray(
  record: UnknownRecord,
  key: string,
  label: string,
  method?: string,
): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new CodexProtocolError(`${label}.${key} must be an array`, method);
  }
  return value;
}

export function optionalRecord(
  record: UnknownRecord,
  key: string,
  label: string,
  method?: string,
): UnknownRecord | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  return requireRecord(value, `${label}.${key}`, method);
}

export function requireRequestId(value: unknown, label = "id"): CodexRequestId {
  if (typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))) {
    return value;
  }
  throw new CodexProtocolError(`${label} must be a string or safe integer`);
}

export function decodeWireMessage(value: unknown): CodexWireMessage {
  const record = requireRecord(value, "message");
  const jsonrpc = record["jsonrpc"];
  if (jsonrpc !== undefined && jsonrpc !== "2.0") {
    throw new CodexProtocolError("message.jsonrpc must be omitted or equal to 2.0");
  }

  const method = record["method"];
  if (method !== undefined) {
    if (typeof method !== "string" || method.length === 0) {
      throw new CodexProtocolError("message.method must be a non-empty string");
    }
    const params = record["params"];
    if (Object.hasOwn(record, "id")) {
      return {
        kind: "request",
        id: requireRequestId(record["id"]),
        method,
        params,
      };
    }
    return { kind: "notification", method, params };
  }

  if (!Object.hasOwn(record, "id")) {
    throw new CodexProtocolError("message must contain method or id");
  }
  const id = requireRequestId(record["id"]);
  const hasResult = Object.hasOwn(record, "result");
  const hasError = Object.hasOwn(record, "error") && record["error"] !== null;
  if (hasResult === hasError) {
    throw new CodexProtocolError("response must contain exactly one of result or error");
  }
  if (hasResult) {
    return { kind: "response", id, result: record["result"] };
  }

  const error = requireRecord(record["error"], "response.error");
  const code = requireNumber(error, "code", "response.error");
  if (!Number.isSafeInteger(code)) {
    throw new CodexProtocolError("response.error.code must be a safe integer");
  }
  return {
    kind: "response",
    id,
    error: {
      code,
      message: requireString(error, "message", "response.error"),
      ...(Object.hasOwn(error, "data") ? { data: error["data"] } : {}),
    },
  };
}

export function decodeInitializeResponse(value: unknown): CodexInitializeResponse {
  const method = "initialize";
  const result = requireRecord(value, "result", method);
  return {
    userAgent: requireString(result, "userAgent", "result", method),
    codexHome: requireString(result, "codexHome", "result", method),
    platformFamily: requireString(result, "platformFamily", "result", method),
    platformOs: requireString(result, "platformOs", "result", method),
  };
}

export function decodeThreadItem(value: unknown, method?: string): CodexThreadItem {
  const item = requireRecord(value, "thread item", method);
  return {
    ...item,
    type: requireString(item, "type", "thread item", method),
    id: requireString(item, "id", "thread item", method),
  };
}

export function decodeTurn(value: unknown, method?: string): CodexTurn {
  const turn = requireRecord(value, "turn", method);
  const rawItems = turn["items"];
  const items =
    rawItems === undefined
      ? []
      : Array.isArray(rawItems)
        ? rawItems.map((item) => decodeThreadItem(item, method))
        : (() => {
            throw new CodexProtocolError("turn.items must be an array", method);
          })();
  const errorValue = turn["error"];
  let error: CodexTurnError | null = null;
  if (errorValue !== null && errorValue !== undefined) {
    const errorRecord = requireRecord(errorValue, "turn.error", method);
    error = {
      message: requireString(errorRecord, "message", "turn.error", method),
      ...(Object.hasOwn(errorRecord, "codexErrorInfo")
        ? { codexErrorInfo: errorRecord["codexErrorInfo"] }
        : {}),
      additionalDetails: nullableString(errorRecord, "additionalDetails", "turn.error", method),
    };
  }
  return {
    id: requireString(turn, "id", "turn", method),
    items,
    status: optionalString(turn, "status", "turn", method) ?? "unknown",
    error,
    startedAt: nullableNumber(turn, "startedAt", "turn", method),
    completedAt: nullableNumber(turn, "completedAt", "turn", method),
    durationMs: nullableNumber(turn, "durationMs", "turn", method),
  };
}

export function decodeThread(value: unknown, method?: string): CodexThread {
  const thread = requireRecord(value, "thread", method);
  const rawTurns = thread["turns"];
  const turns =
    rawTurns === undefined
      ? []
      : Array.isArray(rawTurns)
        ? rawTurns.map((turn) => decodeTurn(turn, method))
        : (() => {
            throw new CodexProtocolError("thread.turns must be an array", method);
          })();
  const status = optionalRecord(thread, "status", "thread", method);
  return {
    id: requireString(thread, "id", "thread", method),
    ...(optionalString(thread, "path", "thread", method)
      ? { path: optionalString(thread, "path", "thread", method) }
      : {}),
    turns,
    ...(optionalString(thread, "sessionId", "thread", method) !== undefined
      ? { sessionId: optionalString(thread, "sessionId", "thread", method) }
      : {}),
    ...(optionalString(thread, "modelProvider", "thread", method) !== undefined
      ? { modelProvider: optionalString(thread, "modelProvider", "thread", method) }
      : {}),
    ...(optionalString(thread, "cwd", "thread", method) !== undefined
      ? { cwd: optionalString(thread, "cwd", "thread", method) }
      : {}),
    ...(status ? { status } : {}),
    ...(threadParentId(thread) ? { parentThreadId: threadParentId(thread) } : {}),
  };
}

/** The thread that spawned `thread` as a native sub-agent, if it is one. */
export function threadParentId(thread: UnknownRecord): string | undefined {
  const direct = thread["parentThreadId"];
  if (typeof direct === "string") return direct;
  const source = thread["source"];
  if (!isRecord(source) || !isRecord(source["subAgent"])) return undefined;
  const spawn = source["subAgent"]["thread_spawn"];
  if (!isRecord(spawn)) return undefined;
  const parent = spawn["parent_thread_id"];
  return typeof parent === "string" ? parent : undefined;
}

export function decodeThreadResponseFor(method: string): ResultDecoder<CodexThreadResponse> {
  return (value) => {
    const result = requireRecord(value, "result", method);
    const reasoningEffortValue = result["reasoningEffort"];
    if (
      reasoningEffortValue !== undefined &&
      reasoningEffortValue !== null &&
      typeof reasoningEffortValue !== "string"
    ) {
      throw new CodexProtocolError("result.reasoningEffort must be a string or null", method);
    }
    return {
      thread: decodeThread(result["thread"], method),
      ...(optionalString(result, "model", "result", method) !== undefined
        ? { model: optionalString(result, "model", "result", method) }
        : {}),
      ...(optionalString(result, "modelProvider", "result", method) !== undefined
        ? { modelProvider: optionalString(result, "modelProvider", "result", method) }
        : {}),
      ...(reasoningEffortValue !== undefined ? { reasoningEffort: reasoningEffortValue } : {}),
    };
  };
}

export function decodeTurnStartResponse(value: unknown): CodexTurnStartResponse {
  const method = "turn/start";
  const result = requireRecord(value, "result", method);
  return { turn: decodeTurn(result["turn"], method) };
}

export interface CodexTurnSteerResponse {
  turnId: string;
}

export function decodeTurnSteerResponse(value: unknown): CodexTurnSteerResponse {
  const method = "turn/steer";
  const result = requireRecord(value, "result", method);
  return { turnId: requireString(result, "turnId", "result", method) };
}

export function decodeModelListResponse(value: unknown): CodexModelListResponse {
  const method = "model/list";
  const result = requireRecord(value, "result", method);
  const data = requireArray(result, "data", "result", method).map((entry, index) => {
    const model = requireRecord(entry, `result.data[${index}]`, method);
    const efforts = requireArray(
      model,
      "supportedReasoningEfforts",
      `result.data[${index}]`,
      method,
    ).map((effort, effortIndex) => {
      const option = requireRecord(
        effort,
        `result.data[${index}].supportedReasoningEfforts[${effortIndex}]`,
        method,
      );
      return {
        reasoningEffort: requireString(
          option,
          "reasoningEffort",
          `result.data[${index}].supportedReasoningEfforts[${effortIndex}]`,
          method,
        ),
        description: requireString(
          option,
          "description",
          `result.data[${index}].supportedReasoningEfforts[${effortIndex}]`,
          method,
        ),
      };
    });
    const modalities = requireArray(model, "inputModalities", `result.data[${index}]`, method).map(
      (modality, modalityIndex) => {
        if (typeof modality !== "string") {
          throw new CodexProtocolError(
            `result.data[${index}].inputModalities[${modalityIndex}] must be a string`,
            method,
          );
        }
        return modality;
      },
    );
    return {
      id: requireString(model, "id", `result.data[${index}]`, method),
      model: requireString(model, "model", `result.data[${index}]`, method),
      displayName: requireString(model, "displayName", `result.data[${index}]`, method),
      description: requireString(model, "description", `result.data[${index}]`, method),
      hidden: requireBoolean(model, "hidden", `result.data[${index}]`, method),
      supportedReasoningEfforts: efforts,
      defaultReasoningEffort: requireString(
        model,
        "defaultReasoningEffort",
        `result.data[${index}]`,
        method,
      ),
      inputModalities: modalities,
      isDefault: requireBoolean(model, "isDefault", `result.data[${index}]`, method),
    };
  });
  return {
    data,
    nextCursor: nullableString(result, "nextCursor", "result", method),
  };
}

export function decodeAccountReadResponse(value: unknown): CodexAccountReadResponse {
  const method = "account/read";
  const result = requireRecord(value, "result", method);
  const rawAccount = result["account"];
  let account: CodexAccount | null = null;
  if (rawAccount !== null && rawAccount !== undefined) {
    const accountRecord = requireRecord(rawAccount, "result.account", method);
    const type = requireString(accountRecord, "type", "result.account", method);
    switch (type) {
      case "apiKey":
        account = { type };
        break;
      case "chatgpt":
        account = {
          type,
          email: nullableString(accountRecord, "email", "result.account", method),
          planType: requireString(accountRecord, "planType", "result.account", method),
        };
        break;
      case "amazonBedrock":
        account = {
          type,
          usesCodexManagedCredentials: requireBoolean(
            accountRecord,
            "usesCodexManagedCredentials",
            "result.account",
            method,
          ),
        };
        break;
      default:
        throw new CodexProtocolError(`unsupported account type "${type}"`, method);
    }
  }
  return {
    account,
    requiresOpenaiAuth: requireBoolean(result, "requiresOpenaiAuth", "result", method),
  };
}

export function decodeAccountLoginResponse(value: unknown): CodexAccountLoginResponse {
  const method = "account/login/start";
  const result = requireRecord(value, "result", method);
  const type = requireString(result, "type", "result", method);
  switch (type) {
    case "apiKey":
    case "chatgptAuthTokens":
    case "amazonBedrock":
      return { type };
    case "chatgpt":
      return {
        type,
        loginId: requireString(result, "loginId", "result", method),
        authUrl: requireString(result, "authUrl", "result", method),
      };
    case "chatgptDeviceCode":
      return {
        type,
        loginId: requireString(result, "loginId", "result", method),
        verificationUrl: requireString(result, "verificationUrl", "result", method),
        userCode: requireString(result, "userCode", "result", method),
      };
    default:
      throw new CodexProtocolError(`unsupported login response type "${type}"`, method);
  }
}

export function decodeMcpStatusListResponse(value: unknown): CodexMcpStatusListResponse {
  const method = "mcpServerStatus/list";
  const result = requireRecord(value, "result", method);
  const data = requireArray(result, "data", "result", method).map((entry, index) => {
    const status = requireRecord(entry, `result.data[${index}]`, method);
    if (!Object.hasOwn(status, "authStatus")) {
      throw new CodexProtocolError(`result.data[${index}].authStatus is required`, method);
    }
    return {
      ...status,
      name: requireString(status, "name", `result.data[${index}]`, method),
      authStatus: status["authStatus"],
    };
  });
  return {
    data,
    nextCursor: nullableString(result, "nextCursor", "result", method),
  };
}

export function decodeMcpOauthLoginResponse(value: unknown): CodexMcpOauthLoginResponse {
  const method = "mcpServer/oauth/login";
  const result = requireRecord(value, "result", method);
  return {
    authorizationUrl: requireString(result, "authorizationUrl", "result", method),
  };
}

export function decodeEmptyResponse(value: unknown): Record<string, never> {
  const result = requireRecord(value, "result");
  if (Object.keys(result).length !== 0) {
    throw new CodexProtocolError("result must be an empty object");
  }
  return {};
}

export function decodeUnknownRecordFor(method: string): ResultDecoder<UnknownRecord> {
  return (value) => requireRecord(value, "result", method);
}
