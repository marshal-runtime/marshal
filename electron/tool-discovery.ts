import type { ToolCategory, ToolGroup } from "../common/marshal-ipc-contract";
import {
  CONFIG_KEY_TO_DISPLAY_NAME,
  MCP_SERVER_CONFIG_KEYS,
} from "../common/marshal-permission-servers";
import { getServerForSdkTool, type SdkBuiltinToolName } from "../common/marshal-sdk-builtin-tools";
import { APP_TOOLS_CATEGORY, MCP_BUILTIN_TOOLS } from "../common/marshal-tool-registry";
import type { ToolGroupDef } from "../common/marshal-tool-registry";
import {
  isWorkServiceProviderDisabled,
  normalizeWorkServiceProviderSettings,
} from "../common/provider-config";
import type { WorkServiceProviderSettings } from "../common/provider-config";
import { MCP_CONFIG_KEY_TO_UI } from "./mcp-tools";

export interface WorkServiceToolAvailability {
  notificationsAvailable?: boolean;
}

function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Best-effort `name` extraction from the loosely-typed config blob stored
 *  in `mcpStore` (the schema is unioned across remote and command server
 *  shapes; both expose a `name` field for the user-facing display name). */
function readConfigName(config: unknown): string | undefined {
  if (config && typeof config === "object" && "name" in config) {
    const value = (config as { name: unknown }).name;
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

const WEB_FETCH_TOOL_NAME = "web_fetch" satisfies SdkBuiltinToolName;
const WEB_FETCH_TOOL = {
  key: "tool:web_fetch",
  name: "Web Fetch",
  description: "Fetch HTTP(S) URLs without browser automation",
};
const WEB_FETCH_GATED_SERVER = getServerForSdkTool(WEB_FETCH_TOOL_NAME);

function addSyntheticTools(configKey: string, tools: ToolGroup["tools"]): ToolGroup["tools"] {
  let result = tools;
  if (configKey === WEB_FETCH_GATED_SERVER && !result.some((t) => t.key === WEB_FETCH_TOOL.key)) {
    // Web Fetch is SDK-native, so it remains available even when Playwright MCP has no connected tools.
    result = [...result, WEB_FETCH_TOOL];
  }
  return result;
}

/**
 * A built-in capability (in PERMISSION_SERVERS) that is NOT an MCP provider —
 * e.g. `filesystem`, which graduated to a capability. The Capabilities section
 * owns its toggles, so it must never also render as an MCP group. Suppressed
 * here so a stale `filesystem` entry persisted in mcpStore can't resurrect a
 * phantom group after the upgrade.
 */
function isNonMcpCapabilityKey(configKey: string): boolean {
  return Boolean(CONFIG_KEY_TO_DISPLAY_NAME[configKey]) && !MCP_SERVER_CONFIG_KEYS.has(configKey);
}

function groupDefToToolGroup(groupDef: ToolGroupDef): ToolGroup {
  return {
    key: `tool:${groupDef.key}`,
    name: groupDef.name,
    tools: groupDef.toolNames.map((name) => ({
      key: `tool:${name}`,
      name: humanize(name),
    })),
    status: "connected",
  };
}

export function buildStaticCategories(
  settings: WorkServiceProviderSettings = {},
  availability?: WorkServiceToolAvailability,
): ToolCategory[] {
  const providers = normalizeWorkServiceProviderSettings(settings);
  const notificationsEnabled =
    availability?.notificationsAvailable ??
    !isWorkServiceProviderDisabled(providers.notificationProviderId);
  const appGroups = APP_TOOLS_CATEGORY.groups.filter((group) => {
    if (group.toolNames.length === 0) return false;
    if (group.key === "notifications") return notificationsEnabled;
    return true;
  });
  return [
    {
      key: "app",
      name: APP_TOOLS_CATEGORY.name,
      groups: appGroups.map(groupDefToToolGroup),
    },
  ];
}

export function buildMcpCategory(
  serverConfigs: Record<string, unknown>,
  mcpToolLists: Record<string, Array<{ name: string; description?: string }>>,
  options?: {
    discoveryErrors?: ReadonlySet<string>;
    discoveryInProgress?: boolean;
  },
): ToolCategory {
  const { discoveryErrors, discoveryInProgress } = options ?? {};

  const groups: ToolGroup[] = Object.keys(serverConfigs)
    .filter((configKey) => !isNonMcpCapabilityKey(configKey))
    .map((configKey) => {
      // Display-name precedence:
      //   1. Built-in UI mapping (playwright → "Browser Control…" etc.)
      //   2. The `name` field on the user's stored config (custom servers
      //      register the SDK under a snake_case key, but the user originally
      //      typed e.g. "Power BI" — surface that in the UI rather than the
      //      sanitized key).
      //   3. The raw config key as a last resort.
      const configName = readConfigName(serverConfigs[configKey]);
      const displayName = MCP_CONFIG_KEY_TO_UI[configKey] ?? configName ?? configKey;
      // Use runtime tool lists if available, fall back to built-in static lists
      const runtimeTools = mcpToolLists[configKey];
      const tools = runtimeTools ?? MCP_BUILTIN_TOOLS[configKey];

      // Status priority: "connected" wins even during re-discovery — if runtimeTools
      // exist from a previous successful run, we keep showing them rather than
      // flashing "error" when a transient failure occurs during refresh.
      let status: ToolGroup["status"];
      if (runtimeTools) {
        status = "connected";
      } else if (discoveryErrors?.has(configKey)) {
        status = "error";
      } else if (discoveryInProgress) {
        status = "loading";
      } else if (tools) {
        status = "static";
      } else {
        status = "disconnected";
      }

      return {
        key: `mcp:${configKey}`,
        name: displayName,
        tools: tools
          ? addSyntheticTools(
              configKey,
              tools.map((t) => ({
                key: `mcp:${configKey}:${t.name}`,
                name: humanize(t.name),
                description: t.description,
              })),
            )
          : addSyntheticTools(configKey, []),
        status,
      };
    });

  return { key: "mcp", name: "MCP Servers", groups };
}
