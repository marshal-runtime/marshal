import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../testing/harness/test-double";
import { conceptQuery, createCodeSearchGuide, isConceptCodeSearch } from "./code-search-nudge";
import type { CodeSearchNudgeOptions } from "./code-search-nudge";
import type { MarshalRuntimeScope } from "./contracts";

type SearchApi = CodeSearchNudgeOptions["api"];

describe("isConceptCodeSearch", () => {
  it.each([
    ["Grep", { pattern: "retry|backoff" }],
    ["Grep", { pattern: "session index cache" }],
    ["Bash", { command: "git grep -n 'retry\\|backoff' -- electron" }],
    ["Bash", { command: 'rg -n "how retries" src' }],
    ["Bash", { command: "grep -rn -e retry -e backoff src" }],
    ["Bash", { command: 'cd repo && git grep -n "a|b" | head' }],
  ])("flags %s %j", (toolName, toolInput) => {
    expect(isConceptCodeSearch(toolName, toolInput)).toBe(true);
  });

  it.each([
    ["Grep", { pattern: "withContextualIndex" }],
    ["Bash", { command: "git grep -n withContextualIndex -- src" }],
    ["Bash", { command: "grep -n 'loadIndex' electron/session-store.ts | head -5" }],
    ["Bash", { command: 'git commit -m "fix retry and backoff"' }],
    ["Bash", { command: "ls -la | grep json" }],
    ["Bash", { command: 'pnpm test x.test.ts 2>&1 | grep -E "AssertionError|Expected" | head' }],
    [
      "Bash",
      { command: 'grep -nE "retry|Retry|backoff" electron/agent-message-outbox.ts | head -60' },
    ],
    ["Bash", { command: 'git grep -n "export function\\|trustedTypeScript" -- electron/x.ts' }],
    ["Bash", { command: 'rg -n "AGENT_MESSAGE_BUSY_RETRY_MS =" electron' }],
    ["Bash", { command: 'git grep -n "extensionContributions: \\[" -- electron' }],
    ["Grep", { pattern: "retry|backoff", path: "electron/agent-message-outbox.ts" }],
    ["Bash", { command: 'git grep -n "function invokePortableMemoryCompatibility"' }],
    [
      "Bash",
      { command: 'git grep -n "acceptedLanguageCapabilities\\|AcceptedLanguage\\b" -- packages' },
    ],
    ["Grep", { pattern: "memory\\.write|marshal\\.memory" }],
    ["Read", { file_path: "a b|c" }],
  ])("leaves exact searches and other commands alone: %s %j", (toolName, toolInput) => {
    expect(isConceptCodeSearch(toolName, toolInput)).toBe(false);
  });
});

describe("conceptQuery", () => {
  it.each([
    ["Grep", { pattern: "retry|backoff" }, "retry backoff"],
    ["Bash", { command: "git grep -n 'retry\\|backoff' -- electron" }, "retry backoff"],
    ["Bash", { command: 'rg -n "how retries work" src | head' }, "how retries work"],
    ["Bash", { command: "grep -rn -e retry -e backoff src" }, "retry backoff"],
    ["Grep", { pattern: "(.*)" }, "what you are looking for, in words"],
  ])("turns %s %j into %j", (toolName, toolInput, expected) => {
    expect(conceptQuery(toolName, toolInput)).toBe(expected);
  });
});

describe("createCodeSearchGuide", () => {
  const SCRIPTING_TOOL = "mcp__marshal__runtimeExecuteTypeScript";
  const call = (toolName: string, toolInput: unknown, agentId?: string) => ({
    toolName,
    toolInput,
    sessionId: "session-1",
    agentId,
    scriptingToolName: SCRIPTING_TOOL,
  });
  const searchIndex = (agentId?: string) =>
    call(
      SCRIPTING_TOOL,
      { source: "return context.runtime.invoke('knowledge.search', {})" },
      agentId,
    );

  const resolveScope: CodeSearchNudgeOptions["resolveScope"] = async () =>
    testDouble<MarshalRuntimeScope>({ sessionId: "session-1" });

  function options(names: string[]) {
    const search = vi.fn<SearchApi["search"]>(async () =>
      testDouble<Awaited<ReturnType<SearchApi["search"]>>>({
        ok: true,
        value: { matches: names.map((name) => ({ capability: { name } })) },
        receipts: [],
      }),
    );
    return { search, api: { search }, resolveScope };
  }

  describe("Sanity", () => {
    it("denies the first concept search with a ready knowledge.search call, then only nudges", async () => {
      const opts = options(["knowledge.search"]);
      const { toolCallHint } = createCodeSearchGuide(opts);
      const first = await toolCallHint(call("Grep", { pattern: "retry|backoff" }));
      expect(first).toEqual({ denyReason: expect.stringContaining("Blocked once") });
      expect(JSON.stringify(first)).toContain('query: \\"retry backoff\\"');
      expect(JSON.stringify(first)).toContain(SCRIPTING_TOOL);
      const second = await toolCallHint(call("Grep", { pattern: "retry|backoff" }));
      expect(second).toContain("context.runtime.invoke('knowledge.search'");
      expect(second).toContain("The search is running as sent.");
      expect(opts.search).toHaveBeenCalledTimes(1);
    });

    it("only nudges a session that already searched the index", async () => {
      const { toolCallHint } = createCodeSearchGuide(options(["knowledge.search"]));
      await expect(toolCallHint(searchIndex())).resolves.toBeUndefined();
      await expect(toolCallHint(call("Grep", { pattern: "retry backoff" }))).resolves.toEqual(
        expect.stringContaining("This looks like a concept search"),
      );
    });

    it("gates each subagent on its own", async () => {
      const { toolCallHint } = createCodeSearchGuide(options(["knowledge.search"]));
      await toolCallHint(searchIndex());
      await expect(
        toolCallHint(call("Grep", { pattern: "retry|backoff" }, "agent-1")),
      ).resolves.toEqual({ denyReason: expect.any(String) });
      await toolCallHint(searchIndex("agent-2"));
      await expect(
        toolCallHint(call("Grep", { pattern: "retry|backoff" }, "agent-2")),
      ).resolves.toEqual(expect.any(String));
    });

    it("gives subagents the Brain-first rule when the index is reachable", async () => {
      const { subagentStartContext } = createCodeSearchGuide(options(["knowledge.search"]));
      await expect(
        subagentStartContext({ sessionId: "session-1", scriptingToolName: SCRIPTING_TOOL }),
      ).resolves.toEqual(expect.stringContaining(`knowledge.search through ${SCRIPTING_TOOL}`));
    });
  });

  describe("Error Handling", () => {
    it("stays silent when the runtime lookup fails", async () => {
      const { toolCallHint, subagentStartContext } = createCodeSearchGuide({
        api: { search: async () => Promise.reject(new Error("down")) },
        resolveScope,
      });
      await expect(toolCallHint(call("Grep", { pattern: "a|b" }))).resolves.toBeUndefined();
      await expect(
        subagentStartContext({ sessionId: "session-1", scriptingToolName: SCRIPTING_TOOL }),
      ).resolves.toBeUndefined();
    });
  });

  describe("Edge Cases", () => {
    it("never blocks an exact search or a session without the capability", async () => {
      const missing = createCodeSearchGuide(options(["memory.recall"]));
      await expect(
        missing.toolCallHint(call("Grep", { pattern: "retry|backoff" })),
      ).resolves.toBeUndefined();
      await expect(
        missing.subagentStartContext({ sessionId: "session-1", scriptingToolName: SCRIPTING_TOOL }),
      ).resolves.toBeUndefined();
      const opts = options(["knowledge.search"]);
      await expect(
        createCodeSearchGuide(opts).toolCallHint(call("Grep", { pattern: "loadIndex" })),
      ).resolves.toBeUndefined();
      expect(opts.search).not.toHaveBeenCalled();
    });

    it("does not count a scripting call without a knowledge call as a search", async () => {
      const { toolCallHint } = createCodeSearchGuide(options(["knowledge.search"]));
      await toolCallHint(call(SCRIPTING_TOOL, { source: "return 1" }));
      await expect(toolCallHint(call("Grep", { pattern: "retry backoff" }))).resolves.toEqual({
        denyReason: expect.any(String),
      });
    });
  });
});
