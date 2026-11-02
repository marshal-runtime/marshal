import { describe, expect, it } from "vitest";

import { toCursorMcpServers } from "./mcp";

describe("toCursorMcpServers", () => {
  it("maps stdio and HTTP servers onto the Cursor MCP config", () => {
    expect(
      toCursorMcpServers({
        files: { command: "npx", args: ["-y", "files"], env: { A: "1" }, workingDirectory: "/tmp" },
        docs: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer x" } },
      }),
    ).toEqual({
      files: {
        type: "stdio",
        command: "npx",
        args: ["-y", "files"],
        env: { A: "1" },
        cwd: "/tmp",
      },
      docs: {
        type: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer x" },
      },
    });
  });
});
