import { createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  COMMAND_CENTER_REDACTION_VERSION,
  COMMAND_CENTER_SCHEMA_VERSION,
  type CommandCenterEventInput,
  type CommandCenterSafeBackendEvent,
  type CommandCenterToolKind,
} from "../../common/command-center-contract";
import { getAppDataDir } from "../app-paths";
import { readEncryptedFileSync, writeEncryptedFileSync } from "../safe-storage-file";
import type { CommandCenterSessionLifecycleInput } from "./session-observer";

export class CommandCenterPrivacyNormalizer {
  private readonly saltFilePath: string;
  private cachedSalt: string | null = null;

  constructor(
    saltFilePath = path.join(getAppDataDir(), "marshal-command-center", "hash-salt.enc"),
  ) {
    // Defer salt creation to first use. The salt is read/written via safeStorage,
    // which throws (dev) or logs+degrades (packaged) when touched before
    // app.whenReady(). This normalizer is constructed at module load — before the
    // app is ready — but its salt is only needed by safeId()/hashShape(), which
    // run during session activity long after startup. Lazy-loading keeps the
    // constructor side-effect-free and off the pre-ready path.
    this.saltFilePath = saltFilePath;
  }

  private get salt(): string {
    if (this.cachedSalt === null) {
      this.cachedSalt = loadOrCreateSalt(this.saltFilePath);
    }
    return this.cachedSalt;
  }

  sessionLifecycle(input: CommandCenterSessionLifecycleInput): CommandCenterEventInput {
    return {
      schemaVersion: COMMAND_CENTER_SCHEMA_VERSION,
      redactionVersion: COMMAND_CENTER_REDACTION_VERSION,
      type: "session.lifecycle",
      sessionId: this.safeId("session", input.sessionId),
      lifecycle: input.lifecycle,
      source: safeSource(input.source),
      backendOrigin: input.backendOrigin,
    };
  }

  backendEvent(input: CommandCenterSafeBackendEvent): CommandCenterEventInput[] {
    if (input.type === "idle") {
      return [this.sessionLifecycle({ sessionId: input.sessionId, lifecycle: "idle" })];
    }
    if (input.type === "turn-error") {
      return [
        this.sessionLifecycle({ sessionId: input.sessionId, lifecycle: "errored" }),
        {
          schemaVersion: COMMAND_CENTER_SCHEMA_VERSION,
          redactionVersion: COMMAND_CENTER_REDACTION_VERSION,
          type: "blocker.upsert",
          blockerId: this.safeId(
            "blocker",
            `${input.sessionId}:${input.errorClass ?? "turn-error"}`,
          ),
          status: "active",
          severity: "error",
          label: input.errorClass ?? "Turn error",
          sessionId: this.safeId("session", input.sessionId),
        },
      ];
    }
    if (input.type !== "tool-start" && input.type !== "tool-result") return [];

    const toolCallId = input.toolCallId ?? `${input.sessionId}:unknown-tool`;
    const toolName = input.toolName ?? "unknown-tool";
    const status = input.type === "tool-start" ? "started" : input.success ? "succeeded" : "failed";
    return [
      {
        schemaVersion: COMMAND_CENTER_SCHEMA_VERSION,
        redactionVersion: COMMAND_CENTER_REDACTION_VERSION,
        type: "tool.observed",
        toolCallId: this.safeId("tool", toolCallId),
        sessionId: this.safeId("session", input.sessionId),
        toolName: safeToolName(toolName),
        serverName: input.serverName ? safeToolName(input.serverName) : undefined,
        kind: classifyTool(toolName, input.serverName),
        status,
        argKeys: [...(input.argKeys ?? [])].map(safeToolName).sort(),
        argsHash: input.argsShapeHash ?? this.hashShape(input.argKeys ?? []),
        resultHash: input.resultShapeHash,
        errorClass: input.errorClass,
      },
    ];
  }

  safeId(prefix: string, value: string): string {
    return `${prefix}_${hmac(this.salt, value, 16)}`;
  }

  hashShape(value: unknown): string {
    return hmac(this.salt, stableStringify(value), 24);
  }
}

function loadOrCreateSalt(saltFilePath: string): string {
  try {
    const existing = readEncryptedFileSync(saltFilePath);
    if (existing) return existing;
  } catch {
    // Salt absence is expected on first run; corrupt salt is replaced.
  }
  const salt = randomBytes(32).toString("base64");
  fs.mkdirSync(path.dirname(saltFilePath), { recursive: true });
  writeEncryptedFileSync(saltFilePath, salt);
  return salt;
}

function hmac(salt: string, value: string, length: number): string {
  return createHmac("sha256", salt).update(value).digest("hex").slice(0, length);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}

function safeToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 96) || "unknown";
}

function safeSource(source: CommandCenterSessionLifecycleInput["source"]) {
  switch (source) {
    case "user":
    case "automation":
    case "heartbeat":
    case "workflow-run":
    case "workspace":
      return source;
    default:
      return undefined;
  }
}

function classifyTool(toolName: string, serverName?: string): CommandCenterToolKind {
  const haystack = `${serverName ?? ""}:${toolName}`.toLowerCase();
  if (haystack.includes("filesystem") || haystack.includes("file")) return "file";
  if (haystack.includes("shell") || haystack.includes("powershell")) return "shell";
  if (haystack.includes("browser") || haystack.includes("playwright")) return "browser";
  return serverName ? "generic" : "unknown";
}
