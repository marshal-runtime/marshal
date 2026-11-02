// Owns browser-use permission classification.
import type { ApprovalRequest } from "./backend/types";
import { getServerName, getToolName } from "./permission-policy";

function isPlaywrightBrowserTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return lower.startsWith("playwright-browser_") || lower.startsWith("playwright__browser_");
}

export function isBrowserUsePermission(request: ApprovalRequest): boolean {
  if (request.kind === "url") return true;

  const serverName = getServerName(request).toLowerCase();
  if (serverName === "playwright") return true;

  const toolName = getToolName(request);
  return isPlaywrightBrowserTool(toolName);
}
