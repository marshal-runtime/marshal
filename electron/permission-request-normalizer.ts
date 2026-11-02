import { BUILTIN_SHELL_SERVERS } from "../common/marshal-permission-servers";
import type { PermissionsEscalationDiff } from "./backend/ports";
import { LOCAL_FILE_TOOL_DEFINITIONS, resolveLocalFilePath } from "./marshal-fs/shared";
import type {
  NormalizedCustomTool,
  NormalizedHook,
  NormalizedMemory,
  NormalizedPermissionRequest,
  NormalizedRead,
  NormalizedSettings,
  NormalizedShell,
  NormalizedUrl,
  NormalizedWrite,
} from "./permission-request-types";
import { getShellCommandName } from "./shell-syntax-permission-utils";
import {
  getBarePlaywrightToolName,
  isBrowserCodeExecutionTool,
  PLAYWRIGHT_EXPLICIT_WRITE_TOOLS,
} from "./platform/security/browser-tools/names";

export type NormalizerResolvers = {
  /** Copilot backend: look up the pending write path for a browser tool (bare name, no prefix). */
  resolvePendingBrowserPath?(bareToolName: string): string | undefined;
};

type Raw = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function extractCommandIdentifiers(raw: Raw): string[] {
  const prompt = isRecord(raw.promptRequest) ? raw.promptRequest : null;
  const promptIds =
    prompt && Array.isArray(prompt.commandIdentifiers)
      ? (prompt.commandIdentifiers as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
  if (promptIds.length > 0) return promptIds;

  if (Array.isArray(raw.commandIdentifiers)) {
    const direct = (raw.commandIdentifiers as unknown[]).filter(
      (x): x is string => typeof x === "string",
    );
    if (direct.length > 0) return direct;
  }

  if (Array.isArray(raw.commands)) {
    return (raw.commands as unknown[]).flatMap((cmd) => {
      if (!isRecord(cmd)) return [];
      const id = str(cmd.identifier);
      return id ? [id] : [];
    });
  }
  return [];
}

function extractIntention(raw: Raw): string | undefined {
  const prompt = isRecord(raw.promptRequest) ? raw.promptRequest : null;
  const v = str(prompt?.intention) || str(raw.intention);
  return v || undefined;
}

function extractWarning(raw: Raw): string | undefined {
  const prompt = isRecord(raw.promptRequest) ? raw.promptRequest : null;
  const v = str(prompt?.warning) || str(raw.warning);
  return v || undefined;
}

function extractToolArgs(raw: Raw): Record<string, unknown> {
  const METADATA_KEYS = new Set([
    "kind",
    "toolCallId",
    "toolName",
    "tool",
    "toolDescription",
    "toolTitle",
    "serverName",
    "promptRequest",
    "commandIdentifiers",
    "commands",
    "intention",
    "warning",
    "args",
    "arguments",
  ]);
  const nested = raw.args ?? raw.arguments;
  if (isRecord(nested) && Object.keys(nested).length > 0) return nested;
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !METADATA_KEYS.has(k)));
}

function normalizeShell(raw: Raw, toolCallId: string | undefined): NormalizedShell {
  const command = str(raw.fullCommandText) || str(raw.command) || str(raw.cmd);
  const explicit = str(raw.serverName);
  let serverName = explicit;
  if (!serverName) {
    const cmdName = getShellCommandName(command);
    serverName = cmdName && BUILTIN_SHELL_SERVERS.has(cmdName) ? cmdName : "";
  }
  return {
    kind: "shell",
    toolCallId,
    command,
    serverName,
    intention: extractIntention(raw),
    warning: extractWarning(raw),
    commandIdentifiers: extractCommandIdentifiers(raw),
  };
}

function normalizeWrite(raw: Raw, toolCallId: string | undefined): NormalizedWrite {
  return {
    kind: "write",
    toolCallId,
    path: str(raw.path) || str(raw.fileName) || str(raw.file),
    diff: typeof raw.diff === "string" ? raw.diff : null,
    intention: extractIntention(raw),
    origin: "sdk",
    browserToolName: undefined,
  };
}

function normalizeMcp(
  raw: Raw,
  toolCallId: string | undefined,
  resolvers?: NormalizerResolvers,
): NormalizedPermissionRequest {
  const toolName = str(raw.toolName) || str(raw.tool);
  const bareName = getBarePlaywrightToolName(toolName);

  // Universal browser-write upgrade: explicit write tools with known paths
  if (resolvers?.resolvePendingBrowserPath) {
    const pendingPath = resolvers.resolvePendingBrowserPath(bareName);
    if (pendingPath !== undefined) {
      return {
        kind: "write",
        toolCallId,
        path: pendingPath,
        diff: null,
        intention: undefined,
        origin: "synthesized-browser",
        browserToolName: toolName,
      };
    }
  }

  // Code-execution tools: write with path="*" (unknown target)
  if (isBrowserCodeExecutionTool(bareName)) {
    return {
      kind: "write",
      toolCallId,
      path: "*",
      diff: null,
      intention: undefined,
      origin: "synthesized-browser",
      browserToolName: toolName,
    };
  }

  // Known write tool but path unavailable: upgrade to preserve audit trail
  if (Object.hasOwn(PLAYWRIGHT_EXPLICIT_WRITE_TOOLS, bareName)) {
    return {
      kind: "write",
      toolCallId,
      path: "*",
      diff: null,
      intention: undefined,
      origin: "synthesized-browser",
      browserToolName: toolName,
    };
  }

  const rawArgs = raw.arguments ?? raw.args ?? raw.toolArgs;
  const toolArgs: Record<string, unknown> = isRecord(rawArgs) ? rawArgs : {};
  return {
    kind: "mcp",
    toolCallId,
    serverName: str(raw.serverName) || undefined,
    toolName,
    toolTitle: str(raw.toolTitle) || undefined,
    toolDescription: str(raw.toolDescription) || undefined,
    toolArgs,
    readOnly: raw.readOnly === true,
  };
}

function normalizeRead(raw: Raw, toolCallId: string | undefined): NormalizedRead {
  return {
    kind: "read",
    toolCallId,
    path: str(raw.path) || str(raw.fileName) || str(raw.file),
  };
}

function normalizeUrl(raw: Raw, toolCallId: string | undefined): NormalizedUrl {
  return {
    kind: "url",
    toolCallId,
    url: str(raw.url),
    toolName: str(raw.toolName) || str(raw.tool),
  };
}

/**
 * Rewrite a local filesystem tool into a synthetic
 * read/write so every existing path rule (sensitive-path-gate, folder-grant,
 * read-tool-auto-approval-rule) applies unchanged — instead of the custom-tool path,
 * which has no notion of a file path. Returns null for any non-fs custom tool.
 */
function normalizeMarshalFsTool(
  raw: Raw,
  toolCallId: string | undefined,
): NormalizedRead | NormalizedWrite | null {
  const toolName = str(raw.toolName) || str(raw.tool);
  const mapping = LOCAL_FILE_TOOL_DEFINITIONS[toolName];
  if (!mapping) return null;

  const args = extractToolArgs(raw);
  const candidate = args[mapping.pathArg];
  const rawPath = typeof candidate === "string" ? candidate : "";
  const resolved = rawPath ? resolveLocalFilePath(rawPath) : "";

  if (mapping.kind === "read") {
    return { kind: "read", toolCallId, path: resolved };
  }
  // A Marshal fs write is never paired with a concurrent kind:mcp request, so it
  // must present a non-empty toolCallId — otherwise SENSITIVE_PATH_GATE_RULE
  // skips it as the MCP-paired case (`write && origin:sdk && !toolCallId`).
  // Fall back to a stable sentinel when the SDK omits one.
  return {
    kind: "write",
    toolCallId: toolCallId ?? `marshal-fs:${toolName}`,
    path: resolved,
    diff: null,
    intention: undefined,
    origin: "sdk",
    browserToolName: undefined,
  };
}

function normalizeCustomTool(raw: Raw, toolCallId: string | undefined): NormalizedCustomTool {
  const toolName = str(raw.toolName) || str(raw.tool);
  return {
    kind: "custom-tool",
    toolCallId,
    toolName,
    toolDescription: str(raw.toolDescription) || undefined,
    toolArgs: extractToolArgs(raw),
    intention: extractIntention(raw),
    warning: extractWarning(raw),
    commandIdentifiers: extractCommandIdentifiers(raw),
  };
}

function normalizeMemory(raw: Raw, toolCallId: string | undefined): NormalizedMemory {
  const rawArgs = raw.arguments ?? raw.args;
  return {
    kind: "memory",
    toolCallId,
    toolName: str(raw.toolName) || str(raw.tool),
    toolArgs: isRecord(rawArgs) ? rawArgs : {},
  };
}

function normalizeHook(raw: Raw, toolCallId: string | undefined): NormalizedHook {
  const rawArgs = raw.arguments ?? raw.args;
  return {
    kind: "hook",
    toolCallId,
    toolName: str(raw.toolName) || str(raw.tool),
    toolArgs: isRecord(rawArgs) ? rawArgs : {},
  };
}

function isPermissionsEscalationDiff(v: unknown): v is PermissionsEscalationDiff {
  return typeof v === "object" && v !== null;
}

function normalizeSettings(raw: Raw, toolCallId: string | undefined): NormalizedSettings {
  return {
    kind: "settings",
    toolCallId,
    diff: isPermissionsEscalationDiff(raw.diff) ? raw.diff : undefined,
  };
}

export function normalizePermissionRequest(
  raw: Record<string, unknown>,
  resolvers?: NormalizerResolvers,
): NormalizedPermissionRequest {
  const kind = str(raw.kind);
  const toolCallId = str(raw.toolCallId) || undefined;

  switch (kind) {
    case "shell":
      return normalizeShell(raw, toolCallId);
    case "write":
      return normalizeWrite(raw, toolCallId);
    case "mcp":
      return normalizeMcp(raw, toolCallId, resolvers);
    case "read":
      return normalizeRead(raw, toolCallId);
    case "url":
      return normalizeUrl(raw, toolCallId);
    case "custom-tool":
      return normalizeMarshalFsTool(raw, toolCallId) ?? normalizeCustomTool(raw, toolCallId);
    case "memory":
      return normalizeMemory(raw, toolCallId);
    case "hook":
      return normalizeHook(raw, toolCallId);
    case "settings":
      return normalizeSettings(raw, toolCallId);
    default:
      // Unknown kind — treat as MCP (safe default for forward-compat)
      return normalizeMcp(raw, toolCallId, resolvers);
  }
}
