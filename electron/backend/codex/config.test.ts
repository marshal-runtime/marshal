import { describe, expect, it } from "vitest";

import type { RuntimeSessionConfig } from "../runtime-contract";
import { toCodexResumeParams, toCodexThreadParams } from "./config";
import { buildCodexToolNotes } from "./native-tool-notes";
import { resolveCodexNativeTools } from "./tool-surface";

const WORKSPACE = "/tmp/workspace";
const OPTIONS = { experimentalApi: true };

function threadParams(config: RuntimeSessionConfig) {
  return toCodexThreadParams(WORKSPACE, config, OPTIONS);
}

describe("toCodexThreadParams sandbox translation", () => {
  it("defaults to read-only with no writable-roots config override", () => {
    const params = threadParams({});
    expect(params["sandbox"]).toBe("read-only");
    expect(params["config"]).not.toHaveProperty("sandbox_workspace_write");
  });

  it("passes an explicit workspace-write override with writable roots", () => {
    const params = threadParams({
      sandbox: { mode: "workspace-write", writableRoots: ["/tmp/reports", "/tmp/scratch"] },
    });
    expect(params["sandbox"]).toBe("workspace-write");
    expect(params["config"]).toHaveProperty("sandbox_workspace_write", {
      writable_roots: ["/tmp/reports", "/tmp/scratch"],
    });
  });

  it("omits the writable-roots override when none are given", () => {
    const params = threadParams({ sandbox: { mode: "workspace-write" } });
    expect(params["sandbox"]).toBe("workspace-write");
    expect(params["config"]).not.toHaveProperty("sandbox_workspace_write");
  });

  it("ignores writable roots when mode stays read-only", () => {
    const params = threadParams({
      sandbox: { mode: "read-only", writableRoots: ["/tmp/reports"] },
    });
    expect(params["sandbox"]).toBe("read-only");
    expect(params["config"]).not.toHaveProperty("sandbox_workspace_write");
  });

  it("keeps existing config overrides alongside writable roots", () => {
    const params = threadParams({
      reasoningEffort: "high",
      sandbox: { mode: "workspace-write", writableRoots: ["/tmp/reports"] },
    });
    expect(params["config"]).toHaveProperty("model_reasoning_effort", "high");
    expect(params["config"]).toHaveProperty("sandbox_workspace_write", {
      writable_roots: ["/tmp/reports"],
    });
  });
});

describe("toCodexResumeParams sandbox translation", () => {
  it("carries the sandbox override through resume", () => {
    const params = toCodexResumeParams(
      "thread-1",
      WORKSPACE,
      { sandbox: { mode: "workspace-write", writableRoots: ["/tmp/reports"] } },
      OPTIONS,
    );
    expect(params["sandbox"]).toBe("workspace-write");
    expect(params["config"]).toHaveProperty("sandbox_workspace_write", {
      writable_roots: ["/tmp/reports"],
    });
  });

  it("stays read-only on resume by default", () => {
    const params = toCodexResumeParams("thread-1", WORKSPACE, {}, OPTIONS);
    expect(params["sandbox"]).toBe("read-only");
  });
});

describe("allow-all sandbox", () => {
  it("passes danger-full-access through on create and resume", () => {
    const sandbox = { mode: "danger-full-access" as const };
    expect(threadParams({ sandbox })["sandbox"]).toBe("danger-full-access");
    expect(toCodexResumeParams("thread-1", WORKSPACE, { sandbox }, OPTIONS)["sandbox"]).toBe(
      "danger-full-access",
    );
  });

  it("ignores writable roots under danger-full-access and keeps approvals on", () => {
    const params = threadParams({
      sandbox: { mode: "danger-full-access", writableRoots: ["/tmp/reports"] },
      onPermissionRequest: () => ({ kind: "approve-once" }),
    });
    expect(params["config"]).not.toHaveProperty("sandbox_workspace_write");
    expect(params["approvalPolicy"]).toBe("untrusted");
  });
});

describe("system prompt delivery", () => {
  it("sends replace mode as baseInstructions with the Codex tool notes, never as developerInstructions", () => {
    const params = threadParams({ systemMessage: { content: "MARSHAL PROMPT", mode: "replace" } });
    expect(params["developerInstructions"]).toBeUndefined();
    expect(params["baseInstructions"]).toEqual(
      expect.stringMatching(/^MARSHAL PROMPT\n\n# Codex tool notes/),
    );
    expect(params["baseInstructions"]).toContain("apply_patch");
    expect(params["baseInstructions"]).toContain("web_search");
  });

  it("layers append and unspecified modes as developerInstructions only", () => {
    for (const mode of ["append", undefined] as const) {
      const params = threadParams({ systemMessage: { content: "MARSHAL PROMPT", mode } });
      expect(params["developerInstructions"]).toBe("MARSHAL PROMPT");
      expect(params).not.toHaveProperty("baseInstructions");
    }
  });

  it("re-sends baseInstructions on resume and never developerInstructions", () => {
    const params = toCodexResumeParams(
      "thread-1",
      WORKSPACE,
      { systemMessage: { content: "MARSHAL PROMPT", mode: "replace" } },
      OPTIONS,
    );
    expect(params["baseInstructions"]).toContain("MARSHAL PROMPT");
    expect(params).not.toHaveProperty("developerInstructions");
  });

  it("omits the shell notes when the allowlist grants no shell", () => {
    const params = threadParams({
      availableTools: ["runtimeSearch"],
      systemMessage: { content: "MARSHAL PROMPT", mode: "replace" },
    });
    expect(params["baseInstructions"]).toBe("MARSHAL PROMPT");
    expect(buildCodexToolNotes({ shell: false, webSearch: true })).not.toContain("apply_patch");
  });
});

describe("deferred host tools", () => {
  const handler = async () => "ok";

  it("tells the model where deferred tools live when Marshal's prompt replaces Codex's", () => {
    const params = threadParams({
      systemMessage: { content: "MARSHAL PROMPT", mode: "replace" },
      tools: [{ name: "lazy_tool", handler }],
    });
    expect(params["baseInstructions"]).toContain("marshal_host_tools");
    expect(params["baseInstructions"]).toContain("tool_search");
    const eager = threadParams({
      systemMessage: { content: "MARSHAL PROMPT", mode: "replace" },
      tools: [{ name: "eager_tool", eagerLoad: true, handler }],
    });
    expect(eager["baseInstructions"]).not.toContain("marshal_host_tools");
  });
});

describe("restricted tool surfaces", () => {
  it("leaves native tools alone when the session is unrestricted, but drops Codex goals", () => {
    const config = threadParams({})["config"];
    expect(config).toMatchObject({ features: { goals: false } });
    expect(config).not.toHaveProperty("web_search");
    expect(config).not.toHaveProperty("tools");
    expect(config).not.toHaveProperty("project_doc_max_bytes");
    expect(threadParams({})).not.toHaveProperty("ephemeral");
  });

  it("disables shell, web search, planning and project docs for a tool-free session", () => {
    const params = threadParams({ availableTools: [] });
    expect(params["config"]).toMatchObject({
      features: { goals: false, shell_tool: false, multi_agent: false },
      web_search: "disabled",
      tools: {
        update_plan: { enabled: false },
        experimental_request_user_input: { enabled: false },
      },
      project_doc_max_bytes: 0,
    });
  });

  it("keeps the native tools an explicit allowlist names", () => {
    const params = threadParams({ availableTools: ["Bash", "WebSearch", "runtimeSearch"] });
    const config = params["config"];
    expect(config).toMatchObject({ features: { shell_tool: true } });
    expect(config).not.toHaveProperty("web_search");
    expect(config).not.toHaveProperty("project_doc_max_bytes");
    expect(resolveCodexNativeTools(["runtimeSearch"])).toEqual({ shell: false, webSearch: false });
  });

  it("applies the same surface on resume", () => {
    const params = toCodexResumeParams("thread-1", WORKSPACE, { availableTools: [] }, OPTIONS);
    expect(params["config"]).toMatchObject({
      features: { shell_tool: false },
      web_search: "disabled",
      project_doc_max_bytes: 0,
    });
  });

  it("starts ephemeral threads only when asked", () => {
    expect(threadParams({ availableTools: [], ephemeral: true })["ephemeral"]).toBe(true);
    expect(threadParams({ availableTools: [] })).not.toHaveProperty("ephemeral");
  });

  it("still drops project docs when the session carries no project context", () => {
    expect(threadParams({ projectContext: false })["config"]).toMatchObject({
      project_doc_max_bytes: 0,
    });
  });
});

describe("native multi-agent prompt", () => {
  it("drops the /root team-leader message on start and resume without losing the tool surface", () => {
    const features = { goals: false, multi_agent_v2: { root_agent_usage_hint_text: "" } };
    expect(threadParams({})["config"]).toMatchObject({ features });
    expect(toCodexResumeParams("thread-1", WORKSPACE, {}, OPTIONS)["config"]).toMatchObject({
      features,
    });
    expect(threadParams({ availableTools: [] })["config"]).toMatchObject({
      features: { ...features, shell_tool: false, multi_agent: false },
    });
  });
});
