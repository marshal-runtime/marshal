import { describe, expect, it } from "vitest";

import { classifyCommandCenterEvent } from "./events";

const base = { schemaVersion: 1, redactionVersion: 1, globalSeq: 3, ts: 1_000 };

function toolEvent(kind: string, serverName?: string) {
  return {
    ...base,
    type: "tool.observed",
    toolCallId: "tool_1",
    sessionId: "session_1",
    toolName: "execute_query",
    kind,
    status: "succeeded",
    ...(serverName ? { serverName } : {}),
    argKeys: [],
  };
}

describe("classifyCommandCenterEvent", () => {
  it("maps persisted tool kinds from removed providers to the generic fallback", () => {
    expect(classifyCommandCenterEvent(toolEvent("kusto", "legacy-query-mcp"))).toMatchObject({
      kind: "supported",
      event: { type: "tool.observed", kind: "generic", serverName: "legacy-query-mcp" },
    });
    expect(classifyCommandCenterEvent(toolEvent("ado", "legacy-work-items"))).toMatchObject({
      kind: "supported",
      event: { kind: "generic" },
    });
    expect(classifyCommandCenterEvent(toolEvent("m365"))).toMatchObject({
      kind: "supported",
      event: { kind: "unknown" },
    });
  });

  it("maps the removed teams session source to unknown", () => {
    expect(
      classifyCommandCenterEvent({
        ...base,
        type: "session.lifecycle",
        sessionId: "session_1",
        lifecycle: "created",
        source: "teams",
      }),
    ).toMatchObject({ kind: "supported", event: { source: "unknown" } });
  });

  it("still rejects tool kinds that were never valid", () => {
    expect(classifyCommandCenterEvent(toolEvent("not-a-kind"))).toEqual({ kind: "invalid" });
  });
});
