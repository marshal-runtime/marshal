import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";

import type { RuntimeTool } from "../runtime-contract";

export interface CursorToolSessionIdentity {
  id: string;
}

export function toCursorCustomTools(
  tools: RuntimeTool[] | undefined,
  session: CursorToolSessionIdentity,
): Record<string, SDKCustomTool> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return Object.fromEntries(tools.map((tool) => [tool.name, toCursorCustomTool(tool, session)]));
}

function toCursorCustomTool(
  tool: RuntimeTool,
  session: CursorToolSessionIdentity,
): SDKCustomTool {
  return {
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.parameters
      ? {
          // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- RuntimeTool.parameters is JSON Schema at the runtime boundary.
          inputSchema: tool.parameters as Record<string, SDKJsonValue>,
        }
      : {}),
    execute: async (args, context) => {
      const text = await tool.handler(args, {
        sessionId: session.id,
        toolCallId: context.toolCallId ?? tool.name,
        toolName: tool.name,
        arguments: args,
      });
      return { content: [{ type: "text", text }] };
    },
  };
}
