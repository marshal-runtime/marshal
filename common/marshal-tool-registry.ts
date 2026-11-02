import { FIRST_PARTY_TOOL_NAMES as TOOL } from "./tool-names";

export interface ToolGroupDef {
  key: string;
  name: string;
  toolNames: string[];
}

export interface ToolCategoryDef {
  key: string;
  name: string;
  groups: ToolGroupDef[];
}

/**
 * Known tool lists for built-in MCP servers.
 * These are static (shipped with the app), not discovered at runtime.
 */
export const MCP_BUILTIN_TOOLS: Record<string, Array<{ name: string; description: string }>> = {
  playwright: [
    { name: "browser_navigate", description: "Navigate to a URL" },
    { name: "browser_navigate_back", description: "Go back to the previous page" },
    { name: "browser_snapshot", description: "Capture accessibility snapshot of the page" },
    { name: "browser_click", description: "Click an element on the page" },
    { name: "browser_hover", description: "Hover over an element" },
    { name: "browser_drag", description: "Drag an element to another location" },
    { name: "browser_type", description: "Type text into an editable element" },
    { name: "browser_press_key", description: "Press a keyboard key or combination" },
    { name: "browser_fill_form", description: "Fill out an entire form" },
    { name: "browser_select_option", description: "Select an option in a dropdown" },
    { name: "browser_take_screenshot", description: "Take a screenshot of the page" },
    { name: "browser_file_upload", description: "Upload files via file chooser" },
    { name: "browser_handle_dialog", description: "Handle JavaScript dialogs" },
    { name: "browser_tabs", description: "List browser tabs" },
    { name: "browser_close", description: "Close the browser" },
    { name: "browser_console_messages", description: "Get browser console messages" },
    { name: "browser_network_requests", description: "Get network requests" },
    { name: "browser_evaluate", description: "Execute JavaScript in the browser" },
    { name: "browser_run_code", description: "Execute JavaScript code" },
    { name: "browser_run_code_unsafe", description: "Execute unsafe Playwright code" },
    { name: "browser_resize", description: "Resize the browser window" },
    { name: "browser_wait_for", description: "Wait for text to appear on the page" },
  ],
};

export const APP_TOOLS_CATEGORY: ToolCategoryDef = {
  key: "app",
  name: "App Tools",
  groups: [
    {
      key: "runningTools",
      name: "Running Tools",
      toolNames: [TOOL.listRunningTools, TOOL.inspectRunningTool, TOOL.cancelRunningTool],
    },
    {
      key: "memory",
      name: "Memory",
      toolNames: [TOOL.remember, TOOL.recall, TOOL.listMemories, TOOL.forget],
    },
    {
      key: "automations",
      name: "Automations",
      toolNames: [
        TOOL.listAutomations,
        TOOL.getAutomation,
        TOOL.createAutomation,
        TOOL.updateAutomation,
        TOOL.deleteAutomation,
        TOOL.runAutomationNow,
      ],
    },
    {
      key: "skills",
      name: "Skills",
      toolNames: [
        TOOL.listSkills,
        TOOL.getSkill,
        TOOL.createSkill,
        TOOL.updateSkill,
        TOOL.deleteSkill,
      ],
    },
    {
      key: "settings",
      name: "Settings",
      toolNames: [TOOL.getSettings, TOOL.updateSettings, TOOL.requestPermissionEscalation],
    },
    {
      key: "sessions",
      name: "Sessions",
      toolNames: [
        TOOL.searchSessions,
        TOOL.getSessionTranscript,
        TOOL.setSessionTodos,
        TOOL.publishRelayMessage,
        TOOL.deleteSession,
        TOOL.listWorkspaces,
        TOOL.registerWorkspace,
        TOOL.listRepositoryAgents,
        TOOL.spawnSubagent,
        TOOL.spawnSubagents,
        TOOL.listSubagents,
        TOOL.messageSubagent,
        TOOL.cancelQueuedSubagentMessages,
        TOOL.messageParent,
      ],
    },
    {
      key: "models",
      name: "Models",
      toolNames: [
        TOOL.listModels,
        TOOL.setDefaultModel,
        TOOL.getCurrentModel,
        TOOL.listSouls,
        TOOL.setSoul,
      ],
    },
    {
      key: "notifications",
      name: "Notifications",
      toolNames: [
        TOOL.notificationStatus,
        TOOL.connectNotifications,
        TOOL.disconnectNotifications,
        TOOL.sendNotification,
      ],
    },
    {
      key: "workflows",
      name: "Dynamic Workflows",
      toolNames: [
        TOOL.workflowList,
        TOOL.workflowRun,
        TOOL.workflowGetRun,
        TOOL.workflowListState,
        TOOL.workflowReadState,
        TOOL.workflowListArtifacts,
        TOOL.workflowReadArtifact,
        TOOL.workflowSaveArtifact,
        TOOL.workflowCancel,
        TOOL.workflowRetryFromStep,
        TOOL.workflowDescribe,
      ],
    },
    {
      key: "uiActions",
      name: "UI Actions",
      toolNames: [TOOL.askUser],
    },
    {
      key: "agentControl",
      name: "Agent Control",
      toolNames: [TOOL.sleep],
    },
    {
      key: "goals",
      name: "Goals",
      toolNames: [
        TOOL.goalGet,
        TOOL.goalSet,
        TOOL.goalUpdateDefinition,
        TOOL.goalUpdateContext,
        TOOL.goalProposeTransition,
      ],
    },
    {
      key: "localFiles",
      name: "Local Files",
      toolNames: [
        TOOL.listLocalFiles,
        TOOL.getLocalFileTree,
        TOOL.statLocalPath,
        TOOL.createLocalDirectory,
        TOOL.moveLocalPath,
      ],
    },
  ],
};

/**
 * Self-tools auto-approved by default for new installs.
 * Only internal app operations (read-only "list", "get", "search", "status", "recall").
 *
 * Related: READ_ONLY_CUSTOM_TOOLS in electron/permission-policy.ts is the superset
 * used when autoApproveReadOnly is on.
 */
export const DEFAULT_TOOL_APPROVALS: Record<string, boolean> = {
  [`tool:${TOOL.listRunningTools}`]: true,
  [`tool:${TOOL.inspectRunningTool}`]: true,
  [`tool:${TOOL.recall}`]: true,
  [`tool:${TOOL.listMemories}`]: true,
  [`tool:${TOOL.listAutomations}`]: true,
  [`tool:${TOOL.getAutomation}`]: true,
  [`tool:${TOOL.listSkills}`]: true,
  [`tool:${TOOL.getSkill}`]: true,
  [`tool:${TOOL.getSettings}`]: true,
  [`tool:${TOOL.searchSessions}`]: true,
  [`tool:${TOOL.getSessionTranscript}`]: true,
  // Deliberate session-scoped egress. PermissionPolicy classifies this as
  // mutating; default approval is intentional because the tool name is the
  // model's explicit publication act and relay-origin turns are source-bound.
  [`tool:${TOOL.publishRelayMessage}`]: true,
  [`tool:${TOOL.listWorkspaces}`]: true,
  [`tool:${TOOL.listRepositoryAgents}`]: true,
  [`tool:${TOOL.listSubagents}`]: true,
  [`tool:${TOOL.messageSubagent}`]: true,
  [`tool:${TOOL.cancelQueuedSubagentMessages}`]: true,
  [`tool:${TOOL.messageParent}`]: true,
  [`tool:${TOOL.listModels}`]: true,
  [`tool:${TOOL.getCurrentModel}`]: true,
  [`tool:${TOOL.listSouls}`]: true,
  [`tool:${TOOL.notificationStatus}`]: true,
  [`tool:${TOOL.workflowList}`]: true,
  [`tool:${TOOL.workflowGetRun}`]: true,
  [`tool:${TOOL.workflowListState}`]: true,
  [`tool:${TOOL.workflowReadState}`]: true,
  [`tool:${TOOL.workflowListArtifacts}`]: true,
  [`tool:${TOOL.workflowReadArtifact}`]: true,
  [`tool:${TOOL.workflowDescribe}`]: true,
  [`tool:${TOOL.workflowSaveArtifact}`]: true,
  [`tool:${TOOL.goalGet}`]: true,
  [`tool:${TOOL.askUser}`]: true,
  // Sleep/rest is a benign control tool (no I/O, no state change, no egress) —
  // auto-approved so the model can rest while waiting without a permission
  // prompt, including during unattended goal pursuit.
  [`tool:${TOOL.sleep}`]: true,
  // Notification dispatch: the tool name is its consent. Blast radius is
  // bounded to the configured notification destination. Default-approved so auto-mode
  // automations dispatch without a per-run permission overlay; users who want
  // friction can override with `tool:sendNotification: false` in global perms.
  [`tool:${TOOL.sendNotification}`]: true,
};

// Build a lookup map from tool key → group key for static tools
const TOOL_TO_GROUP = new Map<string, string>();
export const FIRST_PARTY_TOOL_GROUP_KEYS = new Set<string>();
for (const group of APP_TOOLS_CATEGORY.groups) {
  FIRST_PARTY_TOOL_GROUP_KEYS.add(group.key);
  for (const toolName of group.toolNames) {
    TOOL_TO_GROUP.set(`tool:${toolName}`, `tool:${group.key}`);
  }
}

export function getStaticToolGroupKey(toolKey: string): string | null {
  return TOOL_TO_GROUP.get(toolKey) ?? null;
}

/**
 * Resolve a tool key to its group key.
 * MCP tools: drop last segment (mcp:filesystem:read_file → mcp:filesystem)
 * Static tools: use registry lookup (tool:listSkills → tool:skills)
 */
export function getToolGroupKey(toolKey: string): string | null {
  // MCP tools: everything before the last colon is the group key.
  // This handles server names that contain colons (e.g. mcp:my:server:tool → mcp:my:server).
  if (toolKey.startsWith("mcp:")) {
    const lastColon = toolKey.lastIndexOf(":");
    // Must have at least "mcp:" + something + ":" + tool
    if (lastColon > 4) {
      return toolKey.slice(0, lastColon);
    }
    return null;
  }
  // Static tools: use registry lookup
  return TOOL_TO_GROUP.get(toolKey) ?? null;
}
