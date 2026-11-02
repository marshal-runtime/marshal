/**
 * Plain-English labels + descriptions for permission toggles.
 * Generated from tool-labels-and-descriptions-2026-05-31.md.
 *
 * Wiring:
 *   - getToolDescription(key)  → render description under any toggle / header.
 *   - getToolLabel(key)        → returns the spec label, except for keys in
 *                                BLOCKED_LABEL_KEYS where an upstream PR owns
 *                                the rendered text.
 */

export interface ToolPlainCopy {
  label: string;
  description: string;
}

const BLOCKED_LABEL_KEYS: ReadonlySet<string> = new Set([
  "shell",
  "serverAutoApprove",
  "shellAutoApprove",
]);

export const TOOL_PLAIN_COPY: Record<string, ToolPlainCopy> = {
  "tool:read": {
    label: "File Read (view / grep / glob)",
    description:
      "Lets Marshal read files with the built-in view, grep, and glob tools without asking each time.",
  },
  autoApproveReadOnly: {
    label: "Auto-approve read-only operations",
    description:
      "Enables Marshal to skip the approval prompt for read-only actions like reading emails or searching files.",
  },
  filesystem: {
    label: "File System Access",
    description:
      "Enables Marshal to open, read, create, edit, rename, and move files on your computer.",
  },
  playwright: {
    label: "Browser Control",
    description:
      "Enables Marshal to open and use a web browser on your behalf, including opening websites, clicking buttons, typing into forms, downloading files, and taking screenshots.",
  },
  "playwright-auto-approve": {
    label: "Browser Control auto-approve",
    description:
      "Carries out browser actions without stopping to ask you to confirm each one. This covers opening websites, clicking buttons, typing into forms, downloading files, and taking screenshots. Only turn this on if you trust the tasks Marshal is being asked to do.",
  },
  shell: {
    label: "Shell",
    description:
      "Enables Marshal to run programs and commands on your computer. This is broad: it covers creating, changing, and deleting files, installing or removing software, and changing system settings.",
  },
  interceptFileChooser: {
    label: "Allow agent file uploads",
    description:
      "Attaches files from your computer to upload fields in the browser on your behalf, without asking you each time.",
  },
  shellAllowPatterns: {
    label: "Approved patterns",
    description:
      "The list of computer commands Marshal is allowed to run without asking you each time. This includes commands you previously approved when prompted. You can add new ones, change them, or remove any you no longer want allowed.",
  },
  // Restored after PR review: the v2 spec dropped these
  // entries, but PermissionsEditor.tsx and ToolGroupSection.tsx both read
  // getToolDescription("serverAutoApprove") / ("shellAutoApprove") to render
  // the description under the "Auto-approve without asking" sub-row. Without
  // them, every sub-row showed a bare label. Labels are upstream-owned;
  // only the descriptions are consumed. PermissionsEditor.tsx selects
  // shellAutoApprove for the Shell row and serverAutoApprove for everything else.
  serverAutoApprove: {
    label: "Auto-approve all",
    description:
      "Runs every tool from this server without stopping to ask for your approval at each step.",
  },
  shellAutoApprove: {
    label: "Auto-approve all (Shell row override)",
    description: "Runs shell commands without stopping to ask for your approval at each step.",
  },
  "tool:memory": {
    label: "Memory",
    description:
      "Save, look up, and manage long-term memory so future conversations are more relevant.",
  },
  "tool:automations": {
    label: "Automations",
    description: "Create, list, read, change, run, and remove Automations.",
  },
  "tool:skills": {
    label: "Skills",
    description: "List, read, create, change, and remove your Skills.",
  },
  "tool:settings": {
    label: "Settings",
    description: "Read the current app settings and change them on your behalf.",
  },
  "tool:sessions": {
    label: "Sessions",
    description: "Look through your past conversations and delete any you no longer want.",
  },
  "tool:models": {
    label: "Models",
    description: "See available AI Models, change the default, and switch soul presets.",
  },
  "tool:runningTools": {
    label: "Running Tools",
    description: "List, inspect, and cancel tool calls that are running in the background.",
  },
  "tool:notifications": {
    label: "Notifications",
    description:
      "Connect, disconnect, and send proactive notifications through the configured provider.",
  },
  "tool:workflows": {
    label: "Workflows",
    description:
      "Discover, run, inspect, retry, cancel, and exchange state or artifacts with workflows.",
  },
  "tool:goals": {
    label: "Goals",
    description: "Manage autonomous goals, progress, questions, decisions, and status.",
  },
  "tool:localFiles": {
    label: "Local Files",
    description: "List, inspect, create, and move files or folders on this computer.",
  },
  "tool:uiActions": {
    label: "UI Actions",
    description:
      "Pause and ask you to pick from a set of options when input is needed, rather than guessing.",
  },
  "tool:agentControl": {
    label: "Agent Control",
    description: "Pause briefly while waiting for another operation or agent to finish.",
  },
  remember: {
    label: "Save something to memory",
    description:
      "Saves a fact, preference, or decision to long-term memory so it can be used in future conversations.",
  },
  recall: {
    label: "Look up saved memory",
    description: "Looks up what has been saved about you to give more relevant answers.",
  },
  listMemories: {
    label: "List all saved memory",
    description: "Reads everything that has been saved about you.",
  },
  forget: {
    label: "Delete a saved memory",
    description: "Permanently deletes a specific saved memory.",
  },
  listAutomations: {
    label: "List Automations",
    description: "Reads all your Automations and their settings.",
  },
  getAutomation: {
    label: "Read an Automation",
    description:
      "Reads the full details of a specific Automation, including its step-by-step instructions.",
  },
  createAutomation: {
    label: "Create an Automation",
    description: "Sets up a new Automation that runs on a schedule or when a condition is met.",
  },
  updateAutomation: {
    label: "Change an Automation",
    description:
      "Changes the name, schedule, instructions, or on/off state of an existing Automation.",
  },
  deleteAutomation: {
    label: "Delete an Automation",
    description: "Permanently removes an Automation.",
  },
  runAutomationNow: {
    label: "Run an Automation now",
    description: "Runs an Automation right now, outside its normal schedule.",
  },
  listSkills: {
    label: "List Skills",
    description:
      "Reads all the Skills available, including built-in ones and any you have created.",
  },
  getSkill: {
    label: "Read a Skill",
    description: "Reads the full set of instructions for one of your Skills.",
  },
  createSkill: {
    label: "Create a Skill",
    description: "Creates a new personal Skill, a saved set of instructions that runs on demand.",
  },
  updateSkill: {
    label: "Change a Skill",
    description: "Changes the name, description, or instructions of a Skill you created.",
  },
  deleteSkill: {
    label: "Delete a Skill",
    description:
      "Permanently removes a Skill you created. Skills that come pre-installed cannot be deleted.",
  },
  getSettings: {
    label: "Read current settings",
    description: "Reads the current app settings.",
  },
  updateSettings: {
    label: "Change app settings",
    description:
      "Updates app settings on your behalf, for example changing the window mode or turning on an experiment.",
  },
  requestPermissionEscalation: {
    label: "Request a permission change",
    description:
      "Asks for your approval to change a sensitive permission setting, via a consent card in the chat.",
  },
  searchSessions: {
    label: "Search past conversations",
    description:
      "Searches across your past conversations by keyword to find something you discussed before.",
  },
  getSessionTranscript: {
    label: "Read a past conversation",
    description: "Reads the full message history of a specific past conversation.",
  },
  deleteSession: {
    label: "Delete a past conversation",
    description: "Permanently deletes a conversation from your history.",
  },
  listModels: {
    label: "List available AI Models",
    description: "Reads which AI Models are available.",
  },
  setDefaultModel: {
    label: "Change the default AI Model",
    description: "Sets which AI Model is used by default for new conversations.",
  },
  getCurrentModel: {
    label: "Check current AI Model",
    description: "Reads which AI Model is being used right now and what the default is.",
  },
  listSouls: {
    label: "List soul presets",
    description: "Reads the available soul presets.",
  },
  setSoul: {
    label: "Change the default soul",
    description: "Sets the default soul style for new conversations.",
  },
  notificationStatus: {
    label: "Check notification status",
    description: "Checks whether the configured notification provider is connected.",
  },
  connectNotifications: {
    label: "Connect notifications",
    description: "Connects the configured provider so proactive notifications can be sent.",
  },
  disconnectNotifications: {
    label: "Disconnect notifications",
    description: "Disconnects the configured notification provider until you reconnect.",
  },
  sendNotification: {
    label: "Send a notification",
    description: "Sends a proactive message through the configured notification provider.",
  },
  askUser: {
    label: "Ask you to pick an option",
    description: "Pauses and shows you a list of options to pick from.",
  },
  browser_navigate: {
    label: "Open a website",
    description: "Opens a website on your behalf.",
  },
  browser_navigate_back: {
    label: "Go back a page",
    description: "Goes back to the previous page in the browser.",
  },
  browser_snapshot: {
    label: "See what is on the page",
    description:
      "Captures an accessibility snapshot of the current web page so its structure and content can be understood.",
  },
  browser_click: {
    label: "Click something on a page",
    description: "Clicks on something on a web page, like a button or link, on your behalf.",
  },
  browser_hover: {
    label: "Hover over something",
    description: "Hovers over something on a web page, without clicking it.",
  },
  browser_drag: {
    label: "Drag something on a page",
    description: "Drags something on a web page from one place to another, on your behalf.",
  },
  browser_type: {
    label: "Type into a page",
    description: "Types into a box on a web page on your behalf.",
  },
  browser_press_key: {
    label: "Press a key in the browser",
    description: "Presses a key on the keyboard while using the browser, like Enter or Tab.",
  },
  browser_fill_form: {
    label: "Fill in a form",
    description: "Fills in a form on a web page on your behalf.",
  },
  browser_select_option: {
    label: "Pick an item from a list",
    description: "Picks an item from a list on a web page.",
  },
  browser_take_screenshot: {
    label: "Take a screenshot",
    description: "Takes a picture of the current web page so it can be seen.",
  },
  browser_file_upload: {
    label: "Upload a file to a page",
    description: "Attaches a file from your computer to a web page on your behalf.",
  },
  browser_handle_dialog: {
    label: "Respond to a pop-up",
    description: "Responds to a pop-up message from a web page on your behalf.",
  },
  browser_tabs: {
    label: "Manage browser tabs",
    description: "Opens, closes, or switches between tabs in the browser.",
  },
  browser_close: {
    label: "Close the current page",
    description: "Closes the current web page or tab.",
  },
  browser_console_messages: {
    label: "Read developer console messages",
    description:
      "Reads the browser developer console messages (logs, warnings, and errors) that the current web page has written.",
  },
  browser_network_requests: {
    label: "See network requests",
    description:
      "Reads the network requests the current web page has made since it loaded, including the URLs called and their response status.",
  },
  browser_evaluate: {
    label: "Run JavaScript on a page",
    description: "Runs a small piece of JavaScript inside the current web page on your behalf.",
  },
  browser_run_code: {
    label: "Run a Playwright script",
    description:
      "Runs a short Playwright script that drives the browser through several steps at once, such as navigating, clicking, typing, and reading the page.",
  },
  browser_run_code_unsafe: {
    label: "Run an unrestricted script",
    description:
      "Runs an unrestricted Playwright or JavaScript script in the browser on your behalf. This script can do anything the browser can do, including reading any data on a page, opening any site, and interacting with any signed-in service.",
  },
  browser_resize: {
    label: "Resize the browser window",
    description: "Changes the size of the browser window.",
  },
  browser_wait_for: {
    label: "Wait for something on the page",
    description:
      "Waits for something to appear or disappear on a web page, or waits a set amount of time.",
  },
};

/**
 * Look up the {label, description} pair for a permission toggle.
 *
 * Tool and MCP permission prefixes are stripped for plain-copy lookup.
 */
export function getToolCopy(key: string): ToolPlainCopy | undefined {
  if (TOOL_PLAIN_COPY[key]) return TOOL_PLAIN_COPY[key];

  const prefixes = ["tool:", "mcp:"];
  for (const p of prefixes) {
    if (!key.startsWith(p)) continue;
    const bare = key.slice(p.length);
    if (TOOL_PLAIN_COPY[bare]) return TOOL_PLAIN_COPY[bare];
    const lastColon = bare.lastIndexOf(":");
    if (lastColon !== -1) {
      const tail = bare.slice(lastColon + 1);
      if (TOOL_PLAIN_COPY[tail]) return TOOL_PLAIN_COPY[tail];
    }
  }

  return undefined;
}

export function getToolLabel(key: string): string | undefined {
  if (BLOCKED_LABEL_KEYS.has(key)) return undefined;
  return getToolCopy(key)?.label;
}

export function getToolDescription(key: string): string | undefined {
  return getToolCopy(key)?.description;
}
