import path from "node:path";

import type {
  RuntimeAttachment,
  RuntimeMcpServerConfig,
  RuntimeSendOptions,
  RuntimeSessionConfig,
  RuntimeTool,
} from "../runtime-contract";
import { buildCodexToolNotes } from "./native-tool-notes";
import type { UnknownRecord } from "./protocol";
import {
  CODEX_DEFERRED_TOOL_NAMESPACE,
  resolveCodexNativeTools,
  toCodexToolSurfaceConfig,
} from "./tool-surface";

const DYNAMIC_TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".m4a", ".mp3", ".ogg", ".wav", ".webm"]);

export interface CodexFunctionToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: UnknownRecord;
  deferLoading?: boolean;
}

export interface CodexNamespaceToolSpec {
  type: "namespace";
  name: string;
  description: string;
  tools: CodexFunctionToolSpec[];
}

export type CodexDynamicToolSpec = CodexFunctionToolSpec | CodexNamespaceToolSpec;

function toToolSchema(tool: RuntimeTool): UnknownRecord {
  const schema = tool.parameters;
  if (!schema) {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  return { ...schema };
}

function toCodexFunctionTool(tool: RuntimeTool): CodexFunctionToolSpec {
  if (!DYNAMIC_TOOL_NAME.test(tool.name)) {
    throw new Error(
      `Codex dynamic tool name "${tool.name}" must match ${DYNAMIC_TOOL_NAME.source}`,
    );
  }
  return {
    type: "function",
    name: tool.name,
    description: tool.description ?? tool.name,
    inputSchema: toToolSchema(tool),
  };
}

export function toCodexDynamicTools(
  tools: readonly RuntimeTool[] | undefined,
  options: { deferNonEager?: boolean } = {},
): CodexDynamicToolSpec[] {
  if (!tools) return [];
  if (!options.deferNonEager) return tools.map(toCodexFunctionTool);
  const eager = tools.filter((tool) => tool.eagerLoad === true).map(toCodexFunctionTool);
  const deferred = tools
    .filter((tool) => tool.eagerLoad !== true)
    .map((tool) => ({ ...toCodexFunctionTool(tool), deferLoading: true }));
  return [
    ...eager,
    ...(deferred.length > 0
      ? [
          {
            type: "namespace" as const,
            name: CODEX_DEFERRED_TOOL_NAMESPACE,
            description:
              "Marshal host tools that are not loaded up front. Find one with tool_search, then call it.",
            tools: deferred,
          },
        ]
      : []),
  ];
}

/**
 * The dynamic tools a session advertises. Non-eager tools are deferred behind
 * Codex's `tool_search` only for unrestricted sessions: restricted surfaces are
 * small and disable the collaboration feature that `tool_search` rides on.
 */
export function codexDynamicToolsForConfig(config: RuntimeSessionConfig): CodexDynamicToolSpec[] {
  return toCodexDynamicTools(config.tools, { deferNonEager: config.availableTools === undefined });
}

function toCodexMcpServer(config: RuntimeMcpServerConfig): UnknownRecord {
  const common: UnknownRecord = {
    enabled: true,
    default_tools_approval_mode: "prompt",
    ...(config.tools ? { enabled_tools: [...config.tools] } : {}),
    ...(config.timeout !== undefined ? { tool_timeout_sec: config.timeout / 1_000 } : {}),
  };

  if ("command" in config) {
    return {
      ...common,
      command: config.command,
      ...(config.args ? { args: [...config.args] } : {}),
      ...(config.env ? { env: { ...config.env } } : {}),
      ...(config.workingDirectory ? { cwd: config.workingDirectory } : {}),
    };
  }

  return {
    ...common,
    url: config.url,
    ...(config.headers ? { http_headers: { ...config.headers } } : {}),
  };
}

export function toCodexThreadConfig(
  servers: Readonly<Record<string, RuntimeMcpServerConfig>> | undefined,
  reasoningEffort?: RuntimeSessionConfig["reasoningEffort"],
): UnknownRecord {
  return {
    mcp_servers: Object.fromEntries(
      Object.entries(servers ?? {}).map(([name, config]) => [name, toCodexMcpServer(config)]),
    ),
    ...(reasoningEffort ? { model_reasoning_effort: reasoningEffort } : {}),
  };
}

/**
 * Marshal's prompt rides one of two Codex slots. `replace` mode (the
 * runtime-neutral "this is the whole system prompt" contract Claude maps to
 * `systemPrompt: string`) becomes `baseInstructions`, which replaces Codex's
 * built-in instructions entirely (verified: the Responses request's
 * `instructions` is exactly the supplied text), with the Codex tool notes
 * appended because the replaced text carried the native-tool guidance. Any
 * other mode layers as `developerInstructions` on top of Codex's own.
 */
export function toCodexInstructionParams(config: RuntimeSessionConfig): UnknownRecord {
  const message = config.systemMessage;
  if (!message) return {};
  if (message.mode !== "replace") return { developerInstructions: message.content };
  const notes = buildCodexToolNotes(resolveCodexNativeTools(config.availableTools), {
    deferredHostTools:
      config.availableTools === undefined && config.tools?.some((tool) => !tool.eagerLoad) === true,
  });
  return { baseInstructions: notes ? `${message.content}\n\n${notes}` : message.content };
}

export function toCodexThreadParams(
  workspaceDir: string,
  config: RuntimeSessionConfig,
  options: { experimentalApi: boolean },
): UnknownRecord {
  const cwd = config.workingDirectory ?? config.cwd ?? workspaceDir;
  const dynamicTools = codexDynamicToolsForConfig(config);
  if (dynamicTools.length > 0 && !options.experimentalApi) {
    throw new Error(
      "Codex RuntimeTool integration requires initialize.capabilities.experimentalApi",
    );
  }

  // Session-scoped sandbox from the host: read-only unless an explicit override
  // or the allow-all default ("danger-full-access": no OS sandbox, network
  // included, so commands run once instead of failing read-only and being
  // retried after an approval; approvalPolicy stays "untrusted" so the
  // permission policy and audit log still see every action). Extra writable
  // roots ride the codex config override map (config.toml schema:
  // sandbox_workspace_write.writable_roots) — the cwd is writable implicitly.
  const sandboxMode = config.sandbox?.mode ?? "read-only";
  const writableRoots =
    sandboxMode === "workspace-write" ? (config.sandbox?.writableRoots ?? []) : [];

  return {
    cwd,
    ...(options.experimentalApi ? { runtimeWorkspaceRoots: [cwd] } : {}),
    approvalPolicy: config.onPermissionRequest ? "untrusted" : "never",
    approvalsReviewer: "user",
    sandbox: sandboxMode,
    config: {
      ...toCodexThreadConfig(config.mcpServers, config.reasoningEffort),
      ...toCodexToolSurfaceConfig(config.availableTools),
      ...(writableRoots.length > 0
        ? { sandbox_workspace_write: { writable_roots: [...writableRoots] } }
        : {}),
      ...(omitsProjectDocs(config) ? { project_doc_max_bytes: 0 } : {}),
    },
    serviceName: config.clientName ?? "marshal",
    ...(config.model ? { model: config.model } : {}),
    ...toCodexInstructionParams(config),
    ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
    ...(config.ephemeral ? { ephemeral: true } : {}),
  };
}

/** Codex loads AGENTS.md natively; drop it when the session carries no repository context or no tools. */
function omitsProjectDocs(config: RuntimeSessionConfig): boolean {
  return config.projectContext === false || config.availableTools?.length === 0;
}

export function toCodexResumeParams(
  threadId: string,
  workspaceDir: string,
  config: RuntimeSessionConfig,
  options: { experimentalApi: boolean },
): UnknownRecord {
  const start = toCodexThreadParams(workspaceDir, config, options);
  return {
    threadId,
    cwd: start["cwd"],
    ...(start["runtimeWorkspaceRoots"] !== undefined
      ? { runtimeWorkspaceRoots: start["runtimeWorkspaceRoots"] }
      : {}),
    approvalPolicy: start["approvalPolicy"],
    approvalsReviewer: start["approvalsReviewer"],
    sandbox: start["sandbox"],
    config: start["config"],
    ...(start["model"] !== undefined ? { model: start["model"] } : {}),
    ...(start["developerInstructions"] !== undefined
      ? { developerInstructions: start["developerInstructions"] }
      : {}),
    ...(start["baseInstructions"] !== undefined
      ? { baseInstructions: start["baseInstructions"] }
      : {}),
  };
}

export function toCodexTurnParams(
  threadId: string,
  options: RuntimeSendOptions,
  config: RuntimeSessionConfig,
  overrides: { model?: string; effort?: string },
  clientUserMessageId: string,
): UnknownRecord {
  return {
    threadId,
    clientUserMessageId,
    input: toCodexUserInput(options),
    ...(config.workingDirectory || config.cwd
      ? { cwd: config.workingDirectory ?? config.cwd }
      : {}),
    ...(overrides.model || config.model ? { model: overrides.model ?? config.model } : {}),
    ...(overrides.effort || config.reasoningEffort
      ? { effort: overrides.effort ?? config.reasoningEffort }
      : {}),
  };
}

/** `turn/steer` injects input into the ACTIVE turn; `expectedTurnId` is the
 *  app-server's precondition — the request fails when that turn is no longer
 *  the active one, so a raced completion never silently drops the message. */
export function toCodexSteerParams(
  threadId: string,
  options: RuntimeSendOptions,
  expectedTurnId: string,
  clientUserMessageId: string,
): UnknownRecord {
  return {
    threadId,
    clientUserMessageId,
    expectedTurnId,
    input: toCodexUserInput(options),
  };
}

function attachmentMetadata(attachments: readonly RuntimeAttachment[]): string {
  return [
    "Host-selected local attachments are available at these exact paths:",
    JSON.stringify(
      attachments.map((attachment) => ({
        type: attachment.type,
        path: attachment.path,
        ...(attachment.displayName !== undefined ? { displayName: attachment.displayName } : {}),
      })),
    ),
  ].join("\n");
}

export function toCodexUserInput(options: RuntimeSendOptions): UnknownRecord[] {
  const input: UnknownRecord[] = [{ type: "text", text: options.prompt, text_elements: [] }];
  const attachments = options.attachments ?? [];
  if (attachments.length === 0) return input;
  for (const attachment of attachments) {
    if (attachment.path.length === 0) {
      throw new Error("Runtime attachment paths must not be empty");
    }
  }
  input.push({
    type: "text",
    text: attachmentMetadata(attachments),
    text_elements: [],
  });
  for (const attachment of attachments) {
    if (attachment.type !== "file") continue;
    const extension = path.extname(attachment.path).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) {
      input.push({ type: "localImage", path: attachment.path });
    } else if (AUDIO_EXTENSIONS.has(extension)) {
      input.push({ type: "localAudio", path: attachment.path });
    }
  }
  return input;
}
