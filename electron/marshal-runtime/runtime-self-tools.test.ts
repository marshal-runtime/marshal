import { RUNTIME_PROTOCOL_VERSION } from "@marshal/runtime";
import { describe, expect, it, vi } from "vitest";

import type { MarshalRuntimeApi, MarshalRuntimeScope } from "./contracts";
import {
  bindRuntimeSelfToolsToSession,
  getRuntimeSelfTools,
  RUNTIME_SELF_TOOL_NAMES,
} from "./runtime-self-tools";

const scope: MarshalRuntimeScope = {
  sessionId: "session-1",
  workspaceName: "workspace",
};

describe("Marshal Runtime self tools", () => {
  it("composes search, invocation, and TypeScript execution with the resolved session scope", async () => {
    const search = vi.fn<MarshalRuntimeApi["search"]>().mockResolvedValue({
      ok: true,
      value: {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        query: "",
        detail: "summary",
        matches: [],
      },
      receipts: [],
    });
    const invoke = vi.fn<MarshalRuntimeApi["invoke"]>().mockResolvedValue({
      ok: true,
      value: { output: "invoked", result: { output: "invoked" } },
      receipts: [],
    });
    const executeTypeScript = vi.fn<MarshalRuntimeApi["executeTypeScript"]>().mockResolvedValue({
      ok: true as const,
      value: { output: "executed", result: { output: "executed" } },
      receipts: [],
    });
    const executeModule = vi.fn<MarshalRuntimeApi["executeModule"]>().mockResolvedValue({
      ok: true as const,
      value: { output: "module-executed", result: { output: "module-executed" } },
      receipts: [],
    });
    const listRenderTools = vi.fn<MarshalRuntimeApi["listRenderTools"]>().mockResolvedValue({
      ok: true as const,
      value: [{ name: "marshal_get_react_payload", inputSchema: { type: "object" } }],
      receipts: [],
    });
    const invokeRenderTool = vi.fn<MarshalRuntimeApi["invokeRenderTool"]>().mockResolvedValue({
      ok: true as const,
      value: { content: [{ type: "text", text: "rendered" }] },
      receipts: [],
    });
    const extensionRecord = {
      identity: "@fixture/runtime-extension",
      version: "1.0.0",
      integrity: {
        algorithm: "sha256" as const,
        domain: "marshal-runtime-extension-package-v1" as const,
        value: "a".repeat(64),
      },
      entrypoint: "index.cjs",
      status: "enabled" as const,
      activationOrder: 0,
      configuration: {},
    };
    const listExtensions = vi.fn<MarshalRuntimeApi["listExtensions"]>().mockResolvedValue({
      ok: true,
      value: [extensionRecord],
      receipts: [],
    });
    const installExtension = vi.fn<MarshalRuntimeApi["installExtension"]>().mockResolvedValue({
      ok: true,
      value: extensionRecord,
      receipts: [],
    });
    const updateExtension = vi.fn<MarshalRuntimeApi["updateExtension"]>().mockResolvedValue({
      ok: true,
      value: { ...extensionRecord, version: "2.0.0" },
      receipts: [],
    });
    const enableExtension = vi.fn<MarshalRuntimeApi["enableExtension"]>().mockResolvedValue({
      ok: true,
      value: extensionRecord,
      receipts: [],
    });
    const disableExtension = vi.fn<MarshalRuntimeApi["disableExtension"]>().mockResolvedValue({
      ok: true,
      value: { ...extensionRecord, status: "disabled" },
      receipts: [],
    });
    const removeExtension = vi.fn<MarshalRuntimeApi["removeExtension"]>().mockResolvedValue({
      ok: true,
      value: { identity: extensionRecord.identity, removed: true },
      receipts: [],
    });
    const api: MarshalRuntimeApi = {
      search,
      invoke,
      executeTypeScript,
      executeModule,
      listRenderTools,
      invokeRenderTool,
      listExtensions,
      installExtension,
      installLocalExtension: vi.fn<MarshalRuntimeApi["installLocalExtension"]>(),
      configureExtension: vi.fn<MarshalRuntimeApi["configureExtension"]>(),
      setProvider: vi.fn<MarshalRuntimeApi["setProvider"]>(),
      clearProvider: vi.fn<MarshalRuntimeApi["clearProvider"]>(),
      repairContractConflict: vi.fn<MarshalRuntimeApi["repairContractConflict"]>(),
      readResource: vi.fn<MarshalRuntimeApi["readResource"]>(),
      updateExtension,
      enableExtension,
      disableExtension,
      removeExtension,
      getStatus: vi.fn<MarshalRuntimeApi["getStatus"]>(),
    };
    const resolveScope = vi
      .fn<(sessionId: string, signal?: AbortSignal) => Promise<MarshalRuntimeScope | null>>()
      .mockResolvedValue(scope);
    const tools = getRuntimeSelfTools({ api, resolveScope });
    expect(tools[2].description).toContain(
      'return context.runtime.invoke("capability.name", input);',
    );
    expect(tools[2].description).toContain("capability output directly");
    const controller = new AbortController();
    const invocation = {
      sessionId: scope.sessionId,
      toolCallId: "tool-call-1",
      toolName: "",
      arguments: {},
      signal: controller.signal,
    };

    expect(tools.map((tool) => tool.name)).toEqual(RUNTIME_SELF_TOOL_NAMES);
    await tools[0].handler({ query: "host tools", detail: "full" }, invocation);
    await tools[1].handler({ capability: "marshal.tool.echo", input: { value: 1 } }, invocation);
    await tools[2].handler({ source: "export default () => 1", timeoutMs: 1000 }, invocation);
    await tools[3].handler({}, invocation);
    await tools[4].handler(
      { packageRoot: "Q:\\extensions\\v1", integritySha256: "a".repeat(64) },
      invocation,
    );
    await tools[5].handler(
      {
        identity: extensionRecord.identity,
        packageRoot: "Q:\\extensions\\v2",
        integritySha256: "b".repeat(64),
      },
      invocation,
    );
    await tools[6].handler({ identity: extensionRecord.identity }, invocation);
    await tools[7].handler({ identity: extensionRecord.identity }, invocation);
    await tools[8].handler({ identity: extensionRecord.identity }, invocation);
    await tools[15].handler(
      { module: { kind: "workspace_file", path: "task.ts" }, input: { value: 2 } },
      invocation,
    );
    await tools[16].handler({}, invocation);
    await tools[17].handler(
      { name: "marshal_get_react_payload", input: { renderId: "render-1" } },
      invocation,
    );

    expect(resolveScope).toHaveBeenCalledTimes(12);
    expect(search).toHaveBeenCalledWith({
      ...scope,
      query: "host tools",
      name: undefined,
      detail: "full",
      tags: undefined,
      limit: undefined,
      signal: controller.signal,
    });
    expect(invoke).toHaveBeenCalledWith({
      ...scope,
      capability: "marshal.tool.echo",
      input: { value: 1 },
      idempotencyKey: invocation.toolCallId,
      signal: controller.signal,
    });

    await tools[1].handler(
      { capability: "browser_navigate", input: '{"url":"https://example.com"}' },
      invocation,
    );
    expect(invoke).toHaveBeenLastCalledWith({
      ...scope,
      capability: "browser_navigate",
      input: { url: "https://example.com" },
      idempotencyKey: invocation.toolCallId,
      signal: controller.signal,
    });
    expect(executeTypeScript).toHaveBeenCalledWith({
      ...scope,
      source: "export default () => 1",
      input: undefined,
      timeoutMs: 1000,
      idempotencyKey: invocation.toolCallId,
      agentAuthoring: true,
      signal: controller.signal,
    });
    expect(executeModule).toHaveBeenCalledWith({
      ...scope,
      module: { kind: "workspace_file", path: "task.ts" },
      input: { value: 2 },
      idempotencyKey: invocation.toolCallId,
      signal: controller.signal,
    });
    expect(listRenderTools).toHaveBeenCalledWith({ ...scope, signal: controller.signal });
    expect(invokeRenderTool).toHaveBeenCalledWith({
      ...scope,
      name: "marshal_get_react_payload",
      input: { renderId: "render-1" },
      idempotencyKey: invocation.toolCallId,
      signal: controller.signal,
    });
    expect(listExtensions).toHaveBeenCalledWith({
      ...scope,
      signal: controller.signal,
    });
    expect(installExtension).toHaveBeenCalledWith({
      ...scope,
      packageRoot: "Q:\\extensions\\v1",
      integrity: {
        algorithm: "sha256",
        domain: "marshal-runtime-extension-package-v1",
        value: "a".repeat(64),
      },
      idempotencyKey: invocation.toolCallId,
      signal: controller.signal,
    });
    expect(updateExtension).toHaveBeenCalledWith({
      ...scope,
      identity: extensionRecord.identity,
      packageRoot: "Q:\\extensions\\v2",
      integrity: {
        algorithm: "sha256",
        domain: "marshal-runtime-extension-package-v1",
        value: "b".repeat(64),
      },
      idempotencyKey: invocation.toolCallId,
      signal: controller.signal,
    });
    expect(enableExtension).toHaveBeenCalledWith({
      ...scope,
      identity: extensionRecord.identity,
      idempotencyKey: invocation.toolCallId,
      signal: controller.signal,
    });
    expect(disableExtension).toHaveBeenCalledWith({
      ...scope,
      identity: extensionRecord.identity,
      idempotencyKey: invocation.toolCallId,
      signal: controller.signal,
    });
    expect(removeExtension).toHaveBeenCalledWith({
      ...scope,
      identity: extensionRecord.identity,
      idempotencyKey: invocation.toolCallId,
      signal: controller.signal,
    });
  });

  it("passes module/TypeScript input VERBATIM (strings stay strings) while runtimeInvoke parses object-strings", async () => {
    // Contract pin for the 2026-09-10 preview trace: the model serialized its
    // tool `input` as a JSON string; runtimeExecuteModule delivered that string
    // to the module verbatim (probe-input-shape-2), while runtimeInvoke parsed
    // it. Both behaviors are now documented in the tool schemas — this test
    // keeps either side from silently flipping.
    const invoke = vi.fn<MarshalRuntimeApi["invoke"]>().mockResolvedValue({
      ok: true,
      value: { output: {}, result: { output: {} } },
      receipts: [],
    });
    const executeTypeScript = vi
      .fn<MarshalRuntimeApi["executeTypeScript"]>()
      .mockResolvedValue({ ok: true, value: { output: {}, result: { output: {} } }, receipts: [] });
    const executeModule = vi
      .fn<MarshalRuntimeApi["executeModule"]>()
      .mockResolvedValue({ ok: true, value: { output: {}, result: { output: {} } }, receipts: [] });
    const api: MarshalRuntimeApi = {
      search: vi.fn<MarshalRuntimeApi["search"]>(),
      invoke,
      executeTypeScript,
      executeModule,
      listRenderTools: vi.fn<MarshalRuntimeApi["listRenderTools"]>(),
      invokeRenderTool: vi.fn<MarshalRuntimeApi["invokeRenderTool"]>(),
      listExtensions: vi.fn<MarshalRuntimeApi["listExtensions"]>(),
      installExtension: vi.fn<MarshalRuntimeApi["installExtension"]>(),
      installLocalExtension: vi.fn<MarshalRuntimeApi["installLocalExtension"]>(),
      configureExtension: vi.fn<MarshalRuntimeApi["configureExtension"]>(),
      setProvider: vi.fn<MarshalRuntimeApi["setProvider"]>(),
      clearProvider: vi.fn<MarshalRuntimeApi["clearProvider"]>(),
      repairContractConflict: vi.fn<MarshalRuntimeApi["repairContractConflict"]>(),
      readResource: vi.fn<MarshalRuntimeApi["readResource"]>(),
      updateExtension: vi.fn<MarshalRuntimeApi["updateExtension"]>(),
      enableExtension: vi.fn<MarshalRuntimeApi["enableExtension"]>(),
      disableExtension: vi.fn<MarshalRuntimeApi["disableExtension"]>(),
      removeExtension: vi.fn<MarshalRuntimeApi["removeExtension"]>(),
      getStatus: vi.fn<MarshalRuntimeApi["getStatus"]>(),
    };
    const tools = getRuntimeSelfTools({ api, resolveScope: async () => scope });
    const invocation = {
      sessionId: scope.sessionId,
      toolCallId: "tool-call-verbatim",
      toolName: "",
      arguments: {},
    };
    const serialized = '{"agentId": "test-123", "seed": 7}';

    await tools[1].handler({ capability: "sample.echo", input: serialized }, invocation);
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ input: { agentId: "test-123", seed: 7 } }),
    );

    await tools[2].handler(
      { source: "export default (input) => input", input: serialized },
      invocation,
    );
    expect(executeTypeScript).toHaveBeenCalledWith(expect.objectContaining({ input: serialized }));

    await tools[15].handler(
      { module: { kind: "workspace_file", path: "task.ts" }, input: serialized },
      invocation,
    );
    expect(executeModule).toHaveBeenCalledWith(expect.objectContaining({ input: serialized }));

    const inputDescription = (schema: unknown): string => {
      const properties =
        schema !== null && typeof schema === "object"
          ? Reflect.get(schema, "properties")
          : undefined;
      const input =
        properties !== null && typeof properties === "object"
          ? Reflect.get(properties, "input")
          : undefined;
      return JSON.stringify(input ?? {});
    };
    expect(inputDescription(tools[2].parameters)).toContain("VERBATIM");
    expect(inputDescription(tools[15].parameters)).toContain("VERBATIM");
    expect(inputDescription(tools[1].parameters)).toContain("tolerated and parsed");
  });

  it("rejects invocation when the session no longer resolves to a runtime scope", async () => {
    const search = vi.fn<MarshalRuntimeApi["search"]>();
    const api: MarshalRuntimeApi = {
      search,
      invoke: vi.fn<MarshalRuntimeApi["invoke"]>(),
      executeTypeScript: vi.fn<MarshalRuntimeApi["executeTypeScript"]>(),
      executeModule: vi.fn<MarshalRuntimeApi["executeModule"]>(),
      listRenderTools: vi.fn<MarshalRuntimeApi["listRenderTools"]>(),
      invokeRenderTool: vi.fn<MarshalRuntimeApi["invokeRenderTool"]>(),
      listExtensions: vi.fn<MarshalRuntimeApi["listExtensions"]>(),
      installExtension: vi.fn<MarshalRuntimeApi["installExtension"]>(),
      installLocalExtension: vi.fn<MarshalRuntimeApi["installLocalExtension"]>(),
      configureExtension: vi.fn<MarshalRuntimeApi["configureExtension"]>(),
      setProvider: vi.fn<MarshalRuntimeApi["setProvider"]>(),
      clearProvider: vi.fn<MarshalRuntimeApi["clearProvider"]>(),
      repairContractConflict: vi.fn<MarshalRuntimeApi["repairContractConflict"]>(),
      readResource: vi.fn<MarshalRuntimeApi["readResource"]>(),
      updateExtension: vi.fn<MarshalRuntimeApi["updateExtension"]>(),
      enableExtension: vi.fn<MarshalRuntimeApi["enableExtension"]>(),
      disableExtension: vi.fn<MarshalRuntimeApi["disableExtension"]>(),
      removeExtension: vi.fn<MarshalRuntimeApi["removeExtension"]>(),
      getStatus: vi.fn<MarshalRuntimeApi["getStatus"]>(),
    };
    const tools = getRuntimeSelfTools({
      api,
      resolveScope: async () => null,
    });

    await expect(
      tools[0].handler(
        {},
        {
          sessionId: scope.sessionId,
          toolCallId: "tool-call-1",
          toolName: tools[0].name,
          arguments: {},
        },
      ),
    ).rejects.toThrow("Marshal Runtime session scope is unavailable");
    expect(search).not.toHaveBeenCalled();
  });

  it("binds SDK tool invocations to the owning Marshal session", async () => {
    const search = vi.fn<MarshalRuntimeApi["search"]>().mockResolvedValue({
      ok: true,
      value: {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        query: "",
        detail: "summary",
        matches: [],
      },
      receipts: [],
    });
    const api: MarshalRuntimeApi = {
      search,
      invoke: vi.fn<MarshalRuntimeApi["invoke"]>(),
      executeTypeScript: vi.fn<MarshalRuntimeApi["executeTypeScript"]>(),
      executeModule: vi.fn<MarshalRuntimeApi["executeModule"]>(),
      listRenderTools: vi.fn<MarshalRuntimeApi["listRenderTools"]>(),
      invokeRenderTool: vi.fn<MarshalRuntimeApi["invokeRenderTool"]>(),
      listExtensions: vi.fn<MarshalRuntimeApi["listExtensions"]>(),
      installExtension: vi.fn<MarshalRuntimeApi["installExtension"]>(),
      installLocalExtension: vi.fn<MarshalRuntimeApi["installLocalExtension"]>(),
      configureExtension: vi.fn<MarshalRuntimeApi["configureExtension"]>(),
      setProvider: vi.fn<MarshalRuntimeApi["setProvider"]>(),
      clearProvider: vi.fn<MarshalRuntimeApi["clearProvider"]>(),
      repairContractConflict: vi.fn<MarshalRuntimeApi["repairContractConflict"]>(),
      readResource: vi.fn<MarshalRuntimeApi["readResource"]>(),
      updateExtension: vi.fn<MarshalRuntimeApi["updateExtension"]>(),
      enableExtension: vi.fn<MarshalRuntimeApi["enableExtension"]>(),
      disableExtension: vi.fn<MarshalRuntimeApi["disableExtension"]>(),
      removeExtension: vi.fn<MarshalRuntimeApi["removeExtension"]>(),
      getStatus: vi.fn<MarshalRuntimeApi["getStatus"]>(),
    };
    const resolveScope = vi
      .fn<(sessionId: string, signal?: AbortSignal) => Promise<MarshalRuntimeScope | null>>()
      .mockResolvedValue(scope);
    const tools = bindRuntimeSelfToolsToSession(
      getRuntimeSelfTools({ api, resolveScope, trustedTypeScript: true }),
      scope.sessionId,
    );
    const [tool] = tools;

    await tool.handler(
      {},
      {
        sessionId: "sdk-backend-session",
        toolCallId: "tool-call-1",
        toolName: tool.name,
        arguments: {},
      },
    );

    expect(resolveScope).toHaveBeenCalledWith(scope.sessionId, undefined);

    resolveScope.mockClear();
    const hint = tools.find((candidate) => candidate.scriptingTool)?.toolCallHint;
    await hint?.({
      toolName: "Grep",
      toolInput: { pattern: "retry|backoff" },
      sessionId: "sdk-backend-session",
      scriptingToolName: "runtimeExecuteTypeScript",
    });
    expect(resolveScope).toHaveBeenCalledWith(scope.sessionId);
  });

  // F-DEPLOY-3: agent-path enable/disable/remove call `api.*Extension` directly and
  // never touch the renderer-initiated "runtime-extensions:enable" IPC handler, so
  // they must broadcast the change themselves via `notifyExtensionsChanged` or an
  // already-open window's runtime-ui:getPlacements query never re-fires without a
  // reload. See runtime-extensions-ipc.ts's notifyChanged for the IPC-path sibling.
  it("notifies extension-change listeners after a successful agent-path enable, disable, or remove", async () => {
    const extensionRecord = {
      identity: "@fixture/runtime-extension",
      version: "1.0.0",
      integrity: {
        algorithm: "sha256" as const,
        domain: "marshal-runtime-extension-package-v1" as const,
        value: "a".repeat(64),
      },
      entrypoint: "index.cjs",
      status: "enabled" as const,
      activationOrder: 0,
      configuration: {},
    };
    const enableExtension = vi.fn<MarshalRuntimeApi["enableExtension"]>().mockResolvedValue({
      ok: true,
      value: extensionRecord,
      receipts: [],
    });
    const disableExtension = vi.fn<MarshalRuntimeApi["disableExtension"]>().mockResolvedValue({
      ok: true,
      value: { ...extensionRecord, status: "disabled" },
      receipts: [],
    });
    const removeExtension = vi.fn<MarshalRuntimeApi["removeExtension"]>().mockResolvedValue({
      ok: true,
      value: { identity: extensionRecord.identity, removed: true },
      receipts: [],
    });
    const api: MarshalRuntimeApi = {
      search: vi.fn<MarshalRuntimeApi["search"]>(),
      invoke: vi.fn<MarshalRuntimeApi["invoke"]>(),
      executeTypeScript: vi.fn<MarshalRuntimeApi["executeTypeScript"]>(),
      executeModule: vi.fn<MarshalRuntimeApi["executeModule"]>(),
      listRenderTools: vi.fn<MarshalRuntimeApi["listRenderTools"]>(),
      invokeRenderTool: vi.fn<MarshalRuntimeApi["invokeRenderTool"]>(),
      listExtensions: vi.fn<MarshalRuntimeApi["listExtensions"]>(),
      installExtension: vi.fn<MarshalRuntimeApi["installExtension"]>(),
      installLocalExtension: vi.fn<MarshalRuntimeApi["installLocalExtension"]>(),
      configureExtension: vi.fn<MarshalRuntimeApi["configureExtension"]>(),
      setProvider: vi.fn<MarshalRuntimeApi["setProvider"]>(),
      clearProvider: vi.fn<MarshalRuntimeApi["clearProvider"]>(),
      repairContractConflict: vi.fn<MarshalRuntimeApi["repairContractConflict"]>(),
      readResource: vi.fn<MarshalRuntimeApi["readResource"]>(),
      updateExtension: vi.fn<MarshalRuntimeApi["updateExtension"]>(),
      enableExtension,
      disableExtension,
      removeExtension,
      getStatus: vi.fn<MarshalRuntimeApi["getStatus"]>(),
    };
    const resolveScope = vi
      .fn<(sessionId: string, signal?: AbortSignal) => Promise<MarshalRuntimeScope | null>>()
      .mockResolvedValue(scope);
    const notifyExtensionsChanged = vi.fn<(scope: MarshalRuntimeScope) => void>();
    const tools = getRuntimeSelfTools({ api, resolveScope, notifyExtensionsChanged });
    const invoke = (name: string, toolCallId: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Missing self tool: ${name}`);
      return tool.handler(
        { identity: extensionRecord.identity },
        { sessionId: scope.sessionId, toolCallId, toolName: name, arguments: {} },
      );
    };

    await invoke("runtimeEnableExtension", "tool-call-enable");
    await invoke("runtimeDisableExtension", "tool-call-disable");
    await invoke("runtimeRemoveExtension", "tool-call-remove");

    expect(enableExtension).toHaveBeenCalled();
    expect(disableExtension).toHaveBeenCalled();
    expect(removeExtension).toHaveBeenCalled();
    expect(notifyExtensionsChanged).toHaveBeenCalledTimes(3);
    expect(notifyExtensionsChanged).toHaveBeenCalledWith(scope);
  });

  it("does not notify extension-change listeners when an agent-path enable fails", async () => {
    const enableExtension = vi.fn<MarshalRuntimeApi["enableExtension"]>().mockResolvedValue({
      ok: false,
      error: { code: "operation-failed", message: "activation failed" },
      receipts: [],
    });
    const api: MarshalRuntimeApi = {
      search: vi.fn<MarshalRuntimeApi["search"]>(),
      invoke: vi.fn<MarshalRuntimeApi["invoke"]>(),
      executeTypeScript: vi.fn<MarshalRuntimeApi["executeTypeScript"]>(),
      executeModule: vi.fn<MarshalRuntimeApi["executeModule"]>(),
      listRenderTools: vi.fn<MarshalRuntimeApi["listRenderTools"]>(),
      invokeRenderTool: vi.fn<MarshalRuntimeApi["invokeRenderTool"]>(),
      listExtensions: vi.fn<MarshalRuntimeApi["listExtensions"]>(),
      installExtension: vi.fn<MarshalRuntimeApi["installExtension"]>(),
      installLocalExtension: vi.fn<MarshalRuntimeApi["installLocalExtension"]>(),
      configureExtension: vi.fn<MarshalRuntimeApi["configureExtension"]>(),
      setProvider: vi.fn<MarshalRuntimeApi["setProvider"]>(),
      clearProvider: vi.fn<MarshalRuntimeApi["clearProvider"]>(),
      repairContractConflict: vi.fn<MarshalRuntimeApi["repairContractConflict"]>(),
      readResource: vi.fn<MarshalRuntimeApi["readResource"]>(),
      updateExtension: vi.fn<MarshalRuntimeApi["updateExtension"]>(),
      enableExtension,
      disableExtension: vi.fn<MarshalRuntimeApi["disableExtension"]>(),
      removeExtension: vi.fn<MarshalRuntimeApi["removeExtension"]>(),
      getStatus: vi.fn<MarshalRuntimeApi["getStatus"]>(),
    };
    const resolveScope = vi
      .fn<(sessionId: string, signal?: AbortSignal) => Promise<MarshalRuntimeScope | null>>()
      .mockResolvedValue(scope);
    const notifyExtensionsChanged = vi.fn<(scope: MarshalRuntimeScope) => void>();
    const tools = getRuntimeSelfTools({ api, resolveScope, notifyExtensionsChanged });
    const tool = tools.find((candidate) => candidate.name === "runtimeEnableExtension");
    if (!tool) throw new Error("Missing self tool: runtimeEnableExtension");

    await tool.handler(
      { identity: "@fixture/runtime-extension" },
      { sessionId: scope.sessionId, toolCallId: "tool-call-1", toolName: tool.name, arguments: {} },
    );

    expect(enableExtension).toHaveBeenCalled();
    expect(notifyExtensionsChanged).not.toHaveBeenCalled();
  });

  // F-DEPLOY-3 class completion: install/update/installLocal/configure/setProvider/
  // clearProvider/repairContractConflict are the OTHER agent-path self-tools that
  // mutate extension/provider state through `api.*` directly, bypassing the same
  // renderer-initiated IPC handler as enable/disable/remove. Each must notify on
  // success too, or an already-open window's runtime-ui:getPlacements query never
  // re-fires for these mutation kinds either.
  it("notifies extension-change listeners after a successful agent-path install, update, installLocal, configure, setProvider, clearProvider, or repairContractConflict", async () => {
    const extensionRecord = {
      identity: "@fixture/runtime-extension",
      version: "1.0.0",
      integrity: {
        algorithm: "sha256" as const,
        domain: "marshal-runtime-extension-package-v1" as const,
        value: "a".repeat(64),
      },
      entrypoint: "index.cjs",
      status: "enabled" as const,
      activationOrder: 0,
      configuration: {},
    };
    const installExtension = vi.fn<MarshalRuntimeApi["installExtension"]>().mockResolvedValue({
      ok: true,
      value: extensionRecord,
      receipts: [],
    });
    const installLocalExtension = vi
      .fn<MarshalRuntimeApi["installLocalExtension"]>()
      .mockResolvedValue({ ok: true, value: extensionRecord, receipts: [] });
    const updateExtension = vi.fn<MarshalRuntimeApi["updateExtension"]>().mockResolvedValue({
      ok: true,
      value: { ...extensionRecord, version: "2.0.0" },
      receipts: [],
    });
    const configureExtension = vi
      .fn<MarshalRuntimeApi["configureExtension"]>()
      .mockResolvedValue({ ok: true, value: extensionRecord, receipts: [] });
    const setProvider = vi.fn<MarshalRuntimeApi["setProvider"]>().mockResolvedValue({
      ok: true,
      value: extensionRecord,
      receipts: [],
    });
    const clearProvider = vi.fn<MarshalRuntimeApi["clearProvider"]>().mockResolvedValue({
      ok: true,
      value: extensionRecord,
      receipts: [],
    });
    const repairContractConflict = vi
      .fn<MarshalRuntimeApi["repairContractConflict"]>()
      .mockResolvedValue({
        ok: true,
        value: {
          canonicalService: "svc",
          bindings: [
            {
              canonicalService: "svc",
              providerIdentity: extensionRecord.identity,
              effectiveService: "svc",
              publicName: "Svc",
            },
          ],
          conflicts: [],
          enabled: [extensionRecord.identity],
        },
        receipts: [],
      });
    const api: MarshalRuntimeApi = {
      search: vi.fn<MarshalRuntimeApi["search"]>(),
      invoke: vi.fn<MarshalRuntimeApi["invoke"]>(),
      executeTypeScript: vi.fn<MarshalRuntimeApi["executeTypeScript"]>(),
      executeModule: vi.fn<MarshalRuntimeApi["executeModule"]>(),
      listRenderTools: vi.fn<MarshalRuntimeApi["listRenderTools"]>(),
      invokeRenderTool: vi.fn<MarshalRuntimeApi["invokeRenderTool"]>(),
      listExtensions: vi.fn<MarshalRuntimeApi["listExtensions"]>(),
      installExtension,
      installLocalExtension,
      configureExtension,
      setProvider,
      clearProvider,
      repairContractConflict,
      readResource: vi.fn<MarshalRuntimeApi["readResource"]>(),
      updateExtension,
      enableExtension: vi.fn<MarshalRuntimeApi["enableExtension"]>(),
      disableExtension: vi.fn<MarshalRuntimeApi["disableExtension"]>(),
      removeExtension: vi.fn<MarshalRuntimeApi["removeExtension"]>(),
      getStatus: vi.fn<MarshalRuntimeApi["getStatus"]>(),
    };
    const resolveScope = vi
      .fn<(sessionId: string, signal?: AbortSignal) => Promise<MarshalRuntimeScope | null>>()
      .mockResolvedValue(scope);
    const notifyExtensionsChanged = vi.fn<(scope: MarshalRuntimeScope) => void>();
    const tools = getRuntimeSelfTools({ api, resolveScope, notifyExtensionsChanged });
    const invoke = (name: string, args: Record<string, unknown>, toolCallId: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Missing self tool: ${name}`);
      return tool.handler(args, {
        sessionId: scope.sessionId,
        toolCallId,
        toolName: name,
        arguments: {},
      });
    };

    await invoke(
      "runtimeInstallExtension",
      { packageRoot: "/pkg/v1", integritySha256: "a".repeat(64) },
      "tool-call-install",
    );
    await invoke(
      "runtimeUpdateExtension",
      { identity: extensionRecord.identity, packageRoot: "/pkg/v2" },
      "tool-call-update",
    );
    await invoke(
      "runtimeInstallLocalExtension",
      { packageRoot: "/pkg/local" },
      "tool-call-install-local",
    );
    await invoke(
      "runtimeConfigureExtension",
      { identity: extensionRecord.identity, configuration: { flag: true } },
      "tool-call-configure",
    );
    await invoke(
      "runtimeSetProvider",
      { identity: extensionRecord.identity, serviceId: "svc", providerId: "provider-a" },
      "tool-call-set-provider",
    );
    await invoke(
      "runtimeClearProvider",
      { identity: extensionRecord.identity, serviceId: "svc" },
      "tool-call-clear-provider",
    );
    await invoke(
      "runtimeRepairContractConflict",
      {
        request: {
          canonicalService: "svc",
          bindings: [
            {
              canonicalService: "svc",
              providerIdentity: extensionRecord.identity,
              effectiveService: "svc",
              publicName: "Svc",
            },
          ],
        },
      },
      "tool-call-repair",
    );

    expect(installExtension).toHaveBeenCalled();
    expect(updateExtension).toHaveBeenCalled();
    expect(installLocalExtension).toHaveBeenCalled();
    expect(configureExtension).toHaveBeenCalled();
    expect(setProvider).toHaveBeenCalled();
    expect(clearProvider).toHaveBeenCalled();
    expect(repairContractConflict).toHaveBeenCalled();
    expect(notifyExtensionsChanged).toHaveBeenCalledTimes(7);
    expect(notifyExtensionsChanged).toHaveBeenCalledWith(scope);
  });

  it("does not notify extension-change listeners when an agent-path install or update fails", async () => {
    const installExtension = vi.fn<MarshalRuntimeApi["installExtension"]>().mockResolvedValue({
      ok: false,
      error: { code: "invalid-request", message: "bad package root" },
      receipts: [],
    });
    const updateExtension = vi.fn<MarshalRuntimeApi["updateExtension"]>().mockResolvedValue({
      ok: false,
      error: { code: "operation-failed", message: "staging failed" },
      receipts: [],
    });
    const api: MarshalRuntimeApi = {
      search: vi.fn<MarshalRuntimeApi["search"]>(),
      invoke: vi.fn<MarshalRuntimeApi["invoke"]>(),
      executeTypeScript: vi.fn<MarshalRuntimeApi["executeTypeScript"]>(),
      executeModule: vi.fn<MarshalRuntimeApi["executeModule"]>(),
      listRenderTools: vi.fn<MarshalRuntimeApi["listRenderTools"]>(),
      invokeRenderTool: vi.fn<MarshalRuntimeApi["invokeRenderTool"]>(),
      listExtensions: vi.fn<MarshalRuntimeApi["listExtensions"]>(),
      installExtension,
      installLocalExtension: vi.fn<MarshalRuntimeApi["installLocalExtension"]>(),
      configureExtension: vi.fn<MarshalRuntimeApi["configureExtension"]>(),
      setProvider: vi.fn<MarshalRuntimeApi["setProvider"]>(),
      clearProvider: vi.fn<MarshalRuntimeApi["clearProvider"]>(),
      repairContractConflict: vi.fn<MarshalRuntimeApi["repairContractConflict"]>(),
      readResource: vi.fn<MarshalRuntimeApi["readResource"]>(),
      updateExtension,
      enableExtension: vi.fn<MarshalRuntimeApi["enableExtension"]>(),
      disableExtension: vi.fn<MarshalRuntimeApi["disableExtension"]>(),
      removeExtension: vi.fn<MarshalRuntimeApi["removeExtension"]>(),
      getStatus: vi.fn<MarshalRuntimeApi["getStatus"]>(),
    };
    const resolveScope = vi
      .fn<(sessionId: string, signal?: AbortSignal) => Promise<MarshalRuntimeScope | null>>()
      .mockResolvedValue(scope);
    const notifyExtensionsChanged = vi.fn<(scope: MarshalRuntimeScope) => void>();
    const tools = getRuntimeSelfTools({ api, resolveScope, notifyExtensionsChanged });
    const invoke = (name: string, args: Record<string, unknown>, toolCallId: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Missing self tool: ${name}`);
      return tool.handler(args, {
        sessionId: scope.sessionId,
        toolCallId,
        toolName: name,
        arguments: {},
      });
    };

    await invoke(
      "runtimeInstallExtension",
      { packageRoot: "/pkg/v1", integritySha256: "a".repeat(64) },
      "tool-call-install-fail",
    );
    await invoke(
      "runtimeUpdateExtension",
      { identity: "@fixture/runtime-extension", packageRoot: "/pkg/v2" },
      "tool-call-update-fail",
    );

    expect(installExtension).toHaveBeenCalled();
    expect(updateExtension).toHaveBeenCalled();
    expect(notifyExtensionsChanged).not.toHaveBeenCalled();
  });

  it("does not notify extension-change listeners for read-only tools like runtimeListExtensions", async () => {
    const listExtensions = vi.fn<MarshalRuntimeApi["listExtensions"]>().mockResolvedValue({
      ok: true,
      value: [],
      receipts: [],
    });
    const api: MarshalRuntimeApi = {
      search: vi.fn<MarshalRuntimeApi["search"]>(),
      invoke: vi.fn<MarshalRuntimeApi["invoke"]>(),
      executeTypeScript: vi.fn<MarshalRuntimeApi["executeTypeScript"]>(),
      executeModule: vi.fn<MarshalRuntimeApi["executeModule"]>(),
      listRenderTools: vi.fn<MarshalRuntimeApi["listRenderTools"]>(),
      invokeRenderTool: vi.fn<MarshalRuntimeApi["invokeRenderTool"]>(),
      listExtensions,
      installExtension: vi.fn<MarshalRuntimeApi["installExtension"]>(),
      installLocalExtension: vi.fn<MarshalRuntimeApi["installLocalExtension"]>(),
      configureExtension: vi.fn<MarshalRuntimeApi["configureExtension"]>(),
      setProvider: vi.fn<MarshalRuntimeApi["setProvider"]>(),
      clearProvider: vi.fn<MarshalRuntimeApi["clearProvider"]>(),
      repairContractConflict: vi.fn<MarshalRuntimeApi["repairContractConflict"]>(),
      readResource: vi.fn<MarshalRuntimeApi["readResource"]>(),
      updateExtension: vi.fn<MarshalRuntimeApi["updateExtension"]>(),
      enableExtension: vi.fn<MarshalRuntimeApi["enableExtension"]>(),
      disableExtension: vi.fn<MarshalRuntimeApi["disableExtension"]>(),
      removeExtension: vi.fn<MarshalRuntimeApi["removeExtension"]>(),
      getStatus: vi.fn<MarshalRuntimeApi["getStatus"]>(),
    };
    const resolveScope = vi
      .fn<(sessionId: string, signal?: AbortSignal) => Promise<MarshalRuntimeScope | null>>()
      .mockResolvedValue(scope);
    const notifyExtensionsChanged = vi.fn<(scope: MarshalRuntimeScope) => void>();
    const tools = getRuntimeSelfTools({ api, resolveScope, notifyExtensionsChanged });
    const tool = tools.find((candidate) => candidate.name === "runtimeListExtensions");
    if (!tool) throw new Error("Missing self tool: runtimeListExtensions");

    await tool.handler(
      {},
      {
        sessionId: scope.sessionId,
        toolCallId: "tool-call-list",
        toolName: tool.name,
        arguments: {},
      },
    );

    expect(listExtensions).toHaveBeenCalled();
    expect(notifyExtensionsChanged).not.toHaveBeenCalled();
  });
});

describe("TypeScript tool descriptions", () => {
  function descriptions(trustedTypeScript: boolean) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- descriptions only; the API is never called
    const api = {} as MarshalRuntimeApi;
    const tools = getRuntimeSelfTools({ api, resolveScope: async () => scope, trustedTypeScript });
    return {
      inline: tools.find((tool) => tool.name === "runtimeExecuteTypeScript")?.description,
      module: tools.find((tool) => tool.name === "runtimeExecuteModule")?.description,
    };
  }

  it("describes full Node access when trusted TypeScript is on", () => {
    const { inline, module } = descriptions(true);
    expect(inline).toContain("full Node access");
    expect(inline).not.toContain("brokered");
    expect(module).toContain("full Node access");
  });

  it("keeps the brokered descriptions when it is off", () => {
    const { inline, module } = descriptions(false);
    expect(inline).toContain("no ambient Node authority");
    expect(module).toContain("brokered");
  });

  it("loads the core runtime tools eagerly and marks only trusted TypeScript as the scripting tool", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- flags only; the API is never called
    const api = {} as MarshalRuntimeApi;
    const toolsFor = (trustedTypeScript: boolean) =>
      getRuntimeSelfTools({ api, resolveScope: async () => scope, trustedTypeScript });
    const eager = toolsFor(true)
      .filter((tool) => tool.eagerLoad)
      .map((tool) => tool.name);
    expect(eager.sort()).toEqual(
      ["runtimeExecuteTypeScript", "runtimeInvoke", "runtimeSearch", "runtimeShowUi"].sort(),
    );
    const scripting = (trustedTypeScript: boolean) =>
      toolsFor(trustedTypeScript)
        .filter((tool) => tool.scriptingTool)
        .map((tool) => tool.name);
    expect(scripting(true)).toEqual(["runtimeExecuteTypeScript"]);
    expect(scripting(false)).toEqual([]);
  });
});

describe("runtimeInvoke result", () => {
  const receipt = { receiptId: "receipt-1", status: "success" };
  async function invokeWith(
    response: Awaited<ReturnType<MarshalRuntimeApi["invoke"]>>,
    extraArgs: Record<string, unknown> = {},
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only invoke is exercised
    const api = {
      invoke: vi.fn<MarshalRuntimeApi["invoke"]>().mockResolvedValue(response),
    } as unknown as MarshalRuntimeApi;
    const tool = getRuntimeSelfTools({ api, resolveScope: async () => scope }).find(
      (candidate) => candidate.name === "runtimeInvoke",
    );
    const text = await tool!.handler(
      { capability: "fixture.echo", input: {}, ...extraArgs },
      {
        sessionId: scope.sessionId,
        toolCallId: "call-1",
        toolName: "runtimeInvoke",
        arguments: {},
      },
    );
    return JSON.parse(text) as unknown;
  }

  it("returns the capability output once, without the duplicated result or receipts", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- receipt fixture is opaque to the tool
    const receipts = [receipt] as never;
    const success = {
      ok: true as const,
      value: { output: { answer: 42 }, result: { output: { answer: 42 } } },
      receipts,
    };
    expect(await invokeWith(success)).toEqual({ ok: true, value: { answer: 42 } });
    expect(await invokeWith(success, { verbose: true })).toEqual(
      JSON.parse(JSON.stringify(success)),
    );
  });

  it("keeps the approval handle on failures", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- approval and receipt fixtures are opaque to the tool
    const approval = { approvalId: "approval-1" } as never;
    const error = { code: "approval-required" as const, message: "Needs approval", approval };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- receipt fixture is opaque to the tool
    const failure = { ok: false as const, error, receipts: [receipt] as never };
    expect(await invokeWith(failure)).toEqual({ ok: false, error });
  });
});
