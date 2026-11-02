import { describe, expect, it, vi } from "vitest";

import type { RuntimeTool } from "../runtime-contract";
import { toCursorCustomTools } from "./tools";

const HOST_TOOL_NAME = "workspace_info";
const HOST_TOOL_DESCRIPTION = "Read workspace info";
const SESSION_ID = "agent-1";
const TOOL_CALL_ID = "call-1";
const HOST_TOOL_PARAMETERS = { type: "object", properties: {} };

describe("toCursorCustomTools", () => {
  it("maps host tools onto Cursor custom tools with the live session id", async () => {
    const handler = vi.fn<RuntimeTool["handler"]>(async () => "ok");
    const session = { id: "" };
    const tools = toCursorCustomTools(
      [
        {
          name: HOST_TOOL_NAME,
          description: HOST_TOOL_DESCRIPTION,
          parameters: HOST_TOOL_PARAMETERS,
          handler,
        },
      ],
      session,
    );

    session.id = SESSION_ID;
    expect(tools?.[HOST_TOOL_NAME]?.description).toBe(HOST_TOOL_DESCRIPTION);
    expect(tools?.[HOST_TOOL_NAME]?.inputSchema).toEqual(HOST_TOOL_PARAMETERS);
    await expect(
      tools?.[HOST_TOOL_NAME]?.execute({}, { toolCallId: TOOL_CALL_ID }),
    ).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(handler).toHaveBeenCalledWith(
      {},
      {
        sessionId: SESSION_ID,
        toolCallId: TOOL_CALL_ID,
        toolName: HOST_TOOL_NAME,
        arguments: {},
      },
    );
  });

  it("returns undefined when no host tools are registered", () => {
    expect(toCursorCustomTools(undefined, { id: SESSION_ID })).toBeUndefined();
    expect(toCursorCustomTools([], { id: SESSION_ID })).toBeUndefined();
  });
});
