import { describe, expect, it } from "vitest";

import { toMcpServerKey } from "./platform/extensions/mcp-server-key";

describe("toMcpServerKey", () => {
  it.each([
    ["powerbi", "powerbi"],
    ["Power BI", "power_bi"],
    ["POWER BI MCP", "power_bi_mcp"],
    ["My Custom API Server", "my_custom_api_server"],
    ["power-bi", "power-bi"],
    ["power_bi", "power_bi"],
    [" Power BI ", "power_bi"],
    ["Power  BI", "power_bi"],
  ])("normalizes %s to %s", (name, expected) => {
    expect(toMcpServerKey(name)).toBe(expected);
  });
});
