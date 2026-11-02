// Marshal-owned test
import { describe, expect, it } from "vitest";

import { mcpErrors, makeMcpError, registerMcpErrors } from "./marshal-mcp";
import { mockTelemetryCallbacks } from "./marshal-test-helpers";

describe("mcp error family", () => {
  it("makeMcpError returns correct family and code for every member", () => {
    expect(makeMcpError(mcpErrors.SERVER_CONNECTION_FAILED)).toEqual({
      family: "marshal-mcp",
      code: 0,
    });
    expect(makeMcpError(mcpErrors.TOOL_DISCOVERY_FAILED)).toEqual({
      family: "marshal-mcp",
      code: 1,
    });
    expect(makeMcpError(mcpErrors.OAUTH_FAILED)).toEqual({
      family: "marshal-mcp",
      code: 2,
    });
    expect(makeMcpError(mcpErrors.CONFIG_INVALID)).toEqual({
      family: "marshal-mcp",
      code: 3,
    });
    expect(makeMcpError(mcpErrors.TOOL_EXECUTION_FAILED)).toEqual({
      family: "marshal-mcp",
      code: 4,
    });
    expect(makeMcpError(mcpErrors.CONFIG_PARSE_FAILED)).toEqual({
      family: "marshal-mcp",
      code: 5,
    });
  });

  it("registerMcpErrors calls callbacks.registerErrors with correct args", () => {
    const callbacks = mockTelemetryCallbacks();
    registerMcpErrors(callbacks);
    expect(callbacks.registerErrors).toHaveBeenCalledWith("marshal-mcp", mcpErrors);
  });
});
