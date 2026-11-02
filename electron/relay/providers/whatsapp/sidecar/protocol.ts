import { deserialize, serialize } from "node:v8";

export const WHATSAPP_SIDECAR_SCHEMA_VERSION = 1 as const;
export const WHATSAPP_SIDECAR_FRAME_PREFIX = "marshal-whatsapp-v1:";
export const WHATSAPP_SIDECAR_BUNDLE_NAME = "whatsapp-sidecar.mjs";
export const WHATSAPP_SIDECAR_RESOURCE_DIR = "whatsapp-sidecar";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_SERIALIZED_VALUE_BYTES = 6 * 1024 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 512;
const MAX_QR_LENGTH = 16 * 1024;
const MAX_IDENTIFIER_LENGTH = 4096;
const MAX_MESSAGE_TEXT_LENGTH = 64 * 1024;
const MAX_INTERACTION_OPTIONS = 12;
const MAX_INTERACTION_LABEL_LENGTH = 256;
const MAX_INTERACTION_DESCRIPTION_LENGTH = 1024;
const MAX_MEDIA_ATTACHMENTS = 4;
const MAX_MEDIA_PATH_LENGTH = 4096;
const MAX_SIGNAL_KEY_IDS = 16_384;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,96}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type WhatsAppSidecarCommand = "start" | "stop" | "reset" | "provision" | "shutdown";

export type WhatsAppAuthStoreErrorCode =
  | "INVALID_CONFIGURATION"
  | "SQLITE_UNAVAILABLE"
  | "IO_FAILURE"
  | "SCHEMA_MISMATCH"
  | "WRONG_KEY"
  | "CORRUPT_STORE"
  | "TRANSACTION_FAILED"
  | "STORE_CLOSED"
  | "UNKNOWN";

export type WhatsAppSidecarCommandErrorCode =
  | "INVALID_STATE"
  | "AUTH_STORE_ERROR"
  | "SOCKET_ERROR"
  | "PROTOCOL_ERROR"
  | "INTERNAL_ERROR";

export type WhatsAppDisconnectClassification = "retryable" | "terminal";

export type WhatsAppDisconnectReason =
  | "bad-session"
  | "connection-closed"
  | "connection-lost"
  | "connection-replaced"
  | "forbidden"
  | "logged-out"
  | "multidevice-mismatch"
  | "restart-required"
  | "unavailable-service"
  | "unknown";

export type WhatsAppConnectionStatus =
  | "starting"
  | "connecting"
  | "awaiting-qr"
  | "connected"
  | "reconnecting"
  | "stopped"
  | "requires-reset";

export interface WhatsAppConnectedIdentity {
  id: string;
  phoneNumber?: string;
  displayName?: string;
  username?: string;
}

export type WhatsAppManagedFixedGroupRole =
  | "new-chats"
  | "progress"
  | "information-control";

export type WhatsAppManagedGroupRole = WhatsAppManagedFixedGroupRole | "session";

export type WhatsAppManagedMessageOrigin = "same-account-human";

export interface WhatsAppInboundManagedAttachment {
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly kind: "image" | "audio";
  readonly mimeType: string;
  readonly fileName?: string;
  readonly sizeBytes?: number;
  readonly voiceMemo?: boolean;
  readonly durationMs?: number;
}

export interface WhatsAppDownloadedManagedAttachment
  extends WhatsAppInboundManagedAttachment {
  readonly localPath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface WhatsAppInboundManagedMessage {
  readonly eventVersion: 1;
  readonly providerMessageId: string;
  readonly conversationId: string;
  readonly role: WhatsAppManagedGroupRole;
  readonly senderId: string;
  readonly origin: WhatsAppManagedMessageOrigin;
  readonly sentAt: string;
  readonly receivedAt: string;
  readonly text?: string;
  readonly attachments?: readonly WhatsAppInboundManagedAttachment[];
  readonly replyToProviderMessageId?: string;
}

export interface WhatsAppInteractionOption {
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
}

export interface WhatsAppInteractionSelection {
  readonly interactionId: string;
  readonly providerPromptMessageId: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly selectedOptionIds: readonly string[];
  readonly selectedAt: string;
}

export type WhatsAppConnectionEvent =
  | {
      type: "status";
      status: WhatsAppConnectionStatus;
      attempt: number;
    }
  | {
      type: "setup";
      phase: "qr";
      qr: string;
      sequence: number;
    }
  | {
      type: "setup";
      phase: "complete";
    }
  | {
      type: "connected";
      identity: WhatsAppConnectedIdentity;
    }
  | {
      type: "provisioned";
      provisioning: {
        community: boolean;
        newChats: boolean;
        progress: boolean;
        informationControl: boolean;
      };
    }
  | {
      type: "message";
      message: WhatsAppInboundManagedMessage;
    }
  | {
      type: "interaction-selection";
      selection: WhatsAppInteractionSelection;
    }
  | {
      type: "disconnected";
      classification: WhatsAppDisconnectClassification;
      reason: WhatsAppDisconnectReason;
      statusCode?: number;
      retryInMs?: number;
    }
  | {
      type: "error";
      code:
        | "AUTH_PERSISTENCE_FAILED"
        | "MESSAGE_PROCESSING_FAILED"
        | "PROVISIONING_FAILED"
        | "SIDECAR_FAILED"
        | "SOCKET_START_FAILED";
      message: string;
    };

export type WhatsAppAuthStoreValue = object | string | number | boolean | bigint;

export interface SerializedWhatsAppAuthValue {
  encoding: "v8-base64";
  data: string;
}

export interface SerializedWhatsAppAuthStoreUpdate {
  credentials?: SerializedWhatsAppAuthValue | null;
  signalKeys?: Record<string, Record<string, SerializedWhatsAppAuthValue | null>>;
}

export type WhatsAppSidecarAuthRequest =
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "auth-request";
      requestId: string;
      operation: "read-credentials";
    }
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "auth-request";
      requestId: string;
      operation: "read-signal-keys";
      category: string;
      ids: string[];
    }
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "auth-request";
      requestId: string;
      operation: "apply-transaction";
      update: SerializedWhatsAppAuthStoreUpdate;
    }
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "auth-request";
      requestId: string;
      operation: "reset";
    };

export type WhatsAppSidecarAuthResponse =
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "auth-response";
      requestId: string;
      operation: "read-credentials";
      ok: true;
      credentials: SerializedWhatsAppAuthValue | null;
    }
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "auth-response";
      requestId: string;
      operation: "read-signal-keys";
      ok: true;
      values: Record<string, SerializedWhatsAppAuthValue>;
    }
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "auth-response";
      requestId: string;
      operation: "apply-transaction" | "reset";
      ok: true;
    }
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "auth-response";
      requestId: string;
      operation: WhatsAppSidecarAuthRequest["operation"];
      ok: false;
      error: {
        code: WhatsAppAuthStoreErrorCode;
        message: string;
      };
    };

export type WhatsAppSidecarRequest =
  | {
      type: "send-text";
      conversationId: string;
      text: string;
    }
  | {
      type: "ensure-session-group";
      idempotencyKey: string;
      displayName: string;
      communityConversationId: string;
      existingConversationId?: string;
    }
  | {
      type: "retire-session-group";
      conversationId: string;
      communityConversationId: string;
    }
  | {
      type: "send-interaction";
      interactionId: string;
      idempotencyKey: string;
      conversationId: string;
      sourceSessionId: string;
      sourceTurnId?: string;
      sourceRequestId?: string;
      correlationId: string;
      kind: "permission" | "choice";
      title: string;
      question: string;
      body?: string;
      options: WhatsAppInteractionOption[];
      minSelections: number;
      maxSelections: number;
      createdAt: string;
      expiresAt: string;
    }
  | {
      type: "download-media";
      sourceId: string;
      authorizationToken: string;
    }
  | {
      type: "release-media";
      sourceId: string;
    }
  | {
      type: "cancel-interaction";
      interactionId: string;
      providerMessageId: string;
      conversationId: string;
    };

export type WhatsAppSidecarRequestResponse =
  | {
      type: "send-text";
      providerMessageId: string;
      sentAt: string;
    }
  | {
      type: "ensure-session-group";
      conversationId: string;
      displayName: string;
      communityConversationId: string;
      disposition: "created" | "existing" | "reopened";
    }
  | {
      type: "retire-session-group";
      conversationId: string;
      unlinked: boolean;
      left: boolean;
    }
  | {
      type: "send-interaction";
      interactionId: string;
      providerMessageId: string;
      sentAt: string;
    }
  | {
      type: "download-media";
      attachment: WhatsAppDownloadedManagedAttachment;
    }
  | {
      type: "release-media";
      sourceId: string;
      released: true;
    }
  | {
      type: "cancel-interaction";
      interactionId: string;
      providerMessageId: string;
      cancelled: true;
    };

export type WhatsAppSidecarParentFrame =
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "command";
      requestId: string;
      command: WhatsAppSidecarCommand;
    }
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "request";
      requestId: string;
      request: WhatsAppSidecarRequest;
    }
  | WhatsAppSidecarAuthResponse;

export type WhatsAppSidecarChildFrame =
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "ready";
      capabilities: {
        packageName: "baileys";
        packageVersion: "7.0.0-rc14";
        autoConnect: false;
        authPersistence: "parent-rpc";
      };
    }
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "command-result";
      requestId: string;
      command: WhatsAppSidecarCommand;
      ok: true;
    }
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "command-result";
      requestId: string;
      command: WhatsAppSidecarCommand;
      ok: false;
      error: {
        code: WhatsAppSidecarCommandErrorCode;
        message: string;
      };
    }
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "request-result";
      requestId: string;
      requestType: WhatsAppSidecarRequest["type"];
      ok: true;
      response: WhatsAppSidecarRequestResponse;
    }
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "request-result";
      requestId: string;
      requestType: WhatsAppSidecarRequest["type"];
      ok: false;
      error: {
        code: WhatsAppSidecarCommandErrorCode;
        message: string;
      };
    }
  | WhatsAppSidecarAuthRequest
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "event";
      event: WhatsAppConnectionEvent;
    }
  | {
      schemaVersion: typeof WHATSAPP_SIDECAR_SCHEMA_VERSION;
      kind: "fatal";
      code: "PROTOCOL_ERROR" | "INTERNAL_ERROR";
      message: string;
    };

type JsonRecord = Record<string, unknown>;

export function encodeWhatsAppAuthValue(
  value: WhatsAppAuthStoreValue,
): SerializedWhatsAppAuthValue {
  if (!isAuthStoreValue(value)) {
    throw new Error("WhatsApp auth-store values must not be null or undefined");
  }
  const bytes = serialize(value);
  try {
    if (bytes.byteLength > MAX_SERIALIZED_VALUE_BYTES) {
      throw new Error(
        `WhatsApp auth-store value exceeds ${MAX_SERIALIZED_VALUE_BYTES} serialized bytes`,
      );
    }
    return {
      encoding: "v8-base64",
      data: bytes.toString("base64"),
    };
  } finally {
    bytes.fill(0);
  }
}

export function decodeWhatsAppAuthValue(
  value: SerializedWhatsAppAuthValue,
): WhatsAppAuthStoreValue {
  if (!isSerializedAuthValue(value)) {
    throw new Error("WhatsApp auth-store value has an invalid wire encoding");
  }
  const bytes = Buffer.from(value.data, "base64");
  if (bytes.byteLength > MAX_SERIALIZED_VALUE_BYTES) {
    bytes.fill(0);
    throw new Error(
      `WhatsApp auth-store value exceeds ${MAX_SERIALIZED_VALUE_BYTES} serialized bytes`,
    );
  }

  let decoded: unknown;
  try {
    decoded = deserialize(bytes);
  } catch (error) {
    throw new Error("WhatsApp auth-store value is not valid serialized data", { cause: error });
  }
  if (!isAuthStoreValue(decoded)) {
    throw new Error("WhatsApp auth-store value contains a reserved payload");
  }
  return decoded;
}

export function parseWhatsAppSidecarParentFrame(line: string): WhatsAppSidecarParentFrame {
  const value = parseJsonLine(line);
  if (!isRecord(value) || value.schemaVersion !== WHATSAPP_SIDECAR_SCHEMA_VERSION) {
    throw new Error("WhatsApp sidecar parent frame has an invalid schema version");
  }
  if (!isRequestId(value.requestId)) {
    throw new Error("WhatsApp sidecar parent frame has an invalid requestId");
  }

  if (value.kind === "command") {
    if (
      !hasExactKeys(value, ["command", "kind", "requestId", "schemaVersion"]) ||
      !isCommand(value.command)
    ) {
      throw new Error("WhatsApp sidecar command frame has an invalid shape");
    }
    return {
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "command",
      requestId: value.requestId,
      command: value.command,
    };
  }

  if (value.kind === "request") {
    if (!hasExactKeys(value, ["kind", "request", "requestId", "schemaVersion"])) {
      throw new Error("WhatsApp sidecar request frame has an invalid shape");
    }
    return {
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "request",
      requestId: value.requestId,
      request: parseSidecarRequest(value.request),
    };
  }

  if (value.kind === "auth-response") {
    return parseAuthResponse(value);
  }

  throw new Error(`Unsupported WhatsApp sidecar parent frame kind: ${String(value.kind)}`);
}

export function parseWhatsAppSidecarChildFrame(line: string): WhatsAppSidecarChildFrame {
  const value = parseJsonLine(line);
  if (!isRecord(value) || value.schemaVersion !== WHATSAPP_SIDECAR_SCHEMA_VERSION) {
    throw new Error("WhatsApp sidecar child frame has an invalid schema version");
  }

  if (value.kind === "ready") {
    if (
      !hasExactKeys(value, ["capabilities", "kind", "schemaVersion"]) ||
      !isReadyCapabilities(value.capabilities)
    ) {
      throw new Error("WhatsApp sidecar ready frame has an invalid shape");
    }
    return {
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "ready",
      capabilities: value.capabilities,
    };
  }

  if (value.kind === "command-result") {
    return parseCommandResult(value);
  }

  if (value.kind === "request-result") {
    return parseRequestResult(value);
  }

  if (value.kind === "auth-request") {
    return parseAuthRequest(value);
  }

  if (value.kind === "event") {
    if (!hasExactKeys(value, ["event", "kind", "schemaVersion"])) {
      throw new Error("WhatsApp sidecar event frame has an invalid shape");
    }
    return {
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "event",
      event: parseConnectionEvent(value.event),
    };
  }

  if (value.kind === "fatal") {
    if (
      !hasExactKeys(value, ["code", "kind", "message", "schemaVersion"]) ||
      (value.code !== "PROTOCOL_ERROR" && value.code !== "INTERNAL_ERROR") ||
      !isErrorMessage(value.message)
    ) {
      throw new Error("WhatsApp sidecar fatal frame has an invalid shape");
    }
    return {
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "fatal",
      code: value.code,
      message: value.message,
    };
  }

  throw new Error(`Unsupported WhatsApp sidecar child frame kind: ${String(value.kind)}`);
}

export function serializeWhatsAppSidecarFrame(
  frame: WhatsAppSidecarParentFrame | WhatsAppSidecarChildFrame,
): string {
  const line = `${WHATSAPP_SIDECAR_FRAME_PREFIX}${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    throw new Error(`WhatsApp sidecar frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  return line;
}

function parseCommandResult(value: JsonRecord): Extract<
  WhatsAppSidecarChildFrame,
  {
    kind: "command-result";
  }
> {
  if (!isRequestId(value.requestId) || !isCommand(value.command) || typeof value.ok !== "boolean") {
    throw new Error("WhatsApp sidecar command result has an invalid shape");
  }
  if (value.ok) {
    if (!hasExactKeys(value, ["command", "kind", "ok", "requestId", "schemaVersion"])) {
      throw new Error("WhatsApp sidecar command result has an invalid shape");
    }
    return {
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "command-result",
      requestId: value.requestId,
      command: value.command,
      ok: true,
    };
  }
  if (
    !hasExactKeys(value, ["command", "error", "kind", "ok", "requestId", "schemaVersion"]) ||
    !isCommandError(value.error)
  ) {
    throw new Error("WhatsApp sidecar command error result has an invalid shape");
  }
  return {
    schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
    kind: "command-result",
    requestId: value.requestId,
    command: value.command,
    ok: false,
    error: value.error,
  };
}

function parseRequestResult(
  value: JsonRecord,
): Extract<WhatsAppSidecarChildFrame, { kind: "request-result" }> {
  if (
    !isRequestId(value.requestId) ||
    !isSidecarRequestType(value.requestType) ||
    typeof value.ok !== "boolean"
  ) {
    throw new Error("WhatsApp sidecar request result has an invalid shape");
  }
  if (!value.ok) {
    if (
      !hasExactKeys(value, [
        "error",
        "kind",
        "ok",
        "requestId",
        "requestType",
        "schemaVersion",
      ]) ||
      !isCommandError(value.error)
    ) {
      throw new Error("WhatsApp sidecar request error result has an invalid shape");
    }
    return {
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "request-result",
      requestId: value.requestId,
      requestType: value.requestType,
      ok: false,
      error: value.error,
    };
  }
  if (
    !hasExactKeys(value, [
      "kind",
      "ok",
      "requestId",
      "requestType",
      "response",
      "schemaVersion",
    ])
  ) {
    throw new Error("WhatsApp sidecar request result has an invalid shape");
  }
  const response = parseSidecarRequestResponse(value.response);
  if (response.type !== value.requestType) {
    throw new Error("WhatsApp sidecar request result type does not match its response");
  }
  return {
    schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
    kind: "request-result",
    requestId: value.requestId,
    requestType: value.requestType,
    ok: true,
    response,
  };
}

function parseSidecarRequest(value: unknown): WhatsAppSidecarRequest {
  if (!isRecord(value)) throw new Error("WhatsApp sidecar request has an invalid shape");
  if (value.type === "send-text") {
    if (
      !hasExactKeys(value, ["conversationId", "text", "type"]) ||
      !isIdentifier(value.conversationId) ||
      !isMessageText(value.text)
    ) {
      throw new Error("WhatsApp send-text request has an invalid shape");
    }
    return {
      type: "send-text",
      conversationId: value.conversationId,
      text: value.text,
    };
  }
  if (value.type === "ensure-session-group") {
    const expectedKeys = [
      "communityConversationId",
      "displayName",
      "idempotencyKey",
      "type",
      ...(value.existingConversationId === undefined ? [] : ["existingConversationId"]),
    ];
    if (
      !hasExactKeys(value, expectedKeys) ||
      !isIdentifier(value.idempotencyKey) ||
      !isIdentifier(value.displayName) ||
      !isIdentifier(value.communityConversationId) ||
      (value.existingConversationId !== undefined &&
        !isIdentifier(value.existingConversationId))
    ) {
      throw new Error("WhatsApp ensure-session-group request has an invalid shape");
    }
    return {
      type: "ensure-session-group",
      idempotencyKey: value.idempotencyKey,
      displayName: value.displayName,
      communityConversationId: value.communityConversationId,
      ...(value.existingConversationId === undefined
        ? {}
        : { existingConversationId: value.existingConversationId }),
    };
  }
  if (value.type === "retire-session-group") {
    if (
      !hasExactKeys(value, ["communityConversationId", "conversationId", "type"]) ||
      !isIdentifier(value.conversationId) ||
      !isIdentifier(value.communityConversationId)
    ) {
      throw new Error("WhatsApp retire-session-group request has an invalid shape");
    }
    return {
      type: "retire-session-group",
      conversationId: value.conversationId,
      communityConversationId: value.communityConversationId,
    };
  }
  if (value.type === "send-interaction") {
    const expectedKeys = [
      "conversationId",
      "correlationId",
      "createdAt",
      "expiresAt",
      "idempotencyKey",
      "interactionId",
      "kind",
      "maxSelections",
      "minSelections",
      "options",
      "question",
      "sourceSessionId",
      "title",
      "type",
      ...(value.body === undefined ? [] : ["body"]),
      ...(value.sourceRequestId === undefined ? [] : ["sourceRequestId"]),
      ...(value.sourceTurnId === undefined ? [] : ["sourceTurnId"]),
    ];
    const options = parseInteractionOptions(value.options);
    if (
      !hasExactKeys(value, expectedKeys) ||
      !isIdentifier(value.interactionId) ||
      !isIdentifier(value.idempotencyKey) ||
      !isIdentifier(value.conversationId) ||
      !isIdentifier(value.sourceSessionId) ||
      (value.sourceTurnId !== undefined && !isIdentifier(value.sourceTurnId)) ||
      (value.sourceRequestId !== undefined && !isIdentifier(value.sourceRequestId)) ||
      !isIdentifier(value.correlationId) ||
      !isInteractionKind(value.kind) ||
      !isInteractionText(value.title, MAX_INTERACTION_LABEL_LENGTH) ||
      !isInteractionText(value.question, MAX_INTERACTION_DESCRIPTION_LENGTH) ||
      (value.body !== undefined &&
        !isInteractionText(value.body, MAX_INTERACTION_DESCRIPTION_LENGTH)) ||
      !isPositiveInteger(value.minSelections) ||
      !isPositiveInteger(value.maxSelections) ||
      value.minSelections > value.maxSelections ||
      value.maxSelections > options.length ||
      !isTimestamp(value.createdAt) ||
      !isTimestamp(value.expiresAt) ||
      Date.parse(value.expiresAt) <= Date.parse(value.createdAt)
    ) {
      throw new Error("WhatsApp send-interaction request has an invalid shape");
    }
    return {
      type: "send-interaction",
      interactionId: value.interactionId,
      idempotencyKey: value.idempotencyKey,
      conversationId: value.conversationId,
      sourceSessionId: value.sourceSessionId,
      ...(value.sourceTurnId === undefined ? {} : { sourceTurnId: value.sourceTurnId }),
      ...(value.sourceRequestId === undefined
        ? {}
        : { sourceRequestId: value.sourceRequestId }),
      correlationId: value.correlationId,
      kind: value.kind,
      title: value.title,
      question: value.question,
      ...(value.body === undefined ? {} : { body: value.body }),
      options,
      minSelections: value.minSelections,
      maxSelections: value.maxSelections,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
    };
  }
  if (value.type === "download-media") {
    if (
      !hasExactKeys(value, ["authorizationToken", "sourceId", "type"]) ||
      !isIdentifier(value.sourceId) ||
      !isIdentifier(value.authorizationToken)
    ) {
      throw new Error("WhatsApp download-media request has an invalid shape");
    }
    return {
      type: "download-media",
      sourceId: value.sourceId,
      authorizationToken: value.authorizationToken,
    };
  }
  if (value.type === "release-media") {
    if (
      !hasExactKeys(value, ["sourceId", "type"]) ||
      !isIdentifier(value.sourceId)
    ) {
      throw new Error("WhatsApp release-media request has an invalid shape");
    }
    return { type: "release-media", sourceId: value.sourceId };
  }
  if (value.type === "cancel-interaction") {
    if (
      !hasExactKeys(value, [
        "conversationId",
        "interactionId",
        "providerMessageId",
        "type",
      ]) ||
      !isIdentifier(value.interactionId) ||
      !isIdentifier(value.providerMessageId) ||
      !isIdentifier(value.conversationId)
    ) {
      throw new Error("WhatsApp cancel-interaction request has an invalid shape");
    }
    return {
      type: "cancel-interaction",
      interactionId: value.interactionId,
      providerMessageId: value.providerMessageId,
      conversationId: value.conversationId,
    };
  }
  throw new Error(`Unsupported WhatsApp sidecar request type: ${String(value.type)}`);
}

function parseSidecarRequestResponse(value: unknown): WhatsAppSidecarRequestResponse {
  if (!isRecord(value)) {
    throw new Error("WhatsApp sidecar request response has an invalid shape");
  }
  if (value.type === "send-text") {
    if (
      !hasExactKeys(value, ["providerMessageId", "sentAt", "type"]) ||
      !isIdentifier(value.providerMessageId) ||
      !isTimestamp(value.sentAt)
    ) {
      throw new Error("WhatsApp send-text response has an invalid shape");
    }
    return {
      type: "send-text",
      providerMessageId: value.providerMessageId,
      sentAt: value.sentAt,
    };
  }
  if (value.type === "ensure-session-group") {
    if (
      !hasExactKeys(value, [
        "communityConversationId",
        "conversationId",
        "displayName",
        "disposition",
        "type",
      ]) ||
      !isIdentifier(value.conversationId) ||
      !isIdentifier(value.displayName) ||
      !isIdentifier(value.communityConversationId) ||
      (value.disposition !== "created" &&
        value.disposition !== "existing" &&
        value.disposition !== "reopened")
    ) {
      throw new Error("WhatsApp ensure-session-group response has an invalid shape");
    }
    return {
      type: "ensure-session-group",
      conversationId: value.conversationId,
      displayName: value.displayName,
      communityConversationId: value.communityConversationId,
      disposition: value.disposition,
    };
  }
  if (value.type === "retire-session-group") {
    if (
      !hasExactKeys(value, ["conversationId", "left", "type", "unlinked"]) ||
      !isIdentifier(value.conversationId) ||
      typeof value.unlinked !== "boolean" ||
      typeof value.left !== "boolean"
    ) {
      throw new Error("WhatsApp retire-session-group response has an invalid shape");
    }
    return {
      type: "retire-session-group",
      conversationId: value.conversationId,
      unlinked: value.unlinked,
      left: value.left,
    };
  }
  if (value.type === "send-interaction") {
    if (
      !hasExactKeys(value, ["interactionId", "providerMessageId", "sentAt", "type"]) ||
      !isIdentifier(value.interactionId) ||
      !isIdentifier(value.providerMessageId) ||
      !isTimestamp(value.sentAt)
    ) {
      throw new Error("WhatsApp send-interaction response has an invalid shape");
    }
    return {
      type: "send-interaction",
      interactionId: value.interactionId,
      providerMessageId: value.providerMessageId,
      sentAt: value.sentAt,
    };
  }
  if (value.type === "download-media") {
    if (
      !hasExactKeys(value, ["attachment", "type"]) ||
      !isDownloadedManagedAttachment(value.attachment)
    ) {
      throw new Error("WhatsApp download-media response has an invalid shape");
    }
    return {
      type: "download-media",
      attachment: value.attachment,
    };
  }
  if (value.type === "release-media") {
    if (
      !hasExactKeys(value, ["released", "sourceId", "type"]) ||
      !isIdentifier(value.sourceId) ||
      value.released !== true
    ) {
      throw new Error("WhatsApp release-media response has an invalid shape");
    }
    return { type: "release-media", sourceId: value.sourceId, released: true };
  }
  if (value.type === "cancel-interaction") {
    if (
      !hasExactKeys(value, [
        "cancelled",
        "interactionId",
        "providerMessageId",
        "type",
      ]) ||
      !isIdentifier(value.interactionId) ||
      !isIdentifier(value.providerMessageId) ||
      value.cancelled !== true
    ) {
      throw new Error("WhatsApp cancel-interaction response has an invalid shape");
    }
    return {
      type: "cancel-interaction",
      interactionId: value.interactionId,
      providerMessageId: value.providerMessageId,
      cancelled: true,
    };
  }
  throw new Error(`Unsupported WhatsApp sidecar response type: ${String(value.type)}`);
}

function parseAuthRequest(value: JsonRecord): WhatsAppSidecarAuthRequest {
  if (!isRequestId(value.requestId)) {
    throw new Error("WhatsApp sidecar auth request has an invalid requestId");
  }
  if (value.operation === "read-credentials" || value.operation === "reset") {
    if (!hasExactKeys(value, ["kind", "operation", "requestId", "schemaVersion"])) {
      throw new Error("WhatsApp sidecar auth request has an invalid shape");
    }
    return {
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "auth-request",
      requestId: value.requestId,
      operation: value.operation,
    };
  }
  if (value.operation === "read-signal-keys") {
    if (
      !hasExactKeys(value, [
        "category",
        "ids",
        "kind",
        "operation",
        "requestId",
        "schemaVersion",
      ]) ||
      !isIdentifier(value.category) ||
      !isIdentifierArray(value.ids)
    ) {
      throw new Error("WhatsApp sidecar Signal-key read request has an invalid shape");
    }
    return {
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "auth-request",
      requestId: value.requestId,
      operation: "read-signal-keys",
      category: value.category,
      ids: value.ids,
    };
  }
  if (value.operation === "apply-transaction") {
    if (
      !hasExactKeys(value, ["kind", "operation", "requestId", "schemaVersion", "update"]) ||
      !isSerializedAuthStoreUpdate(value.update)
    ) {
      throw new Error("WhatsApp sidecar auth transaction request has an invalid shape");
    }
    return {
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "auth-request",
      requestId: value.requestId,
      operation: "apply-transaction",
      update: value.update,
    };
  }
  throw new Error(`Unsupported WhatsApp sidecar auth operation: ${String(value.operation)}`);
}

function parseAuthResponse(value: JsonRecord): WhatsAppSidecarAuthResponse {
  if (
    !isRequestId(value.requestId) ||
    !isAuthOperation(value.operation) ||
    typeof value.ok !== "boolean"
  ) {
    throw new Error("WhatsApp sidecar auth response has an invalid shape");
  }
  if (!value.ok) {
    if (
      !hasExactKeys(value, ["error", "kind", "ok", "operation", "requestId", "schemaVersion"]) ||
      !isAuthError(value.error)
    ) {
      throw new Error("WhatsApp sidecar auth error response has an invalid shape");
    }
    return {
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "auth-response",
      requestId: value.requestId,
      operation: value.operation,
      ok: false,
      error: value.error,
    };
  }
  if (value.operation === "read-credentials") {
    if (
      !hasExactKeys(value, [
        "credentials",
        "kind",
        "ok",
        "operation",
        "requestId",
        "schemaVersion",
      ]) ||
      (value.credentials !== null && !isSerializedAuthValue(value.credentials))
    ) {
      throw new Error("WhatsApp sidecar credentials response has an invalid shape");
    }
    return {
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "auth-response",
      requestId: value.requestId,
      operation: "read-credentials",
      ok: true,
      credentials: value.credentials,
    };
  }
  if (value.operation === "read-signal-keys") {
    if (
      !hasExactKeys(value, ["kind", "ok", "operation", "requestId", "schemaVersion", "values"]) ||
      !isSerializedValueRecord(value.values)
    ) {
      throw new Error("WhatsApp sidecar Signal-key response has an invalid shape");
    }
    return {
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "auth-response",
      requestId: value.requestId,
      operation: "read-signal-keys",
      ok: true,
      values: value.values,
    };
  }
  if (!hasExactKeys(value, ["kind", "ok", "operation", "requestId", "schemaVersion"])) {
    throw new Error("WhatsApp sidecar auth acknowledgement has an invalid shape");
  }
  return {
    schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
    kind: "auth-response",
    requestId: value.requestId,
    operation: value.operation,
    ok: true,
  };
}

function parseConnectionEvent(value: unknown): WhatsAppConnectionEvent {
  if (!isRecord(value)) throw new Error("WhatsApp sidecar event has an invalid shape");
  if (value.type === "status") {
    if (
      !hasExactKeys(value, ["attempt", "status", "type"]) ||
      !isConnectionStatus(value.status) ||
      !isNonNegativeInteger(value.attempt)
    ) {
      throw new Error("WhatsApp sidecar status event has an invalid shape");
    }
    return { type: "status", status: value.status, attempt: value.attempt };
  }
  if (value.type === "setup" && value.phase === "qr") {
    if (
      !hasExactKeys(value, ["phase", "qr", "sequence", "type"]) ||
      typeof value.qr !== "string" ||
      value.qr.length === 0 ||
      value.qr.length > MAX_QR_LENGTH ||
      !isNonNegativeInteger(value.sequence)
    ) {
      throw new Error("WhatsApp sidecar QR setup event has an invalid shape");
    }
    return { type: "setup", phase: "qr", qr: value.qr, sequence: value.sequence };
  }
  if (value.type === "setup" && value.phase === "complete") {
    if (!hasExactKeys(value, ["phase", "type"])) {
      throw new Error("WhatsApp sidecar setup completion event has an invalid shape");
    }
    return { type: "setup", phase: "complete" };
  }
  if (value.type === "connected") {
    if (!hasExactKeys(value, ["identity", "type"]) || !isConnectedIdentity(value.identity)) {
      throw new Error("WhatsApp sidecar connected event has an invalid shape");
    }
    return { type: "connected", identity: value.identity };
  }
  if (value.type === "provisioned") {
    if (
      !hasExactKeys(value, ["provisioning", "type"]) ||
      !isProvisioningStatus(value.provisioning)
    ) {
      throw new Error("WhatsApp sidecar provisioning event has an invalid shape");
    }
    return {
      type: "provisioned",
      provisioning: {
        community: value.provisioning.community,
        newChats: value.provisioning.newChats,
        progress: value.provisioning.progress,
        informationControl: value.provisioning.informationControl,
      },
    };
  }
  if (value.type === "message") {
    if (!hasExactKeys(value, ["message", "type"])) {
      throw new Error("WhatsApp sidecar message event has an invalid shape");
    }
    return {
      type: "message",
      message: parseInboundManagedMessage(value.message),
    };
  }
  if (value.type === "interaction-selection") {
    if (!hasExactKeys(value, ["selection", "type"])) {
      throw new Error("WhatsApp sidecar interaction selection event has an invalid shape");
    }
    return {
      type: "interaction-selection",
      selection: parseInteractionSelection(value.selection),
    };
  }
  if (value.type === "disconnected") {
    if (
      !hasOnlyKeys(value, ["classification", "reason", "retryInMs", "statusCode", "type"]) ||
      !hasRequiredKeys(value, ["classification", "reason", "type"]) ||
      !isDisconnectClassification(value.classification) ||
      !isDisconnectReason(value.reason) ||
      (value.statusCode !== undefined && !isPositiveInteger(value.statusCode)) ||
      (value.retryInMs !== undefined && !isNonNegativeInteger(value.retryInMs)) ||
      (value.classification === "terminal" && value.retryInMs !== undefined) ||
      (value.classification === "retryable" && value.retryInMs === undefined)
    ) {
      throw new Error("WhatsApp sidecar disconnected event has an invalid shape");
    }
    return {
      type: "disconnected",
      classification: value.classification,
      reason: value.reason,
      ...(value.statusCode === undefined ? {} : { statusCode: value.statusCode }),
      ...(value.retryInMs === undefined ? {} : { retryInMs: value.retryInMs }),
    };
  }
  if (value.type === "error") {
    if (
      !hasExactKeys(value, ["code", "message", "type"]) ||
      (value.code !== "AUTH_PERSISTENCE_FAILED" &&
        value.code !== "MESSAGE_PROCESSING_FAILED" &&
        value.code !== "PROVISIONING_FAILED" &&
        value.code !== "SIDECAR_FAILED" &&
        value.code !== "SOCKET_START_FAILED") ||
      !isErrorMessage(value.message)
    ) {
      throw new Error("WhatsApp sidecar error event has an invalid shape");
    }
    return { type: "error", code: value.code, message: value.message };
  }
  throw new Error(`Unsupported WhatsApp sidecar event type: ${String(value.type)}`);
}

function parseInboundManagedMessage(value: unknown): WhatsAppInboundManagedMessage {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "attachments",
      "conversationId",
      "eventVersion",
      "origin",
      "providerMessageId",
      "receivedAt",
      "replyToProviderMessageId",
      "role",
      "senderId",
      "sentAt",
      "text",
    ]) ||
    !hasRequiredKeys(value, [
      "conversationId",
      "eventVersion",
      "origin",
      "providerMessageId",
      "receivedAt",
      "role",
      "senderId",
      "sentAt",
    ]) ||
    value.eventVersion !== 1 ||
    !isIdentifier(value.providerMessageId) ||
    !isIdentifier(value.conversationId) ||
    !isManagedGroupRole(value.role) ||
    !isIdentifier(value.senderId) ||
    !isManagedMessageOrigin(value.origin) ||
    !isTimestamp(value.sentAt) ||
    !isTimestamp(value.receivedAt) ||
    (value.text !== undefined && !isMessageText(value.text)) ||
    (value.attachments !== undefined &&
      (!Array.isArray(value.attachments) ||
        value.attachments.length > MAX_MEDIA_ATTACHMENTS ||
        !value.attachments.every(isInboundManagedAttachment))) ||
    (value.text === undefined &&
      (!Array.isArray(value.attachments) || value.attachments.length === 0)) ||
    (value.replyToProviderMessageId !== undefined &&
      !isIdentifier(value.replyToProviderMessageId))
  ) {
    throw new Error("WhatsApp sidecar managed message has an invalid shape");
  }
  return {
    eventVersion: 1,
    providerMessageId: value.providerMessageId,
    conversationId: value.conversationId,
    role: value.role,
    senderId: value.senderId,
    origin: value.origin,
    sentAt: value.sentAt,
    receivedAt: value.receivedAt,
    ...(value.text === undefined ? {} : { text: value.text }),
    ...(value.attachments === undefined ? {} : { attachments: value.attachments }),
    ...(value.replyToProviderMessageId === undefined
      ? {}
      : { replyToProviderMessageId: value.replyToProviderMessageId }),
  };
}

function parseInteractionSelection(value: unknown): WhatsAppInteractionSelection {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "conversationId",
      "interactionId",
      "providerPromptMessageId",
      "selectedAt",
      "selectedOptionIds",
      "senderId",
    ]) ||
    !isIdentifier(value.interactionId) ||
    !isIdentifier(value.providerPromptMessageId) ||
    !isIdentifier(value.conversationId) ||
    !isIdentifier(value.senderId) ||
    !Array.isArray(value.selectedOptionIds) ||
    value.selectedOptionIds.length === 0 ||
    value.selectedOptionIds.length > MAX_INTERACTION_OPTIONS ||
    value.selectedOptionIds.some((optionId) => !isIdentifier(optionId)) ||
    new Set(value.selectedOptionIds).size !== value.selectedOptionIds.length ||
    !isTimestamp(value.selectedAt)
  ) {
    throw new Error("WhatsApp sidecar interaction selection has an invalid shape");
  }
  return {
    interactionId: value.interactionId,
    providerPromptMessageId: value.providerPromptMessageId,
    conversationId: value.conversationId,
    senderId: value.senderId,
    selectedOptionIds: value.selectedOptionIds,
    selectedAt: value.selectedAt,
  };
}

function isInboundManagedAttachment(
  value: unknown,
): value is WhatsAppInboundManagedAttachment {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "attachmentId",
      "durationMs",
      "fileName",
      "kind",
      "mimeType",
      "sizeBytes",
      "sourceId",
      "voiceMemo",
    ]) &&
    hasRequiredKeys(value, ["attachmentId", "kind", "mimeType", "sourceId"]) &&
    hasValidManagedAttachmentFields(value)
  );
}

function isDownloadedManagedAttachment(
  value: unknown,
): value is WhatsAppDownloadedManagedAttachment {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "attachmentId",
      "durationMs",
      "fileName",
      "kind",
      "localPath",
      "mimeType",
      "sha256",
      "sizeBytes",
      "sourceId",
      "voiceMemo",
    ]) &&
    hasRequiredKeys(value, [
      "attachmentId",
      "kind",
      "localPath",
      "mimeType",
      "sha256",
      "sizeBytes",
      "sourceId",
    ]) &&
    hasValidManagedAttachmentFields(value) &&
    typeof value.localPath === "string" &&
    value.localPath.length > 0 &&
    value.localPath.length <= MAX_MEDIA_PATH_LENGTH &&
    isNonNegativeInteger(value.sizeBytes) &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  );
}

function hasValidManagedAttachmentFields(value: Record<string, unknown>): boolean {
  return (
    isIdentifier(value.attachmentId) &&
    isIdentifier(value.sourceId) &&
    (value.kind === "image" || value.kind === "audio") &&
    isInteractionText(value.mimeType, 255) &&
    (value.fileName === undefined || isInteractionText(value.fileName, 512)) &&
    (value.sizeBytes === undefined || isNonNegativeInteger(value.sizeBytes)) &&
    (value.voiceMemo === undefined || typeof value.voiceMemo === "boolean") &&
    (value.durationMs === undefined || isNonNegativeInteger(value.durationMs))
  );
}

function isProvisioningStatus(value: unknown): value is {
  community: boolean;
  newChats: boolean;
  progress: boolean;
  informationControl: boolean;
} {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["community", "informationControl", "newChats", "progress"]) &&
    typeof value.community === "boolean" &&
    typeof value.newChats === "boolean" &&
    typeof value.progress === "boolean" &&
    typeof value.informationControl === "boolean"
  );
}

function parseJsonLine(line: string): unknown {
  const payload = line.startsWith(WHATSAPP_SIDECAR_FRAME_PREFIX)
    ? line.slice(WHATSAPP_SIDECAR_FRAME_PREFIX.length)
    : line;
  if (Buffer.byteLength(payload, "utf8") > MAX_FRAME_BYTES) {
    throw new Error(`WhatsApp sidecar frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  try {
    return JSON.parse(payload) as unknown;
  } catch (error) {
    throw new Error("WhatsApp sidecar frame is not valid JSON", { cause: error });
  }
}

function isReadyCapabilities(
  value: unknown,
): value is Extract<WhatsAppSidecarChildFrame, { kind: "ready" }>["capabilities"] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["authPersistence", "autoConnect", "packageName", "packageVersion"]) &&
    value.packageName === "baileys" &&
    value.packageVersion === "7.0.0-rc14" &&
    value.autoConnect === false &&
    value.authPersistence === "parent-rpc"
  );
}

function isConnectedIdentity(value: unknown): value is WhatsAppConnectedIdentity {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["displayName", "id", "phoneNumber", "username"]) ||
    !hasRequiredKeys(value, ["id"]) ||
    !isIdentifier(value.id)
  ) {
    return false;
  }
  return (
    isOptionalIdentifier(value.displayName) &&
    isOptionalIdentifier(value.phoneNumber) &&
    isOptionalIdentifier(value.username)
  );
}

function isSerializedAuthStoreUpdate(value: unknown): value is SerializedWhatsAppAuthStoreUpdate {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["credentials", "signalKeys"]) ||
    Object.keys(value).length === 0
  ) {
    return false;
  }
  if (
    Object.hasOwn(value, "credentials") &&
    value.credentials !== null &&
    !isSerializedAuthValue(value.credentials)
  ) {
    return false;
  }
  if (value.signalKeys === undefined) return true;
  if (!isRecord(value.signalKeys)) return false;
  for (const [category, entries] of Object.entries(value.signalKeys)) {
    if (!isIdentifier(category) || !isRecord(entries)) return false;
    for (const [id, entry] of Object.entries(entries)) {
      if (!isIdentifier(id) || (entry !== null && !isSerializedAuthValue(entry))) return false;
    }
  }
  return true;
}

function isSerializedValueRecord(
  value: unknown,
): value is Record<string, SerializedWhatsAppAuthValue> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([id, entry]) => isIdentifier(id) && isSerializedAuthValue(entry),
  );
}

function isSerializedAuthValue(value: unknown): value is SerializedWhatsAppAuthValue {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["data", "encoding"]) ||
    value.encoding !== "v8-base64" ||
    typeof value.data !== "string" ||
    value.data.length === 0 ||
    value.data.length > Math.ceil((MAX_SERIALIZED_VALUE_BYTES * 4) / 3) + 4 ||
    !BASE64_PATTERN.test(value.data)
  ) {
    return false;
  }
  return Buffer.byteLength(value.data, "base64") <= MAX_SERIALIZED_VALUE_BYTES;
}

function isAuthError(
  value: unknown,
): value is Extract<WhatsAppSidecarAuthResponse, { ok: false }>["error"] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["code", "message"]) &&
    isAuthStoreErrorCode(value.code) &&
    isErrorMessage(value.message)
  );
}

function isCommandError(
  value: unknown,
): value is Extract<WhatsAppSidecarChildFrame, { kind: "command-result"; ok: false }>["error"] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["code", "message"]) &&
    isCommandErrorCode(value.code) &&
    isErrorMessage(value.message)
  );
}

function isCommand(value: unknown): value is WhatsAppSidecarCommand {
  return (
    value === "start" ||
    value === "stop" ||
    value === "reset" ||
    value === "provision" ||
    value === "shutdown"
  );
}

function isSidecarRequestType(value: unknown): value is WhatsAppSidecarRequest["type"] {
  return (
    value === "send-text" ||
    value === "ensure-session-group" ||
    value === "retire-session-group" ||
    value === "send-interaction" ||
    value === "download-media" ||
    value === "release-media" ||
    value === "cancel-interaction"
  );
}

function isManagedGroupRole(value: unknown): value is WhatsAppManagedGroupRole {
  return (
    value === "new-chats" ||
    value === "progress" ||
    value === "information-control" ||
    value === "session"
  );
}

function isManagedMessageOrigin(value: unknown): value is WhatsAppManagedMessageOrigin {
  return value === "same-account-human";
}

function parseInteractionOptions(value: unknown): WhatsAppInteractionOption[] {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > MAX_INTERACTION_OPTIONS
  ) {
    throw new Error("WhatsApp interaction options have an invalid shape");
  }
  const optionIds = new Set<string>();
  const labels = new Set<string>();
  return value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ["description", "label", "optionId"]) ||
      !hasRequiredKeys(candidate, ["label", "optionId"]) ||
      !isIdentifier(candidate.optionId) ||
      !isInteractionText(candidate.label, MAX_INTERACTION_LABEL_LENGTH) ||
      (candidate.description !== undefined &&
        !isInteractionText(candidate.description, MAX_INTERACTION_DESCRIPTION_LENGTH)) ||
      optionIds.has(candidate.optionId) ||
      labels.has(candidate.label)
    ) {
      throw new Error("WhatsApp interaction option has an invalid shape");
    }
    optionIds.add(candidate.optionId);
    labels.add(candidate.label);
    return {
      optionId: candidate.optionId,
      label: candidate.label,
      ...(candidate.description === undefined
        ? {}
        : { description: candidate.description }),
    };
  });
}

function isInteractionKind(value: unknown): value is "permission" | "choice" {
  return value === "permission" || value === "choice";
}

function isInteractionText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maxLength
  );
}

function isAuthOperation(value: unknown): value is WhatsAppSidecarAuthRequest["operation"] {
  return (
    value === "read-credentials" ||
    value === "read-signal-keys" ||
    value === "apply-transaction" ||
    value === "reset"
  );
}

function isAuthStoreErrorCode(value: unknown): value is WhatsAppAuthStoreErrorCode {
  return (
    value === "INVALID_CONFIGURATION" ||
    value === "SQLITE_UNAVAILABLE" ||
    value === "IO_FAILURE" ||
    value === "SCHEMA_MISMATCH" ||
    value === "WRONG_KEY" ||
    value === "CORRUPT_STORE" ||
    value === "TRANSACTION_FAILED" ||
    value === "STORE_CLOSED" ||
    value === "UNKNOWN"
  );
}

function isCommandErrorCode(value: unknown): value is WhatsAppSidecarCommandErrorCode {
  return (
    value === "INVALID_STATE" ||
    value === "AUTH_STORE_ERROR" ||
    value === "SOCKET_ERROR" ||
    value === "PROTOCOL_ERROR" ||
    value === "INTERNAL_ERROR"
  );
}

function isConnectionStatus(value: unknown): value is WhatsAppConnectionStatus {
  return (
    value === "starting" ||
    value === "connecting" ||
    value === "awaiting-qr" ||
    value === "connected" ||
    value === "reconnecting" ||
    value === "stopped" ||
    value === "requires-reset"
  );
}

function isDisconnectClassification(value: unknown): value is WhatsAppDisconnectClassification {
  return value === "retryable" || value === "terminal";
}

function isDisconnectReason(value: unknown): value is WhatsAppDisconnectReason {
  return (
    value === "bad-session" ||
    value === "connection-closed" ||
    value === "connection-lost" ||
    value === "connection-replaced" ||
    value === "forbidden" ||
    value === "logged-out" ||
    value === "multidevice-mismatch" ||
    value === "restart-required" ||
    value === "unavailable-service" ||
    value === "unknown"
  );
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_IDENTIFIER_LENGTH
  );
}

function isOptionalIdentifier(value: unknown): value is string | undefined {
  return value === undefined || isIdentifier(value);
}

function isMessageText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_MESSAGE_TEXT_LENGTH
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    Number.isFinite(Date.parse(value))
  );
}

function isIdentifierArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_SIGNAL_KEY_IDS &&
    value.every((entry) => isIdentifier(entry))
  );
}

function isErrorMessage(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ERROR_MESSAGE_LENGTH;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isAuthStoreValue(value: unknown): value is WhatsAppAuthStoreValue {
  return (
    value !== null &&
    (typeof value === "object" ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint")
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function hasOnlyKeys(value: JsonRecord, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function hasRequiredKeys(value: JsonRecord, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}
