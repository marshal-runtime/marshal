import type {
  McpSdkServerConfigWithInstance,
  Options,
  SettingSource,
  SpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";

import type { RuntimeSessionConfig } from "../runtime-contract";
import { createClaudeEnvironment, type ClaudeEnvironment } from "./environment";
import { toClaudeHooks } from "./hooks";
import { toClaudeMcpServers } from "./mcp-config";
import { createClaudePermissionHandler } from "./permissions";
import type { ClaudeToolInvocationRegistry } from "./tool-invocations";
import { toClaudeHostToolName } from "./tool-names";

export interface ClaudeClientConfiguration {
  workspaceDir: string;
  env: ClaudeEnvironment;
  configDir?: string;
  pathToClaudeCodeExecutable?: string;
  authExecutablePath?: string;
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
  settingSources?: SettingSource[];
}

export function toClaudeQueryOptions(args: {
  client: ClaudeClientConfiguration;
  config: RuntimeSessionConfig;
  sessionId: string;
  resume: boolean;
  hostServer?: McpSdkServerConfigWithInstance;
  toolAliases: Record<string, string>;
  invocations: ClaudeToolInvocationRegistry;
}): Options {
  const { client, config, sessionId, resume, hostServer, toolAliases, invocations } = args;
  const cwd = config.cwd ?? config.workingDirectory ?? client.workspaceDir;
  const systemMessage = config.systemMessage;
  const systemPrompt: Options["systemPrompt"] =
    systemMessage?.mode === "replace"
      ? systemMessage.content
      : {
          type: "preset",
          preset: "claude_code",
          ...(systemMessage?.content ? { append: systemMessage.content } : {}),
        };
  const projectContext = config.projectContext !== false;
  const hasToolAllowlist = config.availableTools !== undefined;
  const allowedToolNames = new Set(config.availableTools ?? []);
  const runtimeToolNames = new Set(config.tools?.map((tool) => tool.name) ?? []);
  const builtInTools = hasToolAllowlist
    ? [...allowedToolNames].filter((name) => !runtimeToolNames.has(name))
    : undefined;
  const skills: Options["skills"] =
    projectContext && (!hasToolAllowlist || allowedToolNames.has("Skill")) ? "all" : [];
  const mcpServers =
    hasToolAllowlist && allowedToolNames.size === 0
      ? undefined
      : toClaudeMcpServers(config.mcpServers, hostServer);
  const scriptingTool = config.tools?.find(
    (tool) => tool.scriptingTool && (!hasToolAllowlist || allowedToolNames.has(tool.name)),
  );
  const hooks = toClaudeHooks(config.hooks, sessionId, invocations, {
    scriptingToolName: scriptingTool ? toClaudeHostToolName(scriptingTool.name) : undefined,
    scriptingToolHint: scriptingTool?.toolCallHint,
    scriptingSubagentContext: scriptingTool?.subagentStartContext,
  });

  return {
    abortController: new AbortController(),
    cwd,
    env: createClaudeEnvironment(client.env, {
      configDir: client.configDir,
      clientName: config.clientName,
    }),
    // Marshal exposes a per-task stop via `rpc.tasks.stop` (ClaudeRuntimeSession,
    // backed by Query.stopTask). Without this declaration the CLI fails closed:
    // any interrupt() on a still-open session (Stop, or a redirect mid-turn)
    // kills every live background task (backgrounded Bash, backgrounded Agent
    // subagents) rather than just aborting the current turn.
    perTaskStopAffordance: true,
    settingSources: projectContext ? (client.settingSources ?? ["project"]) : [],
    // Marshal memory is the only memory channel; Claude Code's own auto-memory
    // notes would be a second, unmanaged one.
    settings: {
      autoCompactWindow: 400_000,
      autoMemoryEnabled: false,
    },
    // Opus 5.5+ defaults thinking display to "omitted": minutes of silent thinking look like a hung chat.
    // settings.showThinkingSummaries does not reach the API request; only this option does.
    thinking: { type: "adaptive", display: "summarized" },
    strictMcpConfig: true,
    persistSession: true,
    tools: builtInTools ?? { type: "preset", preset: "claude_code" },
    skills,
    ...(config.disabledBuiltInTools?.length
      ? { disallowedTools: [...config.disabledBuiltInTools] }
      : {}),
    ...(config.agents ? { agents: config.agents } : {}),
    systemPrompt,
    includePartialMessages: config.streaming !== false,
    forwardSubagentText: config.includeSubAgentStreamingEvents === true,
    ...(config.model ? { model: config.model } : {}),
    ...(config.reasoningEffort ? { effort: config.reasoningEffort } : {}),
    ...(config.contextTier === "long_context" ? { betas: ["context-1m-2025-08-07"] } : {}),
    ...(resume ? { resume: sessionId } : { sessionId }),
    ...(client.pathToClaudeCodeExecutable
      ? { pathToClaudeCodeExecutable: client.pathToClaudeCodeExecutable }
      : {}),
    ...(client.spawnClaudeCodeProcess
      ? { spawnClaudeCodeProcess: client.spawnClaudeCodeProcess }
      : {}),
    ...(Object.keys(toolAliases).length > 0 && (!hasToolAllowlist || allowedToolNames.size !== 0)
      ? { toolAliases }
      : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(hooks ? { hooks } : {}),
    canUseTool: createClaudePermissionHandler(
      config.onPermissionRequest,
      sessionId,
      invocations,
      hasToolAllowlist ? allowedToolNames : undefined,
    ),
  };
}
