import { PLAYWRIGHT_EXPLICIT_WRITE_TOOLS } from "./names";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function extractBrowserWritePath(toolName: string, toolArgs: unknown): string | null {
  const filenameKey = PLAYWRIGHT_EXPLICIT_WRITE_TOOLS[toolName];
  if (!filenameKey) return null;

  let args: unknown;
  if (typeof toolArgs === "string") {
    try {
      // SF-4: toolArgs is MCP-supplied input; cast to unknown and guard before property access.
      args = JSON.parse(toolArgs) as unknown;
    } catch {
      return null;
    }
  } else {
    args = toolArgs;
  }

  if (!isRecord(args)) return null;
  const filename = args[filenameKey];
  return typeof filename === "string" && filename.length > 0 ? filename : null;
}
