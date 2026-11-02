import type { CapabilityDescriptor } from "@marshal/runtime";

export interface BrowserCommandAdapter {
  readonly target: string;
  readonly title: string;
  readonly description: string;
  readonly risk: "low" | "medium" | "high";
  readonly inputSchema: NonNullable<CapabilityDescriptor["inputSchema"]>;
}

export const MARSHAL_BROWSER_COMMAND_ADAPTERS = Object.freeze({
  browser_navigate: {
    target: "browser_navigate",
    title: "Navigate to a URL",
    description: "Navigate Agentic Browser to a URL.",
    risk: "high",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: { url: { type: "string", minLength: 1 } },
    },
  },
  browser_click: {
    target: "browser_click",
    title: "Click an element",
    description: "Click an element by CSS selector or viewport coordinates.",
    risk: "medium",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        selector: { type: "string", minLength: 1 },
        x: { type: "number" },
        y: { type: "number" },
        doubleClick: { type: "boolean" },
        button: { enum: ["left", "right", "middle"] },
        modifiers: {
          type: "array",
          items: { enum: ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"] },
        },
      },
    },
  },
  browser_type: {
    target: "browser_type",
    title: "Type text",
    description: "Type text into a CSS-selected element, or at the current cursor.",
    risk: "high",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        selector: { type: "string", minLength: 1 },
        text: { type: "string" },
        clearFirst: { type: "boolean" },
      },
    },
  },
  browser_select: {
    target: "browser_select_option",
    title: "Select an option",
    description: "Select values in a dropdown identified by a page snapshot reference.",
    risk: "medium",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ref", "values"],
      properties: {
        ref: { type: "string", minLength: 1 },
        element: { type: "string" },
        values: { type: "array", minItems: 1, items: { type: "string" } },
      },
    },
  },
  browser_hover: {
    target: "browser_hover",
    title: "Hover over an element",
    description: "Hover over an element identified by an exact page snapshot reference.",
    risk: "medium",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ref"],
      properties: {
        ref: { type: "string", minLength: 1 },
        element: { type: "string" },
      },
    },
  },
  browser_go_back: {
    target: "browser_navigate_back",
    title: "Go back",
    description: "Navigate to the previous page in Agentic Browser history.",
    risk: "medium",
    inputSchema: { type: "object", additionalProperties: false },
  },
  browser_screenshot: {
    target: "browser_take_screenshot",
    title: "Take a screenshot",
    description: "Capture a PNG or JPEG screenshot of the current page.",
    risk: "low",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fullPage: { type: "boolean" },
        format: { enum: ["png", "jpeg"] },
      },
    },
  },
  browser_accessibility_tree: {
    target: "browser_snapshot",
    title: "Capture page snapshot",
    description: "Capture the current page's accessibility snapshot.",
    risk: "low",
    inputSchema: { type: "object", additionalProperties: false },
  },
  browser_create_tab: {
    target: "browser_tabs",
    title: "Create a tab",
    description: "Create a new Agentic Browser tab.",
    risk: "medium",
    inputSchema: { type: "object", additionalProperties: false },
  },
  browser_close_tab: {
    target: "browser_tabs",
    title: "Close a tab",
    description: "Close the current Agentic Browser tab or a tab selected by zero-based index.",
    risk: "medium",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { index: { type: "integer", minimum: 0 } },
    },
  },
  browser_switch_tab: {
    target: "browser_tabs",
    title: "Select a tab",
    description: "Select an Agentic Browser tab by zero-based index.",
    risk: "medium",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["index"],
      properties: { index: { type: "integer", minimum: 0 } },
    },
  },
  browser_list_tabs: {
    target: "browser_tabs",
    title: "List tabs",
    description: "List Agentic Browser tabs.",
    risk: "low",
    inputSchema: { type: "object", additionalProperties: false },
  },
  browser_handle_dialog: {
    target: "browser_handle_dialog",
    title: "Handle a dialog",
    description: "Accept or dismiss the current Playwright browser dialog.",
    risk: "medium",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { enum: ["accept", "dismiss"] },
        promptText: { type: "string" },
      },
    },
  },
  browser_execute_script: {
    target: "browser_evaluate",
    title: "Evaluate JavaScript",
    description: "Evaluate a JavaScript expression or function in the current page.",
    risk: "high",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["script"],
      properties: { script: { type: "string", minLength: 1 } },
    },
  },
  browser_console: {
    target: "browser_console_messages",
    title: "Get console messages",
    description: "Return Agentic Browser console messages at or above the requested level.",
    risk: "low",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        level: { enum: ["error", "warning", "info", "debug"] },
      },
    },
  },
  browser_file_upload: {
    target: "browser_file_upload",
    title: "Upload files",
    description: "Upload files through the current Agentic Browser page.",
    risk: "high",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        filePaths: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
  },
} as const satisfies Record<string, BrowserCommandAdapter>);

export type MarshalBrowserCommandName = keyof typeof MARSHAL_BROWSER_COMMAND_ADAPTERS;

const AGENTIC_BROWSER_COMMANDS = new Set([
  "browser_accessibility_tree",
  "browser_click",
  "browser_close_tab",
  "browser_console",
  "browser_create_tab",
  "browser_execute_script",
  "browser_extract_data",
  "browser_file_upload",
  "browser_get_html",
  "browser_get_metadata",
  "browser_get_storage",
  "browser_go_back",
  "browser_go_forward",
  "browser_handle_dialog",
  "browser_hover",
  "browser_keyboard",
  "browser_list_tabs",
  "browser_list_targets",
  "browser_modify_css",
  "browser_modify_html",
  "browser_navigate",
  "browser_profile_info",
  "browser_reload",
  "browser_screenshot",
  "browser_scroll",
  "browser_select",
  "browser_shutdown",
  "browser_switch_tab",
  "browser_type",
  "browser_wait_for_condition",
  "browser_wait_for_navigation",
  "browser_wait_for_network_idle",
  "browser_wait_for_selector",
]);

export function isMarshalBrowserCommandName(value: string): boolean {
  return AGENTIC_BROWSER_COMMANDS.has(value);
}

export function adaptMarshalBrowserCommand(
  command: string,
  input: Readonly<Record<string, unknown>>,
): { readonly toolName: string; readonly input: Readonly<Record<string, unknown>> } {
  if (!isMarshalBrowserCommandName(command)) {
    throw new Error(`Unsupported Marshal browser command: ${command}.`);
  }
  const adapter = (MARSHAL_BROWSER_COMMAND_ADAPTERS as Record<string, BrowserCommandAdapter>)[
    command
  ];
  if (!adapter) return { toolName: command, input };
  switch (command) {
    case "browser_navigate":
      requireKeys(input, ["url"], command);
      return {
        toolName: adapter.target,
        input: { url: requiredString(input, "url", command) },
      };
    case "browser_click": {
      requireKeys(input, ["selector", "x", "y", "doubleClick", "button", "modifiers"], command);
      const selector = optionalString(input, "selector", command);
      const x = optionalNumber(input, "x", command);
      const y = optionalNumber(input, "y", command);
      if (!selector && (x === undefined || y === undefined)) {
        throw new Error(`${command} requires selector or both x and y.`);
      }
      const doubleClick = optionalBoolean(input, "doubleClick", command);
      const button = optionalEnum(input, "button", ["left", "right", "middle"], command);
      const modifiers = optionalEnumArray(
        input,
        "modifiers",
        ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"],
        command,
      );
      return {
        toolName: adapter.target,
        input: {
          ...(selector === undefined ? {} : { selector }),
          ...(x === undefined ? {} : { x }),
          ...(y === undefined ? {} : { y }),
          ...(doubleClick === undefined ? {} : { doubleClick }),
          ...(button === undefined ? {} : { button }),
          ...(modifiers === undefined ? {} : { modifiers }),
        },
      };
    }
    case "browser_type": {
      requireKeys(input, ["selector", "text", "clearFirst"], command);
      const selector = optionalString(input, "selector", command);
      const text = requiredText(input, "text", command);
      const clearFirst = optionalBoolean(input, "clearFirst", command);
      return {
        toolName: adapter.target,
        input: {
          text,
          ...(selector === undefined ? {} : { selector }),
          ...(clearFirst === undefined ? {} : { clearFirst }),
        },
      };
    }
    case "browser_select": {
      requireKeys(input, ["ref", "element", "values"], command);
      const ref = requiredString(input, "ref", command);
      const values = requiredStringArray(input, "values", command);
      const element = optionalString(input, "element", command);
      return {
        toolName: adapter.target,
        input: { ref, values, ...(element === undefined ? {} : { element }) },
      };
    }
    case "browser_hover": {
      requireKeys(input, ["ref", "element"], command);
      const ref = requiredString(input, "ref", command);
      const element = optionalString(input, "element", command);
      return {
        toolName: adapter.target,
        input: { ref, ...(element === undefined ? {} : { element }) },
      };
    }
    case "browser_go_back":
    case "browser_accessibility_tree":
    case "browser_create_tab":
    case "browser_list_tabs":
      requireKeys(input, [], command);
      return {
        toolName: adapter.target,
        input:
          command === "browser_create_tab"
            ? { action: "new" }
            : command === "browser_list_tabs"
              ? { action: "list" }
              : {},
      };
    case "browser_close_tab": {
      requireKeys(input, ["index"], command);
      const index = optionalNonNegativeInteger(input, "index", command);
      return {
        toolName: adapter.target,
        input: { action: "close", ...(index === undefined ? {} : { index }) },
      };
    }
    case "browser_switch_tab":
      requireKeys(input, ["index"], command);
      return {
        toolName: adapter.target,
        input: {
          action: "select",
          index: requiredNonNegativeInteger(input, "index", command),
        },
      };
    case "browser_screenshot": {
      requireKeys(input, ["fullPage", "format"], command);
      const fullPage = optionalBoolean(input, "fullPage", command);
      const format = optionalEnum(input, "format", ["png", "jpeg"], command);
      return {
        toolName: adapter.target,
        input: {
          ...(fullPage === undefined ? {} : { fullPage }),
          ...(format === undefined ? {} : { type: format }),
        },
      };
    }
    case "browser_handle_dialog": {
      requireKeys(input, ["action", "promptText"], command);
      const action = requiredEnum(input, "action", ["accept", "dismiss"], command);
      const promptText = optionalString(input, "promptText", command);
      return {
        toolName: adapter.target,
        input: { accept: action === "accept", ...(promptText === undefined ? {} : { promptText }) },
      };
    }
    case "browser_execute_script":
      requireKeys(input, ["script"], command);
      return {
        toolName: adapter.target,
        input: { function: requiredString(input, "script", command) },
      };
    case "browser_console": {
      requireKeys(input, ["level"], command);
      const level = optionalEnum(input, "level", ["error", "warning", "info", "debug"], command);
      return {
        toolName: adapter.target,
        input: level === undefined ? {} : { level },
      };
    }
    case "browser_file_upload": {
      requireKeys(input, ["filePaths"], command);
      const paths = optionalStringArray(input, "filePaths", command);
      return {
        toolName: adapter.target,
        input: paths === undefined ? {} : { paths },
      };
    }
  }
  return { toolName: command, input };
}

function requiredString(
  input: Readonly<Record<string, unknown>>,
  key: string,
  command: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${command} requires a non-empty ${key}.`);
  }
  return value;
}

function requiredText(
  input: Readonly<Record<string, unknown>>,
  key: string,
  command: string,
): string {
  const value = input[key];
  if (typeof value !== "string") throw new TypeError(`${command} requires ${key} to be a string.`);
  return value;
}

function optionalString(
  input: Readonly<Record<string, unknown>>,
  key: string,
  command: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${command} requires ${key} to be a string.`);
  return value;
}

function optionalBoolean(
  input: Readonly<Record<string, unknown>>,
  key: string,
  command: string,
): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new TypeError(`${command} requires ${key} to be a boolean.`);
  }
  return value;
}

function optionalNumber(
  input: Readonly<Record<string, unknown>>,
  key: string,
  command: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${command} requires ${key} to be a finite number.`);
  }
  return value;
}

function optionalEnum<const T extends string>(
  input: Readonly<Record<string, unknown>>,
  key: string,
  values: readonly T[],
  command: string,
): T | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isEnumValue(value, values)) {
    throw new TypeError(`${command} received an invalid ${key}.`);
  }
  return value;
}

function requiredEnum<const T extends string>(
  input: Readonly<Record<string, unknown>>,
  key: string,
  values: readonly T[],
  command: string,
): T {
  const value = optionalEnum(input, key, values, command);
  if (value === undefined) throw new TypeError(`${command} requires ${key}.`);
  return value;
}

function optionalEnumArray<const T extends string>(
  input: Readonly<Record<string, unknown>>,
  key: string,
  values: readonly T[],
  command: string,
): readonly T[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is T => typeof entry === "string" && isEnumValue(entry, values))
  ) {
    throw new TypeError(`${command} received an invalid ${key}.`);
  }
  return value;
}

function isEnumValue<const T extends string>(value: string, values: readonly T[]): value is T {
  return values.some((candidate) => candidate === value);
}

function optionalStringArray(
  input: Readonly<Record<string, unknown>>,
  key: string,
  command: string,
): readonly string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new TypeError(`${command} requires ${key} to contain non-empty strings.`);
  }
  return value;
}

function requiredStringArray(
  input: Readonly<Record<string, unknown>>,
  key: string,
  command: string,
): readonly string[] {
  const value = optionalStringArray(input, key, command);
  if (!value || value.length === 0) {
    throw new TypeError(`${command} requires a non-empty ${key}.`);
  }
  return value;
}

function optionalNonNegativeInteger(
  input: Readonly<Record<string, unknown>>,
  key: string,
  command: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    throw new TypeError(`${command} requires ${key} to be a non-negative integer.`);
  }
  return value;
}

function requiredNonNegativeInteger(
  input: Readonly<Record<string, unknown>>,
  key: string,
  command: string,
): number {
  const value = optionalNonNegativeInteger(input, key, command);
  if (value === undefined) throw new TypeError(`${command} requires ${key}.`);
  return value;
}

function requireKeys(
  input: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  command: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(input).find((key) => !allowedSet.has(key));
  if (unexpected) throw new TypeError(`${command} does not support input property ${unexpected}.`);
}
