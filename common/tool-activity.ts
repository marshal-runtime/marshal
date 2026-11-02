import type { ToolActivityKind } from "./marshal-ipc-contract";
import {
  canonicalizeFirstPartyToolName,
  FIRST_PARTY_TOOL_NAMES,
  humanizeToolName,
  isLocalFileToolName,
} from "./tool-names";

export interface ToolActivityCopy {
  active: string;
  completed: string;
}

const BROWSER_READ_TOOLS = new Set([
  "browser_snapshot",
  "browser_console_messages",
  "browser_network_requests",
  "browser_tabs",
  "browser_hover",
  "browser_wait_for",
]);

const BROWSER_MUTATION_TOOLS = new Set([
  "browser_navigate",
  "browser_navigate_back",
  "browser_click",
  "browser_drag",
  "browser_type",
  "browser_press_key",
  "browser_fill_form",
  "browser_select_option",
  "browser_take_screenshot",
  "browser_file_upload",
  "browser_handle_dialog",
  "browser_close",
  "browser_evaluate",
  "browser_run_code",
  "browser_run_code_unsafe",
  "browser_resize",
]);

const READ_TOOL_NAMES = new Set([
  "view",
  "read",
  "read_file",
  "read_text_file",
  "filesystem__read_file",
  "filesystem__read_text_file",
  "grep",
  "rg",
  "glob",
  "web_search",
  "web_fetch",
]);

const MUTATION_TOOL_NAMES = new Set([
  "edit",
  "create",
  "write_file",
  "create_file",
  "apply_patch",
  "move",
  "move_file",
]);

const COMMAND_TOOL_NAMES = new Set([
  "bash",
  "powershell",
  "pwsh",
  "shell",
  "command",
  "functions.powershell",
]);

const TOOL_ACTIVITY_COPY: Readonly<Record<string, ToolActivityCopy>> = {
  browser_snapshot: {
    active: "Reading page content",
    completed: "Read page content",
  },
  browser_click: {
    active: "Clicking something on the page",
    completed: "Clicked something on the page",
  },
};

export function normalizeActivityToolName(toolName: unknown): string {
  if (typeof toolName !== "string") return "";
  const canonicalFirstParty = canonicalizeFirstPartyToolName(toolName);

  const mcpSegments = canonicalFirstParty.split(":");
  const leafName =
    mcpSegments.length > 1
      ? (mcpSegments[mcpSegments.length - 1] ?? canonicalFirstParty)
      : canonicalFirstParty;
  return leafName.replace(/^playwright[-_]+/, "");
}

export function humanizeActivityToolName(toolName: unknown): string {
  return humanizeToolName(normalizeActivityToolName(toolName));
}

export function classifyToolActivityKind(toolName: string): ToolActivityKind {
  const normalized = normalizeActivityToolName(toolName);
  if (isLocalFileToolName(normalized)) {
    return normalized === FIRST_PARTY_TOOL_NAMES.createLocalDirectory ||
      normalized === FIRST_PARTY_TOOL_NAMES.moveLocalPath
      ? "mutation"
      : "read";
  }
  if (BROWSER_MUTATION_TOOLS.has(normalized)) return "mutation";
  if (BROWSER_READ_TOOLS.has(normalized)) return "read";
  if (MUTATION_TOOL_NAMES.has(normalized)) return "mutation";
  if (READ_TOOL_NAMES.has(normalized)) return "read";
  if (COMMAND_TOOL_NAMES.has(normalized)) return "command";
  return "other";
}

export function getToolActivityCopy(toolName: string): ToolActivityCopy | undefined {
  const normalized = normalizeActivityToolName(toolName);
  const explicit = Object.hasOwn(TOOL_ACTIVITY_COPY, normalized)
    ? TOOL_ACTIVITY_COPY[normalized]
    : undefined;
  if (explicit) return explicit;
  if (BROWSER_MUTATION_TOOLS.has(normalized) || MUTATION_TOOL_NAMES.has(normalized)) {
    return deriveActionCopy(normalized);
  }
  return undefined;
}

export function isCancelledToolError(error?: string): boolean {
  return /(cancel|abort|stopp?ed)/i.test(error ?? "");
}

export function isTrustedCommandToolName(toolName: string): boolean {
  return COMMAND_TOOL_NAMES.has(normalizeActivityToolName(toolName));
}

const ACTION_VERBS: Readonly<Record<string, { active: string; completed: string }>> = {
  cancel: { active: "Cancelling", completed: "Cancelled" },
  click: { active: "Clicking", completed: "Clicked" },
  close: { active: "Closing", completed: "Closed" },
  complete: { active: "Completing", completed: "Completed" },
  create: { active: "Creating", completed: "Created" },
  delete: { active: "Deleting", completed: "Deleted" },
  drag: { active: "Dragging", completed: "Dragged" },
  evaluate: { active: "Evaluating", completed: "Evaluated" },
  fill: { active: "Filling", completed: "Filled" },
  forward: { active: "Forwarding", completed: "Forwarded" },
  handle: { active: "Handling", completed: "Handled" },
  mark: { active: "Marking", completed: "Marked" },
  move: { active: "Moving", completed: "Moved" },
  navigate: { active: "Navigating", completed: "Navigated" },
  reply: { active: "Replying", completed: "Replied" },
  resize: { active: "Resizing", completed: "Resized" },
  respond: { active: "Responding", completed: "Responded" },
  run: { active: "Running", completed: "Ran" },
  select: { active: "Selecting", completed: "Selected" },
  send: { active: "Sending", completed: "Sent" },
  take: { active: "Taking", completed: "Took" },
  type: { active: "Typing", completed: "Typed" },
  update: { active: "Updating", completed: "Updated" },
  upload: { active: "Uploading", completed: "Uploaded" },
};

function deriveActionCopy(toolName: string): ToolActivityCopy | undefined {
  const words = humanizeActivityToolName(toolName).toLowerCase().split(/\s+/);
  const verb = words.shift();
  if (!verb) return undefined;
  const conjugation = Object.hasOwn(ACTION_VERBS, verb) ? ACTION_VERBS[verb] : undefined;
  if (!conjugation) return undefined;
  const object = words.join(" ");
  return {
    active: object ? `${conjugation.active} ${object}` : conjugation.active,
    completed: object ? `${conjugation.completed} ${object}` : conjugation.completed,
  };
}
