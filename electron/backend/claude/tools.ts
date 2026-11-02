import { randomUUID } from "node:crypto";

import type {
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z, type ZodRawShape } from "zod/v4";

import type { RuntimeTool } from "../runtime-contract";
import type { ClaudeSdkFacade } from "./sdk-facade";
import type { ClaudeToolInvocationRegistry } from "./tool-invocations";
import { toClaudeHostToolName } from "./tool-names";

const CLAUDE_BUILT_IN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Agent",
  "AskUserQuestion",
  "Bash",
  "Edit",
  "EnterPlanMode",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillShell",
  "NotebookEdit",
  "Read",
  "Skill",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
]);

export interface ClaudeRuntimeToolServer {
  server?: McpSdkServerConfigWithInstance;
  aliases: Record<string, string>;
}

function toZodRawShape(parameters: Record<string, unknown> | undefined): ZodRawShape {
  if (!parameters) return {};
  const type = parameters["type"];
  if (type !== undefined && type !== "object") {
    throw new Error("Claude runtime tools require an object JSON schema");
  }

  const propertiesValue = parameters["properties"];
  if (propertiesValue === undefined) return {};
  if (
    typeof propertiesValue !== "object" ||
    propertiesValue === null ||
    Array.isArray(propertiesValue)
  ) {
    throw new Error("Claude runtime tool JSON schema properties must be an object");
  }

  const requiredValue = parameters["required"];
  const required = new Set(
    Array.isArray(requiredValue)
      ? requiredValue.filter((value): value is string => typeof value === "string")
      : [],
  );
  const shapeEntries: Array<[string, z.ZodType]> = [];
  for (const [name, propertySchema] of Object.entries(propertiesValue)) {
    if (typeof propertySchema !== "object" || propertySchema === null) {
      throw new Error(`Claude runtime tool property "${name}" must be a JSON schema object`);
    }
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- RuntimeTool.parameters is JSON Schema at the runtime boundary.
    const schema = z.fromJSONSchema(propertySchema as Parameters<typeof z.fromJSONSchema>[0]);
    shapeEntries.push([name, required.has(name) ? schema : schema.optional()]);
  }
  return Object.fromEntries(shapeEntries);
}

function signalFromExtra(extra: unknown): AbortSignal | undefined {
  if (typeof extra !== "object" || extra === null) return undefined;
  const signal = Reflect.get(extra, "signal");
  return signal instanceof AbortSignal ? signal : undefined;
}

function toSdkTool(
  sdk: ClaudeSdkFacade,
  runtimeTool: RuntimeTool,
  sessionId: string,
  invocations: ClaudeToolInvocationRegistry,
): SdkMcpToolDefinition<ZodRawShape> {
  const shape = toZodRawShape(runtimeTool.parameters);
  const extras = runtimeTool.eagerLoad ? { alwaysLoad: true } : undefined;
  return sdk.tool(
    runtimeTool.name,
    runtimeTool.description ?? `Run the ${runtimeTool.name} host tool`,
    shape,
    async (args, extra) => {
      const pending = invocations.take(runtimeTool.name);
      const signal = runtimeTool.supportsAbortSignal
        ? (pending?.signal ?? signalFromExtra(extra))
        : undefined;
      const text = await runtimeTool.handler(args, {
        sessionId,
        toolCallId: pending?.toolCallId ?? randomUUID(),
        toolName: runtimeTool.name,
        arguments: args,
        signal,
      });
      return { content: [{ type: "text", text }] };
    },
    extras,
  );
}

export function createClaudeRuntimeToolServer(
  sdk: ClaudeSdkFacade,
  tools: RuntimeTool[] | undefined,
  sessionId: string,
  invocations: ClaudeToolInvocationRegistry,
): ClaudeRuntimeToolServer {
  if (!tools || tools.length === 0) return { aliases: {} };

  const aliases: Record<string, string> = {};
  for (const runtimeTool of tools) {
    if (!CLAUDE_BUILT_IN_TOOL_NAMES.has(runtimeTool.name) || runtimeTool.overridesBuiltInTool) {
      aliases[runtimeTool.name] = toClaudeHostToolName(runtimeTool.name);
    }
  }

  return {
    server: sdk.createSdkMcpServer({
      name: "Marshal host tools",
      version: "1",
      tools: tools.map((runtimeTool) => toSdkTool(sdk, runtimeTool, sessionId, invocations)),
    }),
    aliases,
  };
}
