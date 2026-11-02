/**
 * Human-readable descriptions for tool calls.
 * Shared between main process (relay bridge) and renderer (tool status UI).
 */
import { humanizeToolName, isPublicFirstPartyToolName } from "./tool-names";

export function formatToolDescription(toolName: string, args: unknown): string | null {
  const raw =
    typeof args === "string"
      ? (() => {
          try {
            return JSON.parse(args);
          } catch {
            return {};
          }
        })()
      : args || {};
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- tool args are string-keyed records from the SDK
  const a = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, string>;
  switch (toolName) {
    case "bash":
    case "powershell":
    case "pwsh":
    case "shell":
      return a.description || formatShellCommandSummary(a.command) || `Running shell command`;
    case "view":
      return `Reading ${a.path?.split("/").pop() || "file"}`;
    case "edit":
      return `Editing ${a.path?.split("/").pop() || "file"}`;
    case "create":
      return `Creating ${a.path?.split("/").pop() || "file"}`;
    case "grep":
      return `Searching for "${a.pattern?.substring(0, 40) || "..."}"`;
    case "glob":
      return `Finding files matching ${a.pattern?.substring(0, 40) || "..."}`;
    case "web_search":
      return `Searching the web`;
    case "web_fetch":
      return `Fetching ${a.url?.substring(0, 60) || "URL"}`;
    // Playwright/browser tools
    case "browser_navigate":
      return `Navigating to ${a.url?.substring(0, 50) || "page"}`;
    case "browser_click":
      return `Clicking ${a.element || "element"}`;
    case "browser_type":
      return `Typing into ${a.element || "field"}`;
    case "browser_snapshot":
      return `Reading page content`;
    case "browser_take_screenshot":
      return `Taking screenshot`;
    // MCP tools with server prefix
    default:
      if (isPublicFirstPartyToolName(toolName)) {
        const label = humanizeToolName(toolName).toLowerCase();
        return `Running ${label}`;
      }
      if (toolName.startsWith("playwright-"))
        return `Browser: ${toolName.replace("playwright-", "").replace(/_/g, " ")}`;
      return null; // Skip unknown/noisy tools
  }
}

function formatShellCommandSummary(command: string | undefined): string | null {
  const normalized = command?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return `Running ${normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized}`;
}
