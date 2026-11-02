import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createAgentRuntime,
  createRuntimeBuiltinsSource,
  createRuntimeServiceContainer,
  type RuntimeExecResponse,
} from "@marshal/runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeToolInvocation } from "../backend/runtime-contract";
import { testDouble } from "../testing/harness";
import { ProductionMarshalRuntimeApi } from "./api";
import {
  MARSHAL_RUNTIME_PERMISSION,
  MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX,
  type MarshalRuntimeAuthorityPort,
  type MarshalRuntimeApprovalPort,
  type MarshalRuntimeCatalogPort,
  type MarshalRuntimeModule,
  type MarshalRuntimePackageMetadata,
} from "./contracts";
import { MarshalRuntimeHost } from "./host";
import { normalizeRuntimeApiError } from "./runtime-api-error";
import type { MarshalRuntimePackageLoader } from "./runtime-package-loader";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("embedded Marshal Runtime API", () => {
  const originalTmpdir = process.env.TMPDIR;
  const deniedPermissions = new Set<string>();
  const packageMetadata: MarshalRuntimePackageMetadata = {
    name: "@marshal/runtime",
    version: "0.1.0-test",
    entrypoint: "dist/host.js",
    entrySha256: "0".repeat(64),
  };
  let root: string;
  let host: MarshalRuntimeHost;
  let api: ProductionMarshalRuntimeApi;
  let heldInvocationStarted: Deferred | null = null;
  let heldInvocationRelease: Deferred | null = null;
  let cancelledInvocation: Deferred | null = null;
  let promptHostTools = false;
  let runtimeApprovalStatus: ReturnType<MarshalRuntimeApprovalPort["status"]> = "missing";

  it.each([
    "aborted",
    "approval-required",
    "idempotency-capacity",
    "idempotency-conflict",
    "invalid-request",
    "not-found",
    "permission-denied",
    "runtime-unavailable",
    "operation-failed",
  ] as const)("preserves the normalized provider error code %s", (code) => {
    expect(normalizeRuntimeApiError({ code, message: "Provider failure" })).toMatchObject({
      code,
      message: "Provider failure",
    });
  });

  const toolHandler = vi
    .fn<(rawArgs: unknown, invocation: RuntimeToolInvocation) => Promise<string>>()
    .mockImplementation(async (rawArgs, invocation) => {
      const mode = isRecord(rawArgs) ? rawArgs.mode : undefined;
      if (mode === "hold") {
        heldInvocationStarted?.resolve();
        await heldInvocationRelease?.promise;
      }
      if (mode === "cancel") {
        heldInvocationStarted?.resolve();
        await new Promise<never>((_, reject) => {
          const abort = () => {
            cancelledInvocation?.resolve();
            reject(Object.assign(new Error("fixture invocation aborted"), { code: "ABORTED" }));
          };
          if (invocation.signal?.aborted) abort();
          else invocation.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      if (mode === "invalid-request") {
        throw Object.assign(new Error("The provider rejected the request."), {
          code: "INVALID_REQUEST",
        });
      }
      return JSON.stringify(rawArgs);
    });

  const authority: MarshalRuntimeAuthorityPort = {
    async resolveScope(scope, signal) {
      if (
        signal?.aborted ||
        scope.sessionId !== "session-1" ||
        scope.workspaceName.toLowerCase() !== "workspace"
      ) {
        return null;
      }
      return { ...scope, workspaceName: "workspace", workspacePath: path.join(root, "scope") };
    },
    async authorize(request) {
      const denied = request.permissions.find((permission) => deniedPermissions.has(permission));
      if (
        promptHostTools &&
        request.permissions.some((permission) =>
          permission.startsWith(MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX),
        )
      ) {
        return {
          decision: "approval",
          reason: "Explicit host tool approval is required.",
          prompt: "Approve this host tool?",
        };
      }
      return denied
        ? { decision: "deny", reason: `Denied ${denied}.`, code: "permission_denied" }
        : { decision: "allow" };
    },
  };
  const approval: MarshalRuntimeApprovalPort = {
    permissionApproval: {
      requestApproval: (_check, _permissions, presentation) => ({
        reason: presentation?.reason ?? "Approval is required.",
        approvalId: "host-tool-approval",
        prompt: presentation?.prompt,
      }),
      verifyApproval: (proof) => ({
        approved: proof.approvalId === "host-tool-approval",
        permissions: [`${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}echo`],
      }),
    },
    status: () => runtimeApprovalStatus,
    cancel: () => undefined,
    cancelRequest: () => undefined,
    dispose: () => undefined,
  };

  const catalog: MarshalRuntimeCatalogPort = {
    listTools: () => [
      {
        name: "echo",
        description: "Return the provided JSON input.",
        parameters: { type: "object", additionalProperties: true },
        supportsAbortSignal: true,
        handler: toolHandler,
      },
    ],
    listSkills: () => [],
    getSkill: () => null,
    listWorkspaces: () => [{ name: "workspace", path: path.join(root, "scope") }],
    async getSessionContext(sessionId) {
      return { id: sessionId, name: "Runtime API test", workspaceName: "workspace" };
    },
  };

  beforeAll(async () => {
    const canonicalTmpdir = await realpath(tmpdir());
    process.env.TMPDIR = canonicalTmpdir;
    root = await mkdtemp(path.join(canonicalTmpdir, "marshal-runtime-api-test-"));
    await Promise.all([
      mkdir(path.join(root, "workspace"), { recursive: true }),
      mkdir(path.join(root, "scope"), { recursive: true }),
      mkdir(path.join(root, "protected-results"), { recursive: true }),
      mkdir(path.join(root, "worktrees"), { recursive: true }),
      mkdir(path.join(root, "extensions"), { recursive: true }),
    ]);
    await writeFile(
      path.join(root, "workspace", "workspace-module.ts"),
      "export default async (input) => ({ source: 'workspace-file', input });\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "workspace", "render-component.tsx"),
      "export default function Widget({ label = 'Ready' }) { return <main>{label}</main>; }\n",
      "utf8",
    );
    const runtimeModule: MarshalRuntimeModule = {
      createAgentRuntime,
      createRuntimeBuiltinsSource,
    };
    const packageLoader: MarshalRuntimePackageLoader = {
      load: async () => runtimeModule,
      metadata: () => packageMetadata,
    };
    host = new MarshalRuntimeHost({
      location: { isPackaged: false, appPath: root, resourcesPath: root },
      hostWorkspacePath: path.join(root, "workspace"),
      protectedLifecycleResultRoot: path.join(root, "protected-results"),
      worktreeRoot: path.join(root, "worktrees"),
      trustedExtensionRoot: path.join(root, "extensions"),
      nodeExecutable: process.execPath,
      authority,
      approval,
      catalog,
      serviceContainer: createRuntimeServiceContainer(),
      packageLoader,
    });
    api = new ProductionMarshalRuntimeApi(host);
    await host.start();
  });

  beforeEach(() => {
    deniedPermissions.clear();
    heldInvocationStarted = null;
    heldInvocationRelease = null;
    cancelledInvocation = null;
    promptHostTools = false;
    runtimeApprovalStatus = "missing";
    toolHandler.mockClear();
  });

  afterAll(async () => {
    api.dispose();
    await host.dispose();
    await rm(root, { recursive: true, force: true });
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
  });

  it("searches Marshal capabilities and invokes a selected host tool", async () => {
    const search = await api.search({
      sessionId: "session-1",
      workspaceName: "workspace",
      name: "marshal.tool.echo",
      detail: "full",
    });
    expect(search.ok).toBe(true);
    if (!search.ok) throw new Error(search.error.message);
    expect(search.value.matches.map((match) => match.capability.name)).toContain(
      "marshal.tool.echo",
    );

    const invocation = await api.invoke({
      sessionId: "session-1",
      workspaceName: "workspace",
      capability: "marshal.tool.echo",
      input: { value: 7 },
      idempotencyKey: "search-invoke",
    });
    expect(invocation.ok).toBe(true);
    if (!invocation.ok) throw new Error(invocation.error.message);
    expect(invocation.value.output).toEqual({ content: '{"value":7}' });
    expect(toolHandler).toHaveBeenCalledTimes(1);
  });

  it("executes brokered TypeScript that invokes a Marshal capability", async () => {
    const result = await api.executeTypeScript({
      sessionId: "session-1",
      workspaceName: "workspace",
      idempotencyKey: "typescript-invoke",
      input: { value: "from-typescript" },
      source: `
        export default async (input, context) => {
          return context.runtime.invoke("marshal.tool.echo", input);
        };
      `,
    });

    if (!result.ok) throw new Error(result.error.message);
    expect(result.ok).toBe(true);
    expect(result.value.output).toMatchObject({
      ok: true,
      status: "succeeded",
      value: { content: '{"value":"from-typescript"}' },
    });
    expect(toolHandler).toHaveBeenCalledTimes(1);
  });

  it("executes a brokered workspace-file module", async () => {
    const result = await api.executeModule({
      sessionId: "session-1",
      workspaceName: "workspace",
      idempotencyKey: "workspace-module",
      module: { kind: "workspace_file", path: "workspace-module.ts" },
      input: { value: 9 },
    });

    if (!result.ok) throw new Error(result.error.message);
    expect(result.ok).toBe(true);
    expect(result.value.output).toMatchObject({
      ok: true,
      status: "succeeded",
      value: { source: "workspace-file", input: { value: 9 } },
    });
  });

  it("lists and invokes render tools from the React UI builtin", async () => {
    const compiled = await api.invoke({
      sessionId: "session-1",
      workspaceName: "workspace",
      capability: "ui.compile",
      input: { entryPath: "render-component.tsx", title: "Runtime render fixture" },
      idempotencyKey: "render-tool-compile",
    });
    if (!compiled.ok) throw new Error(compiled.error.message);
    const compiledOutput = compiled.value.output;
    if (!isRecord(compiledOutput) || !isRecord(compiledOutput.component)) {
      throw new Error("Expected the runtime compiler to return a component.");
    }
    const component = compiledOutput.component;
    const rendered = await api.invoke({
      sessionId: "session-1",
      workspaceName: "workspace",
      capability: "ui.render",
      input: {
        componentId: component.id,
        props: { label: "Rendered through self-tool API" },
        fallback: { summary: "Rendered through self-tool API" },
      },
      idempotencyKey: "render-tool-render",
    });
    if (!rendered.ok) throw new Error(rendered.error.message);
    const renderedOutput = rendered.value.output;
    if (!isRecord(renderedOutput) || !isRecord(renderedOutput.render)) {
      throw new Error("Expected the runtime renderer to return a render record.");
    }
    const render = renderedOutput.render;

    const listed = await api.listRenderTools({
      sessionId: "session-1",
      workspaceName: "workspace",
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.value.map((tool) => tool.name)).toContain("marshal_get_react_payload");

    const invoked = await api.invokeRenderTool({
      sessionId: "session-1",
      workspaceName: "workspace",
      name: "marshal_get_react_payload",
      input: { renderId: render.id },
      idempotencyKey: "render-tool-invoke",
    });
    if (!invoked.ok) throw new Error(invoked.error.message);
    expect(invoked.ok).toBe(true);
    expect(invoked.value?.content).toEqual(expect.any(Array));
    expect(invoked.value?.structuredContent).toMatchObject({
      props: { label: "Rendered through self-tool API" },
    });
  });

  it("authorizes render-tool discovery and invocation through the extension gate", async () => {
    deniedPermissions.add(MARSHAL_RUNTIME_PERMISSION.extensionList);

    await expect(
      api.listRenderTools({ sessionId: "session-1", workspaceName: "workspace" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "permission-denied" },
    });
    await expect(
      api.invokeRenderTool({
        sessionId: "session-1",
        workspaceName: "workspace",
        name: "marshal_get_react_payload",
        input: { renderId: "unauthorized" },
        idempotencyKey: "render-tool-denied",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "permission-denied" },
    });
  });

  it("enforces session scope and host-tool permission decisions", async () => {
    const wrongScope = await api.invoke({
      sessionId: "session-1",
      workspaceName: "other-workspace",
      capability: "marshal.tool.echo",
      input: { value: 1 },
      idempotencyKey: "wrong-scope",
    });
    expect(wrongScope).toMatchObject({
      ok: false,
      error: { code: "permission-denied" },
    });

    deniedPermissions.add(`${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}echo`);
    const denied = await api.invoke({
      sessionId: "session-1",
      workspaceName: "workspace",
      capability: "marshal.tool.echo",
      input: { value: 2 },
      idempotencyKey: "permission-denied",
    });
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "permission-denied" },
    });
    expect(toolHandler).not.toHaveBeenCalled();
  });

  it("cancels an in-flight host capability when its only waiter aborts", async () => {
    heldInvocationStarted = deferred();
    cancelledInvocation = deferred();
    const cancelApprovals = vi.spyOn(host, "cancelApprovalsForRequest");
    const controller = new AbortController();
    const invocation = api.invoke({
      sessionId: "session-1",
      workspaceName: "workspace",
      capability: "marshal.tool.echo",
      input: { mode: "cancel" },
      idempotencyKey: "cancel-invocation",
      signal: controller.signal,
    });

    await heldInvocationStarted.promise;
    controller.abort();
    await expect(invocation).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    await cancelledInvocation.promise;
    expect(toolHandler).toHaveBeenCalledTimes(1);
    expect(cancelApprovals).toHaveBeenCalledWith("session-1", "cancel-invocation");
    cancelApprovals.mockRestore();
  });

  it("deduplicates matching requests and rejects conflicting idempotency reuse", async () => {
    heldInvocationStarted = deferred();
    heldInvocationRelease = deferred();
    const request = {
      sessionId: "session-1",
      workspaceName: "workspace",
      capability: "marshal.tool.echo",
      input: { mode: "hold", value: 3 },
      idempotencyKey: "deduplicated-invocation",
    } as const;

    const first = api.invoke(request);
    await heldInvocationStarted.promise;
    const second = api.invoke(request);
    await Promise.resolve();
    expect(toolHandler).toHaveBeenCalledTimes(1);
    heldInvocationRelease.resolve();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(toolHandler).toHaveBeenCalledTimes(1);

    const conflict = await api.invoke({
      ...request,
      input: { mode: "hold", value: 4 },
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: "idempotency-conflict" },
    });
  });

  it("preserves normalized provider-domain error codes from failed execution", async () => {
    const result = await api.invoke({
      sessionId: "session-1",
      workspaceName: "workspace",
      capability: "marshal.tool.echo",
      input: { mode: "invalid-request" },
      idempotencyKey: "provider-domain-error",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid-request",
        message: "The provider rejected the request.",
      },
      receipts: [{ status: "failed" }],
    });
  });

  it("returns approval-required promptly and retries once only after resolution", async () => {
    const approvalId = "runtime-approval-1";
    const execute = vi.spyOn(host, "execute");
    const approvalStatus = vi.spyOn(host, "approvalStatus");
    const cancelApproval = vi.spyOn(host, "cancelApproval");
    execute.mockResolvedValueOnce(
      testDouble<RuntimeExecResponse>({
        status: "approval_required",
        approval: {
          decision: "approval",
          reason: "Explicit workspace approval is required.",
          approvalId,
          prompt: "Create local repository intelligence?",
        },
        receipt: testDouble({ status: "approval_required" }),
      }),
    );
    approvalStatus.mockReturnValueOnce("pending");
    const request = {
      sessionId: "session-1",
      workspaceName: "workspace",
      capability: "knowledge.workspace.ensure",
      input: { mode: "create-if-missing" },
      idempotencyKey: "workspace-approval",
    } as const;

    await expect(api.invoke(request)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "approval-required",
        approval: { approvalId },
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);

    approvalStatus.mockReturnValueOnce("approved");
    execute.mockResolvedValueOnce(
      testDouble<RuntimeExecResponse>({
        status: "success",
        result: testDouble({ output: { status: "accepted" } }),
        receipt: testDouble({ status: "success" }),
      }),
    );
    await expect(api.invoke(request)).resolves.toMatchObject({
      ok: true,
      value: { output: { status: "accepted" } },
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toMatchObject({
      approval: { approvalId },
    });

    api.dispose();
    expect(cancelApproval).toHaveBeenCalledWith(approvalId);
    execute.mockRestore();
    approvalStatus.mockRestore();
    cancelApproval.mockRestore();
  });

  it("opens and consumes approval for a policy-prompted host tool", async () => {
    promptHostTools = true;
    runtimeApprovalStatus = "pending";
    const request = {
      sessionId: "session-1",
      workspaceName: "workspace",
      capability: "marshal.tool.echo",
      input: { value: "approval" },
      idempotencyKey: "host-tool-approval",
    } as const;

    const prompted = await api.invoke(request);
    expect(prompted).toMatchObject({
      ok: false,
      error: {
        code: "approval-required",
        approval: {
          approvalId: "host-tool-approval",
          prompt: "Approve this host tool?",
        },
      },
    });
    expect(toolHandler).not.toHaveBeenCalled();

    runtimeApprovalStatus = "approved";
    await expect(api.invoke(request)).resolves.toMatchObject({
      ok: true,
      value: { output: { content: '{"value":"approval"}' } },
    });
    expect(toolHandler).toHaveBeenCalledTimes(1);
  });
});
