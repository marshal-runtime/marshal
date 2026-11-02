export const BAILEYS_STAGE0_SCHEMA_VERSION = 1 as const;
export const BAILEYS_STAGE0_BUNDLE_NAME = "baileys-stage0-sidecar.mjs";
export const BAILEYS_STAGE0_RESOURCE_DIR = "baileys-stage0";

const MAX_FRAME_BYTES = 64 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export interface BaileysStage0ApiFingerprint {
  packageName: "baileys";
  packageVersion: "7.0.0-rc14";
  packageGitHead: "7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a";
  runtimeExports: string[];
  socketMethods: string[];
  eventKeys: string[];
  authCredentialFields: string[];
  signalDataTypes: string[];
  groupMetadataFields: string[];
  messageFields: string[];
  messageContentKinds: string[];
}

export interface BaileysStage0BridgeFingerprint {
  packageName: "whatsapp-rust-bridge";
  packageVersion: "0.5.4";
  assetMode: "embedded-base64-wasm";
  encodedNodeByteLength: number;
  encodedNodeHexPrefix: string;
}

export interface BaileysStage0Capabilities {
  api: BaileysStage0ApiFingerprint;
  bridge: BaileysStage0BridgeFingerprint;
  safety: {
    socketCreated: false;
    authStateCreated: false;
    credentialsRead: false;
    qrGenerated: false;
    networkAttempted: false;
  };
}

export type BaileysStage0ParentFrame =
  | {
      schemaVersion: typeof BAILEYS_STAGE0_SCHEMA_VERSION;
      kind: "ping";
      requestId: string;
    }
  | {
      schemaVersion: typeof BAILEYS_STAGE0_SCHEMA_VERSION;
      kind: "shutdown";
      requestId: string;
    };

export type BaileysStage0ChildFrame =
  | {
      schemaVersion: typeof BAILEYS_STAGE0_SCHEMA_VERSION;
      kind: "capabilities";
      requestId: string;
      capabilities: BaileysStage0Capabilities;
    }
  | {
      schemaVersion: typeof BAILEYS_STAGE0_SCHEMA_VERSION;
      kind: "shutdown-ack";
      requestId: string;
    }
  | {
      schemaVersion: typeof BAILEYS_STAGE0_SCHEMA_VERSION;
      kind: "error";
      requestId: string;
      code: "PROTOCOL_ERROR" | "INTERNAL_ERROR";
      message: string;
    };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isApiFingerprint(value: unknown): value is BaileysStage0ApiFingerprint {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      "authCredentialFields",
      "eventKeys",
      "groupMetadataFields",
      "messageContentKinds",
      "messageFields",
      "packageGitHead",
      "packageName",
      "packageVersion",
      "runtimeExports",
      "signalDataTypes",
      "socketMethods",
    ])
  ) {
    return false;
  }
  return (
    value.packageName === "baileys" &&
    value.packageVersion === "7.0.0-rc14" &&
    value.packageGitHead === "7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a" &&
    isStringArray(value.runtimeExports) &&
    isStringArray(value.socketMethods) &&
    isStringArray(value.eventKeys) &&
    isStringArray(value.authCredentialFields) &&
    isStringArray(value.signalDataTypes) &&
    isStringArray(value.groupMetadataFields) &&
    isStringArray(value.messageFields) &&
    isStringArray(value.messageContentKinds)
  );
}

function isBridgeFingerprint(value: unknown): value is BaileysStage0BridgeFingerprint {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      "assetMode",
      "encodedNodeByteLength",
      "encodedNodeHexPrefix",
      "packageName",
      "packageVersion",
    ])
  ) {
    return false;
  }
  return (
    value.packageName === "whatsapp-rust-bridge" &&
    value.packageVersion === "0.5.4" &&
    value.assetMode === "embedded-base64-wasm" &&
    Number.isSafeInteger(value.encodedNodeByteLength) &&
    typeof value.encodedNodeByteLength === "number" &&
    value.encodedNodeByteLength > 0 &&
    typeof value.encodedNodeHexPrefix === "string" &&
    /^[0-9a-f]+$/.test(value.encodedNodeHexPrefix)
  );
}

function isCapabilities(value: unknown): value is BaileysStage0Capabilities {
  if (!isRecord(value) || !hasExactKeys(value, ["api", "bridge", "safety"])) return false;
  if (!isRecord(value.safety)) return false;
  if (
    !hasExactKeys(value.safety, [
      "authStateCreated",
      "credentialsRead",
      "networkAttempted",
      "qrGenerated",
      "socketCreated",
    ])
  ) {
    return false;
  }
  return (
    isApiFingerprint(value.api) &&
    isBridgeFingerprint(value.bridge) &&
    value.safety.socketCreated === false &&
    value.safety.authStateCreated === false &&
    value.safety.credentialsRead === false &&
    value.safety.qrGenerated === false &&
    value.safety.networkAttempted === false
  );
}

function parseJsonLine(line: string): unknown {
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    throw new Error(`Baileys Stage 0 frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error("Baileys Stage 0 frame is not valid JSON", { cause: error });
  }
}

export function parseBaileysStage0ParentFrame(line: string): BaileysStage0ParentFrame {
  const value = parseJsonLine(line);
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "requestId", "schemaVersion"])) {
    throw new Error("Baileys Stage 0 parent frame has an invalid shape");
  }
  if (value.schemaVersion !== BAILEYS_STAGE0_SCHEMA_VERSION) {
    throw new Error(`Unsupported Baileys Stage 0 schema version: ${String(value.schemaVersion)}`);
  }
  if (!isRequestId(value.requestId)) {
    throw new Error("Baileys Stage 0 parent frame has an invalid requestId");
  }
  if (value.kind !== "ping" && value.kind !== "shutdown") {
    throw new Error(`Unsupported Baileys Stage 0 parent frame kind: ${String(value.kind)}`);
  }
  return {
    schemaVersion: BAILEYS_STAGE0_SCHEMA_VERSION,
    kind: value.kind,
    requestId: value.requestId,
  };
}

export function parseBaileysStage0ChildFrame(line: string): BaileysStage0ChildFrame {
  const value = parseJsonLine(line);
  if (!isRecord(value) || value.schemaVersion !== BAILEYS_STAGE0_SCHEMA_VERSION) {
    throw new Error("Baileys Stage 0 child frame has an invalid schema version");
  }
  if (!isRequestId(value.requestId)) {
    throw new Error("Baileys Stage 0 child frame has an invalid requestId");
  }

  if (value.kind === "capabilities") {
    if (
      !hasExactKeys(value, ["capabilities", "kind", "requestId", "schemaVersion"]) ||
      !isCapabilities(value.capabilities)
    ) {
      throw new Error("Baileys Stage 0 capabilities frame has an invalid shape");
    }
    return {
      schemaVersion: BAILEYS_STAGE0_SCHEMA_VERSION,
      kind: "capabilities",
      requestId: value.requestId,
      capabilities: value.capabilities,
    };
  }

  if (value.kind === "shutdown-ack") {
    if (!hasExactKeys(value, ["kind", "requestId", "schemaVersion"])) {
      throw new Error("Baileys Stage 0 shutdown acknowledgement has an invalid shape");
    }
    return {
      schemaVersion: BAILEYS_STAGE0_SCHEMA_VERSION,
      kind: "shutdown-ack",
      requestId: value.requestId,
    };
  }

  if (value.kind === "error") {
    if (
      !hasExactKeys(value, ["code", "kind", "message", "requestId", "schemaVersion"]) ||
      (value.code !== "PROTOCOL_ERROR" && value.code !== "INTERNAL_ERROR") ||
      typeof value.message !== "string"
    ) {
      throw new Error("Baileys Stage 0 error frame has an invalid shape");
    }
    return {
      schemaVersion: BAILEYS_STAGE0_SCHEMA_VERSION,
      kind: "error",
      requestId: value.requestId,
      code: value.code,
      message: value.message,
    };
  }

  throw new Error(`Unsupported Baileys Stage 0 child frame kind: ${String(value.kind)}`);
}

export function serializeBaileysStage0Frame(
  frame: BaileysStage0ParentFrame | BaileysStage0ChildFrame,
): string {
  return `${JSON.stringify(frame)}\n`;
}
