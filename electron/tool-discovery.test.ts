import { describe, it, expect, vi } from "vitest";

vi.mock("./mcp-tools", () => ({
  MCP_CONFIG_KEY_TO_UI: {
    playwright: "Browser Control and Web Browsing",
  },
}));

import { getToolGroupKey } from "../common/marshal-tool-registry";
import { buildStaticCategories, buildMcpCategory } from "./tool-discovery";

describe("buildStaticCategories", () => {
  it("returns only the App category", () => {
    const cats = buildStaticCategories();
    expect(cats.map((category) => category.key)).toEqual(["app"]);
  });

  it("App memory group has tools with tool: prefix keys", () => {
    const cats = buildStaticCategories();
    const memGroup = cats[0].groups.find((g) => g.key === "tool:memory");
    expect(memGroup).toBeDefined();
    expect(memGroup!.tools.some((t) => t.key === "tool:remember")).toBe(true);
  });

  it("App skills group has canonical tool keys and labels", () => {
    const skillsGroup = buildStaticCategories()[0].groups.find((g) => g.key === "tool:skills");
    expect(skillsGroup?.tools[0]).toEqual(
      expect.objectContaining({ key: "tool:listSkills", name: "List Skills" }),
    );
  });

  it("omits the notifications group when the notification provider is disabled", () => {
    const cats = buildStaticCategories({ notificationProviderId: "none" });

    expect(cats.map((category) => category.key)).toEqual(["app"]);
    expect(cats[0].groups.find((group) => group.key === "tool:notifications")).toBeUndefined();
    expect(cats[0].groups.find((group) => group.key === "tool:memory")).toBeDefined();
  });

  it("lets runtime availability override the notification provider setting", () => {
    const hidden = buildStaticCategories({}, { notificationsAvailable: false });
    expect(hidden[0].groups.find((group) => group.key === "tool:notifications")).toBeUndefined();

    const shown = buildStaticCategories(
      { notificationProviderId: "none" },
      { notificationsAvailable: true },
    );
    expect(shown[0].groups.find((group) => group.key === "tool:notifications")).toBeDefined();
  });
});

describe("buildMcpCategory", () => {
  it("returns category with groups for each MCP server config", () => {
    const serverConfigs = { playwright: {}, custom_server: {} };
    const cat = buildMcpCategory(serverConfigs, {});
    expect(cat.key).toBe("mcp");
    expect(cat.groups).toHaveLength(2);
    expect(cat.groups.map((g) => g.key)).toEqual(["mcp:playwright", "mcp:custom_server"]);
  });

  it("does not emit a filesystem group (filesystem is a capability, not MCP)", () => {
    // Even a stale `filesystem` entry persisted in mcpStore must not resurrect
    // a phantom MCP group — the Capabilities section owns File System Access.
    const cat = buildMcpCategory({ filesystem: {}, playwright: {} }, {});
    expect(cat.groups.find((g) => g.key === "mcp:filesystem")).toBeUndefined();
    expect(cat.groups.find((g) => g.key === "mcp:playwright")).toBeDefined();
  });

  it("uses static tool lists for built-in servers with static status", () => {
    const serverConfigs = { playwright: {} };
    const cat = buildMcpCategory(serverConfigs, {});
    // Static fallback — tools are known but not discovered at runtime
    expect(cat.groups[0].status).toBe("static");
    expect(cat.groups[0].tools.length).toBeGreaterThan(0);
    expect(cat.groups[0].tools[0].key).toBe("mcp:playwright:browser_navigate");
  });

  it("reports connected when runtime tool list is provided", () => {
    const serverConfigs = { playwright: {} };
    const mcpToolLists = {
      playwright: [{ name: "browser_navigate", description: "Navigate" }],
    };
    const cat = buildMcpCategory(serverConfigs, mcpToolLists);
    expect(cat.groups[0].status).toBe("connected");
  });

  it("marks unknown servers without tools as disconnected", () => {
    const serverConfigs = { custom_server: {} };
    const cat = buildMcpCategory(serverConfigs, {});
    expect(cat.groups[0].status).toBe("disconnected");
    expect(cat.groups[0].tools).toEqual([]);
  });

  it("uses display name from MCP_CONFIG_KEY_TO_UI", () => {
    const serverConfigs = { playwright: {} };
    const cat = buildMcpCategory(serverConfigs, {});
    expect(cat.groups[0].name).toBe("Browser Control and Web Browsing");
  });

  it("adds Web Fetch as a synthetic Browser Control and Web Browsing tool", () => {
    const category = buildMcpCategory(
      { playwright: {} },
      {
        playwright: [{ name: "browser_navigate", description: "Navigate to a URL" }],
      },
    );

    expect(category.groups).toEqual([
      expect.objectContaining({
        key: "mcp:playwright",
        name: "Browser Control and Web Browsing",
        tools: expect.arrayContaining([
          {
            key: "tool:web_fetch",
            name: "Web Fetch",
            description: "Fetch HTTP(S) URLs without browser automation",
          },
        ]),
      }),
    ]);
  });

  it("adds Web Fetch when Browser Control has no discovered tools yet", () => {
    const category = buildMcpCategory({ playwright: {} }, {});

    expect(category.groups).toEqual([
      expect.objectContaining({
        key: "mcp:playwright",
        tools: expect.arrayContaining([
          {
            key: "tool:web_fetch",
            name: "Web Fetch",
            description: "Fetch HTTP(S) URLs without browser automation",
          },
        ]),
      }),
    ]);
  });

  it("falls back to the user-configured `name` for custom servers (not the snake_case key)", () => {
    // Custom MCP servers are registered with the SDK under the
    // toMcpServerKey-sanitized key (e.g. "power_bi"), but the user
    // originally typed a friendly display name ("Power BI"). The
    // permissions/tools UI should show that name, not the key.
    const serverConfigs = {
      power_bi: {
        name: "Power BI",
        url: "https://mcp.example.com/v1/mcp/powerbi",
        type: "http",
      },
    };
    const cat = buildMcpCategory(serverConfigs, {});
    expect(cat.groups[0].name).toBe("Power BI");
    expect(cat.groups[0].key).toBe("mcp:power_bi");
  });

  it("falls back to the raw configKey when no display name is available", () => {
    // Defensive: stored configs without a `name` (legacy or malformed)
    // should still surface something rather than an empty string.
    const serverConfigs = { weird_server: { url: "x" } };
    const cat = buildMcpCategory(serverConfigs, {});
    expect(cat.groups[0].name).toBe("weird_server");
  });

  it("reports error when discoveryErrors contains the server key", () => {
    const serverConfigs = { custom_server: {} };
    const cat = buildMcpCategory(
      serverConfigs,
      {},
      {
        discoveryErrors: new Set(["custom_server"]),
      },
    );
    expect(cat.groups[0].status).toBe("error");
  });

  it("reports loading when discoveryInProgress and not connected", () => {
    const serverConfigs = { custom_server: {} };
    const cat = buildMcpCategory(
      serverConfigs,
      {},
      {
        discoveryInProgress: true,
      },
    );
    expect(cat.groups[0].status).toBe("loading");
  });

  it("keeps connected status even when discoveryInProgress", () => {
    const serverConfigs = { custom_server: {} };
    const mcpToolLists = {
      custom_server: [{ name: "do_thing", description: "Do a thing" }],
    };
    const cat = buildMcpCategory(serverConfigs, mcpToolLists, {
      discoveryInProgress: true,
    });
    expect(cat.groups[0].status).toBe("connected");
  });

  it("error takes priority over loading", () => {
    const serverConfigs = { custom_server: {} };
    const cat = buildMcpCategory(
      serverConfigs,
      {},
      {
        discoveryErrors: new Set(["custom_server"]),
        discoveryInProgress: true,
      },
    );
    expect(cat.groups[0].status).toBe("error");
  });

  it("populates tools from mcpToolLists", () => {
    const serverConfigs = { custom_server: {} };
    const mcpToolLists = {
      custom_server: [{ name: "read_file", description: "Read a file" }, { name: "write_file" }],
    };
    const cat = buildMcpCategory(serverConfigs, mcpToolLists);
    expect(cat.groups[0].status).toBe("connected");
    expect(cat.groups[0].tools).toHaveLength(2);
    expect(cat.groups[0].tools[0].key).toBe("mcp:custom_server:read_file");
    expect(cat.groups[0].tools[0].name).toBe("Read File");
    expect(cat.groups[0].tools[0].description).toBe("Read a file");
  });
});

describe("getToolGroupKey", () => {
  it("resolves standard MCP tool to group", () => {
    expect(getToolGroupKey("mcp:filesystem:read_file")).toBe("mcp:filesystem");
  });

  it("resolves static tool to group via registry", () => {
    expect(getToolGroupKey("tool:listSkills")).toBe("tool:skills");
  });

  it("returns null for unknown static tool", () => {
    expect(getToolGroupKey("tool:unknown_tool")).toBeNull();
  });

  it("handles server name containing a colon", () => {
    expect(getToolGroupKey("mcp:my:server:some_tool")).toBe("mcp:my:server");
  });

  it("returns null for bare mcp: prefix with no tool segment", () => {
    expect(getToolGroupKey("mcp:")).toBeNull();
  });
});
