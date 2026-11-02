import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RUNTIME_PROTOCOL_VERSION } from "@marshal/runtime";
import type { PermissionCheck } from "@marshal/runtime/core";
import { describe, expect, it, vi } from "vitest";

import { addLogSink, type LogEntry } from "../../common/marshal-logger";
import { ApprovalBroker } from "../approval-broker";
import type { RuntimeTool } from "../backend/runtime-contract";
import type { PermissionPolicy } from "../permission-policy";
import type { PersistedSession } from "../session-store";
import type { SessionManager } from "../sessions";
import { testDouble } from "../testing/harness";
import {
  MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
  MARSHAL_RUNTIME_BROWSER_PERMISSION_PREFIX,
  MARSHAL_RUNTIME_PERMISSION,
  MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX,
  type MarshalRuntimeAuthorityDecisionEvent,
  type ResolvedMarshalRuntimeScope,
} from "./contracts";
import { WORKSPACE_METADATA_KEY, type MarshalRuntimeHost } from "./host";
import {
  createExtensionDeclaredPermissionResolver,
  createProductionMarshalRuntimePorts,
  isReservedRuntimePermissionId,
  EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX,
  type ExtensionDeclaredPermissionResolver,
} from "./production-adapter";
import { RUNTIME_SELF_TOOL_NAMES } from "./runtime-self-tools";

const echoTool: RuntimeTool = {
  name: "echo",
  handler: async () => "echo",
};

function session(): PersistedSession {
  return testDouble<PersistedSession>({
    id: "session-1",
    name: "Scoped session",
    workspaceName: "Engineering",
    repoPath: "Q:\\repo",
    source: "user",
    messages: [],
  });
}

function captureBreadcrumbs(): { entries: LogEntry[]; remove: () => void } {
  const entries: LogEntry[] = [];
  const remove = addLogSink((entry) => {
    if (entry.tag === "MarshalRuntimeExtensionPermissionResolver") entries.push(entry);
  });
  return { entries, remove };
}

describe("production Marshal Runtime ports", () => {
  it("canonicalizes session scope and exposes only non-runtime self tools", async () => {
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
      listSelfToolsForSession: vi
        .fn<SessionManager["listSelfToolsForSession"]>()
        .mockReturnValue([echoTool, { name: "runtimeSearch", handler: async () => "recursive" }]),
      listSkillsForSession: vi.fn<SessionManager["listSkillsForSession"]>().mockReturnValue([]),
      getSkillInstructionsForSession: vi
        .fn<SessionManager["getSkillInstructionsForSession"]>()
        .mockReturnValue(null),
    });
    const permissionPolicy = testDouble<PermissionPolicy>({
      evaluateDetailed: vi
        .fn<PermissionPolicy["evaluateDetailed"]>()
        .mockReturnValue(testDouble({ decision: "approve" })),
    });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy,
      workspaceDir: "Q:\\default-workspace",
    });

    await expect(
      ports.authority.resolveScope({
        sessionId: "session-1",
        workspaceName: "engineering",
      }),
    ).resolves.toEqual({
      sessionId: "session-1",
      workspaceName: "Engineering",
      workspacePath: "Q:\\workspaces\\engineering",
    });
    expect(ports.catalog.listTools("session-1")).toEqual([echoTool]);
    await expect(ports.catalog.getSessionContext("session-1")).resolves.toMatchObject({
      id: "session-1",
      name: "Scoped session",
      workspaceName: "Engineering",
    });
  });

  it("assigns unbound sessions to the shared runtime default workspace", async () => {
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue({ ...session(), workspaceName: undefined }),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([]),
      getWorkspaceRootForSession: vi
        .fn<SessionManager["getWorkspaceRootForSession"]>()
        .mockReturnValue(undefined),
    });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({}),
      workspaceDir: "Q:\\default-workspace",
    });
    const scope = {
      sessionId: "session-1",
      workspaceName: MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
    };

    await expect(ports.resolveScope(scope.sessionId)).resolves.toEqual(scope);
    await expect(ports.authority.resolveScope(scope)).resolves.toEqual({
      ...scope,
      workspacePath: "Q:\\default-workspace",
    });
    await expect(
      ports.authority.resolveScope({ ...scope, workspaceName: "Scratchpad" }),
    ).resolves.toBeNull();
  });

  it("resolves an unbound repo-scoped session to its repo path instead of the default", async () => {
    const getWorkspaceRootForSession = vi
      .fn<SessionManager["getWorkspaceRootForSession"]>()
      .mockReturnValue("Q:\\worktrees\\acme-feature");
    const ports = createProductionMarshalRuntimePorts({
      sessionManager: testDouble<SessionManager>({
        getSessionScopeAsync: vi
          .fn<SessionManager["getSessionScopeAsync"]>()
          .mockResolvedValue({ ...session(), workspaceName: undefined }),
        listWorkspacesForSelfTools: vi
          .fn<SessionManager["listWorkspacesForSelfTools"]>()
          .mockReturnValue([]),
        getWorkspaceRootForSession,
      }),
      permissionPolicy: testDouble<PermissionPolicy>({}),
      workspaceDir: "Q:\\default-workspace",
    });

    await expect(
      ports.authority.resolveScope({
        sessionId: "session-1",
        workspaceName: MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
      }),
    ).resolves.toEqual({
      sessionId: "session-1",
      workspaceName: MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
      workspacePath: "Q:\\worktrees\\acme-feature",
    });
    expect(getWorkspaceRootForSession).toHaveBeenCalledWith("session-1");
  });

  it("resolves a registered workspace named like the default sentinel to its own path", async () => {
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue({ ...session(), workspaceName: MARSHAL_RUNTIME_DEFAULT_WORKSPACE }),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([
          { name: MARSHAL_RUNTIME_DEFAULT_WORKSPACE, path: "Q:\\workspaces\\marshal-repo" },
        ]),
    });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({}),
      workspaceDir: "Q:\\default-workspace",
    });

    await expect(
      ports.authority.resolveScope({
        sessionId: "session-1",
        workspaceName: MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
      }),
    ).resolves.toEqual({
      sessionId: "session-1",
      workspaceName: MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
      workspacePath: "Q:\\workspaces\\marshal-repo",
    });
  });

  it("allows trusted TypeScript execution only when the host enables it", async () => {
    const buildPorts = (trustedTypeScript: boolean) =>
      createProductionMarshalRuntimePorts({
        sessionManager: testDouble<SessionManager>({
          getSessionScopeAsync: vi
            .fn<SessionManager["getSessionScopeAsync"]>()
            .mockResolvedValue(session()),
          listWorkspacesForSelfTools: vi
            .fn<SessionManager["listWorkspacesForSelfTools"]>()
            .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
        }),
        permissionPolicy: testDouble<PermissionPolicy>({}),
        workspaceDir: "Q:\\default-workspace",
        trustedTypeScript,
      });
    const request = {
      scope: { sessionId: "session-1", workspaceName: "Engineering" },
      capability: "runtime.inline_module.execute.trusted",
      input: { source: "export default () => 1" },
      permissions: ["runtime.inline_module.execute.trusted"],
    } as const;

    await expect(buildPorts(true).authority.authorize(request)).resolves.toMatchObject({
      decision: "allow",
    });
    await expect(buildPorts(false).authority.authorize(request)).resolves.toMatchObject({
      decision: "deny",
    });
  });

  it("allows bounded built-ins, delegates host tools to policy, and denies unknown permissions", async () => {
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockReturnValue(testDouble({ decision: "approve" }));
    const onAuthorityDecision = vi.fn<(event: MarshalRuntimeAuthorityDecisionEvent) => void>();
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
      listSelfToolsForSession: vi
        .fn<SessionManager["listSelfToolsForSession"]>()
        .mockReturnValue([echoTool]),
      listSkillsForSession: vi.fn<SessionManager["listSkillsForSession"]>().mockReturnValue([]),
      getSkillInstructionsForSession: vi
        .fn<SessionManager["getSkillInstructionsForSession"]>()
        .mockReturnValue(null),
    });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({ evaluateDetailed }),
      workspaceDir: "Q:\\default-workspace",
      onAuthorityDecision,
    });
    const request = {
      scope: { sessionId: "session-1", workspaceName: "Engineering" },
      capability: "fixture",
      input: { value: 1 },
    } as const;

    await expect(
      ports.authority.authorize({
        ...request,
        permissions: [MARSHAL_RUNTIME_PERMISSION.typescriptExecute],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    await expect(
      ports.authority.authorize({
        ...request,
        permissions: [MARSHAL_RUNTIME_PERMISSION.moduleExecute],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(onAuthorityDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({
        capability: "fixture",
        decision: expect.objectContaining({ decision: "allow" }),
      }),
    );
    await expect(
      ports.authority.authorize({
        ...request,
        capability: "marshal.memory.store",
        permissions: [MARSHAL_RUNTIME_PERMISSION.memoryStore],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    await expect(
      ports.authority.authorize({
        ...request,
        capability: "marshal.memory.recall",
        permissions: [MARSHAL_RUNTIME_PERMISSION.memoryRecall],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    await expect(
      ports.authority.authorize({
        ...request,
        capability: "marshal.brain.launch",
        permissions: [MARSHAL_RUNTIME_PERMISSION.brainLaunch],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(evaluateDetailed).not.toHaveBeenCalled();

    await expect(
      ports.authority.authorize({
        ...request,
        capability: "memory.brain.recall",
        permissions: ["memory.read"],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(evaluateDetailed).toHaveBeenLastCalledWith(
      expect.objectContaining({ toolName: "memory.brain.recall" }),
    );
    await expect(
      ports.authority.authorize({
        ...request,
        capability: "knowledge.workspace.ensure",
        permissions: ["code.read"],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(evaluateDetailed).toHaveBeenLastCalledWith(
      expect.objectContaining({ toolName: "knowledge.workspace.ensure" }),
    );
    await expect(
      ports.authority.authorize({
        ...request,
        capability: "knowledge.search",
        permissions: ["knowledge.read"],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(evaluateDetailed).toHaveBeenLastCalledWith(
      expect.objectContaining({ toolName: "knowledge.search" }),
    );

    await expect(
      ports.authority.authorize({
        ...request,
        permissions: [`${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}echo`],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(evaluateDetailed).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        toolName: "echo",
        toolArgs: { value: 1 },
      }),
    );

    await expect(
      ports.authority.authorize({
        ...request,
        capability: "browser_handle_dialog",
        input: { action: "dismiss" },
        permissions: [`${MARSHAL_RUNTIME_BROWSER_PERMISSION_PREFIX}browser_handle_dialog`],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(evaluateDetailed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "mcp",
        serverName: "playwright",
        toolName: "browser_handle_dialog",
        toolArgs: { accept: false },
        readOnly: false,
      }),
    );

    const browserPolicyCalls = evaluateDetailed.mock.calls.length;
    await expect(
      ports.authority.authorize({
        ...request,
        capability: "browser_console",
        permissions: [`${MARSHAL_RUNTIME_BROWSER_PERMISSION_PREFIX}browser_screenshot`],
      }),
    ).resolves.toMatchObject({ decision: "deny", code: "permission_denied" });
    await expect(
      ports.authority.authorize({
        ...request,
        capability: "browser_handle_dialog",
        input: { action: "unsupported" },
        permissions: [`${MARSHAL_RUNTIME_BROWSER_PERMISSION_PREFIX}browser_handle_dialog`],
      }),
    ).resolves.toMatchObject({ decision: "deny", code: "permission_denied" });
    expect(evaluateDetailed).toHaveBeenCalledTimes(browserPolicyCalls);

    await expect(
      ports.authority.authorize({
        ...request,
        capability: "code.query",
        permissions: ["code.read"],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(evaluateDetailed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        toolName: "code.query",
        toolArgs: { value: 1 },
      }),
    );

    await expect(
      ports.authority.authorize({
        ...request,
        capability: "code.index.rebuild",
        permissions: ["code.index.rebuild"],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(evaluateDetailed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        toolName: "code.index.rebuild",
      }),
    );

    const policyCalls = evaluateDetailed.mock.calls.length;
    await expect(
      ports.authority.authorize({
        ...request,
        capability: "code.unknown",
        permissions: ["code.read"],
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      code: "permission_denied",
    });
    await expect(
      ports.authority.authorize({
        ...request,
        capability: "code.index.refresh",
        permissions: ["code.index.rebuild"],
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      code: "permission_denied",
    });
    expect(evaluateDetailed).toHaveBeenCalledTimes(policyCalls);

    await expect(
      ports.authority.authorize({
        ...request,
        permissions: ["runtime.unsupported"],
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      code: "permission_denied",
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      ports.authority.authorize({
        ...request,
        permissions: [MARSHAL_RUNTIME_PERMISSION.sessionRead],
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ decision: "deny", code: "aborted" });
  });

  it("routes extension-declared permissions through policy on the agent path (R5/D2)", async () => {
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockReturnValue(testDouble({ decision: "approve" }));
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
    });
    const resolveExtensionDeclaredPermission = vi.fn<ExtensionDeclaredPermissionResolver>();
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({ evaluateDetailed }),
      workspaceDir: "Q:\\default-workspace",
      resolveExtensionDeclaredPermission,
    });
    const request = {
      scope: { sessionId: "session-1", workspaceName: "Engineering" },
      capability: "codereview.pr.list",
      input: { repo: "owner/name" },
      permissions: ["codereview.read"],
    } as const;

    // (1) a permission declared by an enabled extension's capability descriptor
    // produces a policy decision (allow/ask), not the "not supported" deny.
    resolveExtensionDeclaredPermission.mockResolvedValueOnce({
      declared: true,
      extensionId: "codereview-extension",
    });
    await expect(ports.authority.authorize(request)).resolves.toMatchObject({
      decision: "allow",
    });
    expect(resolveExtensionDeclaredPermission).toHaveBeenLastCalledWith(
      "codereview.read",
      "codereview.pr.list",
      expect.objectContaining({ sessionId: "session-1", workspaceName: "Engineering" }),
    );
    // (F-R2 + SF2-2) the policy tool name is namespaced by prefix AND by the
    // declaring extension's identity, never the permission id verbatim, so it
    // can never collide with a real tool's policy grants or another
    // extension's bucket for the same permission id.
    expect(evaluateDetailed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolName: "runtime-extension:codereview-extension:codereview.read",
        toolArgs: request.input,
      }),
    );

    // (2) an undeclared permission still gets the exact unsupported deny; no
    // allow-all, no bypass.
    const policyCallsBeforeUndeclared = evaluateDetailed.mock.calls.length;
    resolveExtensionDeclaredPermission.mockResolvedValueOnce(false);
    await expect(ports.authority.authorize(request)).resolves.toMatchObject({
      decision: "deny",
      code: "permission_denied",
      reason: "Marshal Runtime permission is not supported: codereview.read.",
    });
    expect(evaluateDetailed).toHaveBeenCalledTimes(policyCallsBeforeUndeclared);

    // (3) a policy deny wins even though the permission is extension-declared.
    resolveExtensionDeclaredPermission.mockResolvedValueOnce({
      declared: true,
      extensionId: "codereview-extension",
    });
    evaluateDetailed.mockReturnValueOnce(
      testDouble({ decision: "deny", denyReason: "Blocked by permission policy." }),
    );
    await expect(ports.authority.authorize(request)).resolves.toMatchObject({
      decision: "deny",
      code: "permission_denied",
      reason: "Blocked by permission policy.",
    });

    // (4) once the owning extension is disabled/uninstalled, the resolver
    // reports the permission undeclared again and the same unsupported deny
    // fires for the exact permission that was allowed a moment ago.
    resolveExtensionDeclaredPermission.mockResolvedValueOnce(false);
    await expect(ports.authority.authorize(request)).resolves.toMatchObject({
      decision: "deny",
      code: "permission_denied",
      reason: "Marshal Runtime permission is not supported: codereview.read.",
    });
  });

  it("does not let an extension-declared permission inherit a colliding tool's session always-allow (F-R2)", async () => {
    // Simulates a stored session always-allow grant for the real "echo" self
    // tool (as if it had been approved via marshal.tool.invoke:echo earlier).
    // Only the exact policy tool name "echo" is pre-approved; anything else
    // (including the namespaced extension permission name) still has to ask.
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockImplementation((request) =>
        "toolName" in request && request.toolName === "echo"
          ? testDouble({ decision: "approve" })
          : testDouble({ decision: "prompt" }),
      );
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
    });
    const resolveExtensionDeclaredPermission = vi
      .fn<ExtensionDeclaredPermissionResolver>()
      .mockResolvedValue({ declared: true, extensionId: "echo-lookalike-extension" });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({ evaluateDetailed }),
      workspaceDir: "Q:\\default-workspace",
      resolveExtensionDeclaredPermission,
    });
    const request = {
      scope: { sessionId: "session-1", workspaceName: "Engineering" },
      // An extension declares a permission id equal to the real "echo" tool
      // name — a name collision the extension author did not control.
      capability: "extension.echo.capability",
      input: { value: 1 },
      permissions: ["echo"],
    } as const;

    await expect(ports.authority.authorize(request)).resolves.toMatchObject({
      decision: "approval",
    });
    expect(evaluateDetailed).toHaveBeenLastCalledWith(
      expect.objectContaining({ toolName: "runtime-extension:echo-lookalike-extension:echo" }),
    );
  });

  it("does not let a session always-allow earned by one extension's declared permission be inherited by a different extension declaring the same permission id (SF2-2)", async () => {
    // Extension A previously earned a session always-allow for its declared
    // "codereview.read" bucket. Extension B is installed+enabled later and
    // declares the SAME permission id for its own, unrelated capability.
    // Without extension-identity qualification both extensions land in one
    // shared "runtime-extension:codereview.read" bucket and B silently
    // inherits A's approval; with it, B gets its own bucket and has to ask.
    //
    // Deliberately discovers the actual policy tool name from the first call
    // instead of hard-coding it, so this same test is the SF2-2 red
    // reproduction against unmodified 5de1e9b9c (extension B's decision
    // comes back "allow" too, failing the final
    // assertion) as well as the permanent green regression here.
    const approvedToolNames = new Set<string>();
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockImplementation((request) => {
        const toolName = "toolName" in request ? request.toolName : undefined;
        return toolName !== undefined && approvedToolNames.has(toolName)
          ? testDouble({ decision: "approve" })
          : testDouble({ decision: "prompt" });
      });
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
    });
    const resolveExtensionDeclaredPermission = vi.fn<ExtensionDeclaredPermissionResolver>();
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({ evaluateDetailed }),
      workspaceDir: "Q:\\default-workspace",
      resolveExtensionDeclaredPermission,
    });
    const extensionARequest = {
      scope: { sessionId: "session-1", workspaceName: "Engineering" },
      capability: "codereview.pr.list",
      input: { repo: "owner/name" },
      permissions: ["codereview.read"],
    } as const;

    // (1) extension A asks once with no pre-existing approval, is prompted,
    // and — mirroring a real approval being persisted — that exact bucket is
    // now treated as always-allowed for the rest of the session.
    resolveExtensionDeclaredPermission.mockResolvedValueOnce({
      declared: true,
      extensionId: "extension-a",
    });
    await ports.authority.authorize(extensionARequest);
    const [lastRequest] = evaluateDetailed.mock.calls.at(-1) ?? [];
    const grantedToolName =
      lastRequest && "toolName" in lastRequest ? lastRequest.toolName : undefined;
    expect(grantedToolName).toBeDefined();
    if (grantedToolName) approvedToolNames.add(grantedToolName);

    resolveExtensionDeclaredPermission.mockResolvedValueOnce({
      declared: true,
      extensionId: "extension-a",
    });
    await expect(ports.authority.authorize(extensionARequest)).resolves.toMatchObject({
      decision: "allow",
    });

    // (2) extension B, installed+enabled later, declares the SAME permission
    // id for a DIFFERENT capability. It must not inherit A's approval.
    resolveExtensionDeclaredPermission.mockResolvedValueOnce({
      declared: true,
      extensionId: "extension-b",
    });
    await expect(
      ports.authority.authorize({
        scope: { sessionId: "session-1", workspaceName: "Engineering" },
        capability: "extension-b.unrelated.capability",
        input: { value: 1 },
        permissions: ["codereview.read"],
      }),
    ).resolves.toMatchObject({ decision: "approval" });
  });

  it("does not let the marshal.tool.invoke: channel smuggle a permission into another extension's identity-qualified policy bucket (SF2-3)", async () => {
    // Simulates a stored session always-allow for extension A's own SF2-2
    // bucket "runtime-extension:extension-a:codereview.read" (as if A had
    // earned it through the normal declared-permission path). Extension B's
    // capability descriptor then declares THAT EXACT STRING as its own
    // permission id, wrapped in the marshal.tool.invoke: prefix. Without this
    // guard the tool.invoke branch strips the marshal.tool.invoke: prefix and
    // calls policyDecision() with A's bucket name as the remainder — B
    // inherits A's grant without the resolver ever being consulted. No
    // resolver is configured here: the smuggle must be denied purely on the
    // sliced tool name's prefix, before any resolver call would happen.
    const bucketName = `${EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX}extension-a:codereview.read`;
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockReturnValue(testDouble({ decision: "approve" }));
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
    });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({ evaluateDetailed }),
      workspaceDir: "Q:\\default-workspace",
    });

    await expect(
      ports.authority.authorize({
        scope: { sessionId: "session-1", workspaceName: "Engineering" },
        capability: "extension-b.smuggle.capability",
        input: { value: 1 },
        permissions: [`${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}${bucketName}`],
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      code: "permission_denied",
      reason: `Marshal Runtime permission is not supported: ${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}${bucketName}.`,
    });
    expect(evaluateDetailed).not.toHaveBeenCalled();
  });

  it("does not let the marshal.browser.invoke: channel smuggle a permission into another extension's identity-qualified policy bucket (SF2-3)", async () => {
    // Same smuggle as above, through the browser-invoke wrapper channel. The
    // capability is deliberately crafted to equal the sliced tool name so
    // that, absent this guard, the branch's pre-existing capability-identity
    // equality check would pass and reach browserPolicyDecision() with A's
    // bucket name.
    const bucketName = `${EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX}extension-a:codereview.read`;
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockReturnValue(testDouble({ decision: "approve" }));
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
    });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({ evaluateDetailed }),
      workspaceDir: "Q:\\default-workspace",
    });

    await expect(
      ports.authority.authorize({
        scope: { sessionId: "session-1", workspaceName: "Engineering" },
        capability: bucketName,
        input: { value: 1 },
        permissions: [`${MARSHAL_RUNTIME_BROWSER_PERMISSION_PREFIX}${bucketName}`],
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      code: "permission_denied",
      reason: `Marshal Runtime permission is not supported: ${MARSHAL_RUNTIME_BROWSER_PERMISSION_PREFIX}${bucketName}.`,
    });
    expect(evaluateDetailed).not.toHaveBeenCalled();
  });

  it("denies (never silently allows or prompt-inherits) an extension-declared permission id that collides with a real Marshal self-tool name, even with a pre-existing always-allow for that self tool (F-R2 defense in depth)", async () => {
    // Simulates a stored session always-allow for the real "runtimeInvoke"
    // self tool (as if approved earlier via marshal.tool.invoke:runtimeInvoke).
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockReturnValue(testDouble({ decision: "approve" }));
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
    });
    const resolveExtensionDeclaredPermission = vi
      .fn<ExtensionDeclaredPermissionResolver>()
      .mockResolvedValue({ declared: true, extensionId: "runtime-invoke-lookalike-extension" });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({ evaluateDetailed }),
      workspaceDir: "Q:\\default-workspace",
      resolveExtensionDeclaredPermission,
    });

    // (a) bare declared id equal to the self-tool name.
    await expect(
      ports.authority.authorize({
        scope: { sessionId: "session-1", workspaceName: "Engineering" },
        capability: "extension.runtime-invoke.capability",
        input: { value: 1 },
        permissions: ["runtimeInvoke"],
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      code: "permission_denied",
      reason: "Marshal Runtime permission is not supported: runtimeInvoke.",
    });
    expect(evaluateDetailed).not.toHaveBeenCalled();

    // (b) declared id equal to the "marshal.tool.invoke:<selfTool>" channel
    // itself — must not reach policyDecision(toolName: "runtimeInvoke") either.
    await expect(
      ports.authority.authorize({
        scope: { sessionId: "session-1", workspaceName: "Engineering" },
        capability: "extension.runtime-invoke.capability",
        input: { value: 1 },
        permissions: [`${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}runtimeInvoke`],
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      code: "permission_denied",
      reason: `Marshal Runtime permission is not supported: ${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}runtimeInvoke.`,
    });
    expect(evaluateDetailed).not.toHaveBeenCalled();
  });

  it("routes an extension-declared permission id that collides with a builtin trusted permission name to the declaring extension's identity-qualified policy bucket (F-R2 / F-DEPLOY-5)", async () => {
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockReturnValue(testDouble({ decision: "approve" }));
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
    });
    const resolveExtensionDeclaredPermission = vi
      .fn<ExtensionDeclaredPermissionResolver>()
      .mockResolvedValue({ declared: true, extensionId: "memory-lookalike-extension" });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({ evaluateDetailed }),
      workspaceDir: "Q:\\default-workspace",
      resolveExtensionDeclaredPermission,
    });

    // An extension's own capability descriptor declares a permission id equal
    // to the builtin "marshal.memory.recall". The unconditional-allow builtin
    // `continue` must NOT apply (F-R2: no builtin trust for a descriptor-
    // declared id), and the id must NOT be denied outright either (F-DEPLOY-5:
    // that deny bricked every legitimately-declared builtin id like
    // swarm.execute). It routes to the same identity-qualified policy bucket
    // the declared-permission branch uses.
    await expect(
      ports.authority.authorize({
        scope: { sessionId: "session-1", workspaceName: "Engineering" },
        capability: "extension.memory-lookalike.capability",
        input: { value: 1 },
        permissions: [MARSHAL_RUNTIME_PERMISSION.memoryRecall],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(resolveExtensionDeclaredPermission).toHaveBeenCalledWith(
      MARSHAL_RUNTIME_PERMISSION.memoryRecall,
      "extension.memory-lookalike.capability",
      expect.objectContaining({ sessionId: "session-1" }),
    );
    expect(evaluateDetailed).toHaveBeenCalledTimes(1);
    expect(evaluateDetailed).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: `${EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX}memory-lookalike-extension:${MARSHAL_RUNTIME_PERMISSION.memoryRecall}`,
      }),
    );
  });

  describe("F-DEPLOY-5: descriptor-declared builtin permission ids route to identity-qualified policy", () => {
    // Mirrors the live @marshal/swarm shape: every swarm.runs.* capability
    // descriptor declares permissions:[{permission:"swarm.execute"|"swarm.read"}]
    // verbatim, and both ids are members of BUILTIN_PERMISSIONS. The F-R2
    // builtin guard used to deny these outright once the F-DEPLOY-4 resolver
    // fix made the resolver actually return declared matches — blocking swarm
    // run creation host-wide.
    const SWARM_EXTENSION_ID = "@marshal/swarm";
    const SWARM_BUCKET = `${EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX}${SWARM_EXTENSION_ID}:swarm.execute`;

    function swarmPorts(options: {
      evaluateDetailed: PermissionPolicy["evaluateDetailed"];
      resolveExtensionDeclaredPermission: ExtensionDeclaredPermissionResolver;
    }) {
      const sessionManager = testDouble<SessionManager>({
        getSessionScopeAsync: vi
          .fn<SessionManager["getSessionScopeAsync"]>()
          .mockResolvedValue(session()),
        listWorkspacesForSelfTools: vi
          .fn<SessionManager["listWorkspacesForSelfTools"]>()
          .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
      });
      return createProductionMarshalRuntimePorts({
        sessionManager,
        permissionPolicy: testDouble<PermissionPolicy>({
          evaluateDetailed: options.evaluateDetailed,
        }),
        workspaceDir: "Q:\\default-workspace",
        resolveExtensionDeclaredPermission: options.resolveExtensionDeclaredPermission,
      });
    }

    function swarmAuthorize(ports: ReturnType<typeof swarmPorts>) {
      return ports.authority.authorize({
        scope: { sessionId: "session-1", workspaceName: "Engineering" },
        capability: "swarm.runs.create",
        input: { objective: "objective" },
        permissions: ["swarm.execute"],
      });
    }

    it("authorizes a declared builtin id through the declaring extension's bucket when policy allows", async () => {
      const evaluateDetailed = vi
        .fn<PermissionPolicy["evaluateDetailed"]>()
        .mockReturnValue(testDouble({ decision: "approve" }));
      const ports = swarmPorts({
        evaluateDetailed,
        resolveExtensionDeclaredPermission: vi
          .fn<ExtensionDeclaredPermissionResolver>()
          .mockResolvedValue({ declared: true, extensionId: SWARM_EXTENSION_ID }),
      });

      await expect(swarmAuthorize(ports)).resolves.toMatchObject({ decision: "allow" });
      expect(evaluateDetailed).toHaveBeenCalledTimes(1);
      expect(evaluateDetailed).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: SWARM_BUCKET }),
      );
    });

    it("returns the policy ask decision for a declared builtin id (not swallowed into allow or deny)", async () => {
      const evaluateDetailed = vi
        .fn<PermissionPolicy["evaluateDetailed"]>()
        .mockReturnValue(testDouble({ decision: "prompt" }));
      const ports = swarmPorts({
        evaluateDetailed,
        resolveExtensionDeclaredPermission: vi
          .fn<ExtensionDeclaredPermissionResolver>()
          .mockResolvedValue({ declared: true, extensionId: SWARM_EXTENSION_ID }),
      });

      await expect(swarmAuthorize(ports)).resolves.toMatchObject({
        decision: "approval",
        prompt: `Approve Marshal Runtime tool "${SWARM_BUCKET}".`,
      });
      expect(evaluateDetailed).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: SWARM_BUCKET }),
      );
    });

    it("returns the policy deny decision for a declared builtin id", async () => {
      const evaluateDetailed = vi
        .fn<PermissionPolicy["evaluateDetailed"]>()
        .mockReturnValue(testDouble({ decision: "deny", denyReason: "Denied by test policy." }));
      const ports = swarmPorts({
        evaluateDetailed,
        resolveExtensionDeclaredPermission: vi
          .fn<ExtensionDeclaredPermissionResolver>()
          .mockResolvedValue({ declared: true, extensionId: SWARM_EXTENSION_ID }),
      });

      await expect(swarmAuthorize(ports)).resolves.toMatchObject({
        decision: "deny",
        code: "permission_denied",
        reason: "Denied by test policy.",
      });
      expect(evaluateDetailed).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: SWARM_BUCKET }),
      );
    });

    it("does not let a second extension declaring the same builtin id inherit the first's session grant (SF2-2)", async () => {
      // Simulates a session always-allow earned by @marshal/swarm under ITS
      // identity-qualified bucket; every other bucket prompts.
      const evaluateDetailed = vi
        .fn<PermissionPolicy["evaluateDetailed"]>()
        .mockImplementation((request) =>
          testDouble({
            decision:
              "toolName" in request && request.toolName === SWARM_BUCKET ? "approve" : "prompt",
          }),
        );
      const resolveExtensionDeclaredPermission = vi
        .fn<ExtensionDeclaredPermissionResolver>()
        .mockResolvedValueOnce({ declared: true, extensionId: SWARM_EXTENSION_ID })
        .mockResolvedValueOnce({ declared: true, extensionId: "@other/swarm-lookalike" });
      const ports = swarmPorts({ evaluateDetailed, resolveExtensionDeclaredPermission });

      await expect(swarmAuthorize(ports)).resolves.toMatchObject({ decision: "allow" });

      const otherBucket = `${EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX}@other/swarm-lookalike:swarm.execute`;
      await expect(swarmAuthorize(ports)).resolves.toMatchObject({ decision: "approval" });
      expect(evaluateDetailed).toHaveBeenLastCalledWith(
        expect.objectContaining({ toolName: otherBucket }),
      );
    });

    it("still grants the builtin allow, with no policy call, when no extension declares the builtin id (unchanged semantics)", async () => {
      const evaluateDetailed = vi.fn<PermissionPolicy["evaluateDetailed"]>();
      const ports = swarmPorts({
        evaluateDetailed,
        resolveExtensionDeclaredPermission: vi
          .fn<ExtensionDeclaredPermissionResolver>()
          .mockResolvedValue(false),
      });

      await expect(swarmAuthorize(ports)).resolves.toMatchObject({ decision: "allow" });
      expect(evaluateDetailed).not.toHaveBeenCalled();
    });
  });

  it("fails closed when the extension-declared permission resolver throws or rejects (F-R2)", async () => {
    const evaluateDetailed = vi.fn<PermissionPolicy["evaluateDetailed"]>();
    const onAuthorityDecision = vi.fn<(event: MarshalRuntimeAuthorityDecisionEvent) => void>();
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
    });
    const resolveExtensionDeclaredPermission = vi.fn<ExtensionDeclaredPermissionResolver>();
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({ evaluateDetailed }),
      workspaceDir: "Q:\\default-workspace",
      onAuthorityDecision,
      resolveExtensionDeclaredPermission,
    });
    const request = {
      scope: { sessionId: "session-1", workspaceName: "Engineering" },
      capability: "codereview.pr.list",
      input: { repo: "owner/name" },
      permissions: ["codereview.read"],
    } as const;

    resolveExtensionDeclaredPermission.mockImplementationOnce(() => {
      throw new Error("resolver blew up synchronously");
    });
    await expect(ports.authority.authorize(request)).resolves.toMatchObject({
      decision: "deny",
      code: "permission_denied",
      reason: "Marshal Runtime permission is not supported: codereview.read.",
    });
    expect(evaluateDetailed).not.toHaveBeenCalled();
    expect(onAuthorityDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: expect.objectContaining({ decision: "deny" }) }),
    );

    resolveExtensionDeclaredPermission.mockRejectedValueOnce(
      new Error("resolver rejected asynchronously"),
    );
    await expect(ports.authority.authorize(request)).resolves.toMatchObject({
      decision: "deny",
      code: "permission_denied",
      reason: "Marshal Runtime permission is not supported: codereview.read.",
    });
    expect(evaluateDetailed).not.toHaveBeenCalled();
    expect(onAuthorityDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: expect.objectContaining({ decision: "deny" }) }),
    );
  });

  it("denies a declared permission id colliding with a real self-tool name before consulting the resolver or policy, even with a pre-existing always-allow for that tool (Codex 22:48(ii))", async () => {
    const selfToolName = RUNTIME_SELF_TOOL_NAMES[0];
    // Simulates a stored session always-allow for the real self tool, under
    // both its own policy name and the namespaced extension-permission name —
    // the collision guard must deny before either is ever consulted.
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockReturnValue(testDouble({ decision: "approve" }));
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
    });
    // The resolver even reports the id as declared by an installed extension —
    // that must not matter; the guard runs before the resolver is ever asked.
    const resolveExtensionDeclaredPermission = vi
      .fn<ExtensionDeclaredPermissionResolver>()
      .mockResolvedValue({ declared: true, extensionId: "collision-extension" });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({ evaluateDetailed }),
      workspaceDir: "Q:\\default-workspace",
      resolveExtensionDeclaredPermission,
    });

    await expect(
      ports.authority.authorize({
        scope: { sessionId: "session-1", workspaceName: "Engineering" },
        capability: "extension.collision.capability",
        input: { value: 1 },
        permissions: [selfToolName],
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      code: "permission_denied",
      reason: `Marshal Runtime permission is not supported: ${selfToolName}.`,
    });
    expect(resolveExtensionDeclaredPermission).not.toHaveBeenCalled();
    expect(evaluateDetailed).not.toHaveBeenCalled();
  });

  it("guards builtin permission ids too, even though authorize() already consumes builtins earlier via continue (Codex 22:48(ii), defense in depth)", async () => {
    // Reconciler note (round-3 overlap resolution): the sibling defense-in-depth
    // commit now consults the resolver on the builtin branch too, so a builtin id
    // no longer bypasses it unconditionally. This case therefore pins the other
    // half of that guard — a GENUINE Marshal builtin capability, for which the
    // catalog-backed resolver answers "no extension declares this" — still gets
    // the implicit builtin allow with no policy prompt. The declared case (an
    // extension capability declaring the same id) routes to the declaring
    // extension's identity-qualified policy bucket (F-DEPLOY-5), covered by
    // "routes an extension-declared permission id that collides with a builtin
    // trusted permission name". The exported guard is asserted directly here,
    // per Codex 22:48(ii).
    expect(isReservedRuntimePermissionId(MARSHAL_RUNTIME_PERMISSION.memoryRecall)).toBe(true);

    const evaluateDetailed = vi.fn<PermissionPolicy["evaluateDetailed"]>();
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
    });
    // The real resolver asks "does an installed+enabled extension declare this
    // permission FOR THIS capability" — for marshal.memory.recall it does not.
    const resolveExtensionDeclaredPermission = vi
      .fn<ExtensionDeclaredPermissionResolver>()
      .mockResolvedValue(false);
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({ evaluateDetailed }),
      workspaceDir: "Q:\\default-workspace",
      resolveExtensionDeclaredPermission,
    });

    // Documents the preserved behavior: a real builtin capability is still
    // allowed via the earlier `continue`, with no policy evaluation.
    await expect(
      ports.authority.authorize({
        scope: { sessionId: "session-1", workspaceName: "Engineering" },
        capability: "marshal.memory.recall",
        input: { value: 1 },
        permissions: [MARSHAL_RUNTIME_PERMISSION.memoryRecall],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(resolveExtensionDeclaredPermission).toHaveBeenCalledWith(
      MARSHAL_RUNTIME_PERMISSION.memoryRecall,
      "marshal.memory.recall",
      expect.objectContaining({ sessionId: "session-1" }),
    );
    expect(evaluateDetailed).not.toHaveBeenCalled();
  });

  it("returns a pending explicit index approval and consumes only the matching resolution", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(tmpdir(), "marshal-runtime-approval-"));
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    try {
      const broker = new ApprovalBroker();
      const evaluateHardDenial = vi
        .fn<PermissionPolicy["evaluateHardDenial"]>()
        .mockReturnValue(testDouble({ decision: "prompt" }));
      const recordInteractiveOutcome = vi
        .fn<PermissionPolicy["recordInteractiveOutcome"]>()
        .mockReturnValue(true);
      const policy = testDouble<PermissionPolicy>({
        evaluateHardDenial,
        recordInteractiveOutcome,
        logInfraFailure: vi.fn<PermissionPolicy["logInfraFailure"]>(),
      });
      const ports = createProductionMarshalRuntimePorts({
        sessionManager: testDouble<SessionManager>({}),
        permissionPolicy: policy,
        approvalBroker: broker,
        workspaceDir: workspacePath,
      });
      const approval = ports.approval;
      if (!approval) throw new Error("Runtime approval port was not created.");
      const check = testDouble<PermissionCheck>({
        capability: testDouble({
          name: "code.index.initialize",
          description: "Initialize local repository intelligence.",
        }),
        request: testDouble({
          target: "code.index.initialize",
          input: { mode: "create-if-missing" },
        }),
        context: testDouble({
          scope: testDouble({ sessionId: "session-1", workspacePath }),
          executionId: "first-idempotency-key",
        }),
        requirements: [testDouble({ permission: "code.index.rebuild" })],
      });

      const requested = await approval.permissionApproval.requestApproval(check, [
        "code.index.rebuild",
      ]);
      expect(requested.approvalId).toEqual(expect.any(String));
      expect(broker.hasPending(requested.approvalId!)).toBe(true);
      expect(approval.status(requested.approvalId!)).toBe("pending");
      const coalescedCheck = {
        ...check,
        context: { ...check.context, executionId: "second-idempotency-key" },
      };
      const coalesced = await approval.permissionApproval.requestApproval(coalescedCheck, [
        "code.index.rebuild",
      ]);
      expect(coalesced.approvalId).toBe(requested.approvalId);
      approval.cancelRequest("session-1", "first-idempotency-key");
      expect(approval.status(requested.approvalId!)).toBe("pending");
      expect(broker.hasPending(requested.approvalId!)).toBe(true);
      await expect(access(path.join(workspacePath, ".marshal"))).rejects.toThrow("ENOENT");

      expect(broker.resolveSilent(requested.approvalId!, "allow")).toBe(false);
      expect(broker.hasPending(requested.approvalId!)).toBe(true);
      expect(broker.resolve(requested.approvalId!, "always-allow")).toBe(true);
      expect(recordInteractiveOutcome).toHaveBeenCalledWith(expect.anything(), "allow", "approved");
      expect(approval.status(requested.approvalId!)).toBe("approved");
      await expect(
        Promise.resolve().then(() =>
          approval.permissionApproval.verifyApproval(
            { approvalId: requested.approvalId, approved: true },
            coalescedCheck,
          ),
        ),
      ).resolves.toMatchObject({
        approved: true,
        permissions: ["code.index.rebuild"],
      });
      await expect(
        Promise.resolve().then(() =>
          approval.permissionApproval.verifyApproval({ approvalId: requested.approvalId }, check),
        ),
      ).rejects.toMatchObject({ code: "permission_denied" });

      const denied = await approval.permissionApproval.requestApproval(check, [
        "code.index.rebuild",
      ]);
      broker.resolve(denied.approvalId!, "deny");
      await expect(
        Promise.resolve().then(() =>
          approval.permissionApproval.verifyApproval({ approvalId: denied.approvalId }, check),
        ),
      ).rejects.toMatchObject({ code: "permission_denied" });

      const mismatched = await approval.permissionApproval.requestApproval(check, [
        "code.index.rebuild",
      ]);
      broker.resolve(mismatched.approvalId!, "allow");
      await expect(
        Promise.resolve().then(() =>
          approval.permissionApproval.verifyApproval(
            { approvalId: mismatched.approvalId },
            {
              ...check,
              request: { ...check.request, input: { mode: "different" } },
            },
          ),
        ),
      ).rejects.toMatchObject({ code: "permission_denied" });

      const expired = await approval.permissionApproval.requestApproval(check, [
        "code.index.rebuild",
      ]);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(approval.status(expired.approvalId!)).toBe("expired");
      await expect(
        Promise.resolve().then(() =>
          approval.permissionApproval.verifyApproval({ approvalId: expired.approvalId }, check),
        ),
      ).rejects.toMatchObject({ code: "permission_denied" });

      evaluateHardDenial.mockReturnValueOnce(
        testDouble({ decision: "deny", denyReason: "Workspace guardrail denied indexing." }),
      );
      await expect(
        Promise.resolve().then(() =>
          approval.permissionApproval.requestApproval(check, ["code.index.rebuild"]),
        ),
      ).rejects.toMatchObject({
        code: "permission_denied",
        message: "Workspace guardrail denied indexing.",
      });

      evaluateHardDenial
        .mockReturnValueOnce(testDouble({ decision: "prompt" }))
        .mockReturnValueOnce(
          testDouble({
            decision: "deny",
            denyReason: "Policy changed while approval was pending.",
          }),
        );
      const changedPolicy = await approval.permissionApproval.requestApproval(check, [
        "code.index.rebuild",
      ]);
      const recordedBeforeChangedPolicy = recordInteractiveOutcome.mock.calls.length;
      expect(broker.resolve(changedPolicy.approvalId!, "allow")).toBe(true);
      expect(approval.status(changedPolicy.approvalId!)).toBe("denied");
      expect(recordInteractiveOutcome).toHaveBeenCalledTimes(recordedBeforeChangedPolicy);
      await expect(
        Promise.resolve().then(() =>
          approval.permissionApproval.verifyApproval(
            { approvalId: changedPolicy.approvalId },
            check,
          ),
        ),
      ).rejects.toMatchObject({ code: "permission_denied" });

      evaluateHardDenial.mockReturnValue(testDouble({ decision: "prompt" }));
      const replacedWorkspace = await approval.permissionApproval.requestApproval(check, [
        "code.index.rebuild",
      ]);
      await rm(workspacePath, { recursive: true });
      await mkdir(workspacePath);
      expect(broker.resolve(replacedWorkspace.approvalId!, "allow")).toBe(true);
      expect(approval.status(replacedWorkspace.approvalId!)).toBe("denied");

      const controller = new AbortController();
      const aborted = await approval.permissionApproval.requestApproval(
        {
          ...check,
          context: {
            ...check.context,
            executionId: "aborted-request",
            signal: controller.signal,
          },
        },
        ["code.index.rebuild"],
      );
      controller.abort();
      approval.cancelRequest("session-1", "aborted-request");
      expect(approval.status(aborted.approvalId!)).toBe("missing");
      expect(broker.hasPending(aborted.approvalId!)).toBe(false);

      const disposed = await approval.permissionApproval.requestApproval(check, [
        "code.index.rebuild",
      ]);
      broker.resolve(disposed.approvalId!, "allow");
      expect(approval.status(disposed.approvalId!)).toBe("approved");
      approval.dispose();
      expect(approval.status(disposed.approvalId!)).toBe("missing");
      await expect(access(path.join(workspacePath, ".marshal"))).rejects.toThrow("ENOENT");
    } finally {
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies fail-closed without minting a card when the invocation forbids approval prompts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "marshal-runtime-approval-"));
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    try {
      const broker = new ApprovalBroker();
      const promptSpy = vi.spyOn(broker, "requestTransientPrompt");
      const ports = createProductionMarshalRuntimePorts({
        sessionManager: testDouble<SessionManager>({}),
        permissionPolicy: testDouble<PermissionPolicy>({
          evaluateHardDenial: vi
            .fn<PermissionPolicy["evaluateHardDenial"]>()
            .mockReturnValue(testDouble({ decision: "prompt" })),
        }),
        approvalBroker: broker,
        workspaceDir: workspacePath,
      });
      const approval = ports.approval;
      if (!approval) throw new Error("Runtime approval port was not created.");
      const check = testDouble<PermissionCheck>({
        capability: testDouble({ name: "swarm.runs.evidence-list", description: "List evidence." }),
        request: testDouble({ target: "swarm.runs.evidence-list", input: {} }),
        context: testDouble({
          scope: testDouble({ sessionId: "session-1", workspacePath }),
          executionId: "background-poll",
          metadata: { marshalApprovalPolicy: "forbid" },
        }),
        requirements: [testDouble({ permission: "swarm.evidence.read" })],
      });
      await expect(
        Promise.resolve().then(() =>
          approval.permissionApproval.requestApproval(check, ["swarm.evidence.read"]),
        ),
      ).rejects.toMatchObject({ code: "permission_denied" });
      expect(promptSpy).not.toHaveBeenCalled();

      // An explicit invocation (no forbid flag) still opens the normal prompt.
      const explicitCheck = testDouble<PermissionCheck>({
        capability: testDouble({ name: "swarm.runs.evidence-list", description: "List evidence." }),
        request: testDouble({ target: "swarm.runs.evidence-list", input: {} }),
        context: testDouble({
          scope: testDouble({ sessionId: "session-1", workspacePath }),
          executionId: "explicit-request",
          metadata: {},
        }),
        requirements: [testDouble({ permission: "swarm.evidence.read" })],
      });
      const requested = await approval.permissionApproval.requestApproval(explicitCheck, [
        "swarm.evidence.read",
      ]);
      expect(requested.approvalId).toEqual(expect.any(String));
      expect(promptSpy).toHaveBeenCalledTimes(1);
      approval.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("createExtensionDeclaredPermissionResolver (F-DEPLOY-4)", () => {
  function scope(): ResolvedMarshalRuntimeScope {
    return {
      sessionId: "session-1",
      workspaceName: "Engineering",
      workspacePath: "Q:\\workspaces\\engineering",
    };
  }

  it("scopes MarshalRuntimeHost.search by workspace metadata, not just workspacePath (F-DEPLOY-4)", async () => {
    // The kernel's own resolveWorkspace callback (host.ts's
    // resolveRuntimeWorkspace) reads the workspace name from
    // context.metadata[WORKSPACE_METADATA_KEY] — a top-level workspacePath
    // field alone throws invalid_scope. This is the exact defect that made
    // every extension-declared permission check fail closed in production.
    const search = vi.fn<MarshalRuntimeHost["search"]>().mockResolvedValue({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      query: "",
      detail: "full",
      matches: [
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          score: 1,
          matchedTerms: [],
          matchedFields: [],
          capability: {
            protocolVersion: RUNTIME_PROTOCOL_VERSION,
            name: "codereview.accounts.list",
            version: "1.0.0",
            description: "List code review accounts.",
            outputSchema: {},
            permissions: [{ permission: "codereview.read" }],
            provider: { id: "codereview-provider" },
          },
        },
      ],
    });
    const resolveExtensionOwningProvider = vi
      .fn<MarshalRuntimeHost["resolveExtensionOwningProvider"]>()
      .mockResolvedValue("@marshal/code-review");
    const resolver = createExtensionDeclaredPermissionResolver({
      search,
      resolveExtensionOwningProvider,
      isHostRegisteredCapabilityProvider:
        vi.fn<MarshalRuntimeHost["isHostRegisteredCapabilityProvider"]>(),
    });

    await expect(resolver("codereview.read", "codereview.accounts.list", scope())).resolves.toEqual(
      { declared: true, extensionId: "@marshal/code-review" },
    );

    expect(search).toHaveBeenCalledWith(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, name: "codereview.accounts.list" },
      {
        sessionId: "session-1",
        workspacePath: "Q:\\workspaces\\engineering",
        metadata: { [WORKSPACE_METADATA_KEY]: "Engineering" },
      },
    );
    expect(resolveExtensionOwningProvider).toHaveBeenCalledWith("codereview-provider");
  });

  it("returns false without a breadcrumb when no live match declares the permission", async () => {
    const search = vi.fn<MarshalRuntimeHost["search"]>().mockResolvedValue({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      query: "",
      detail: "full",
      matches: [],
    });
    const { entries, remove } = captureBreadcrumbs();
    try {
      const resolver = createExtensionDeclaredPermissionResolver({
        search,
        resolveExtensionOwningProvider:
          vi.fn<MarshalRuntimeHost["resolveExtensionOwningProvider"]>(),
        isHostRegisteredCapabilityProvider:
          vi.fn<MarshalRuntimeHost["isHostRegisteredCapabilityProvider"]>(),
      });
      await expect(resolver("codereview.write", "codereview.accounts.list", scope())).resolves.toBe(
        false,
      );
      expect(entries).toEqual([]);
    } finally {
      remove();
    }
  });

  it("returns indeterminate and logs a resolver-search-threw breadcrumb when the kernel search throws (F-DEPLOY-4 / F-DEPLOY-5b)", async () => {
    const search = vi
      .fn<MarshalRuntimeHost["search"]>()
      .mockRejectedValue(Object.assign(new Error("boom"), { code: "invalid_scope" }));
    const { entries, remove } = captureBreadcrumbs();
    try {
      const resolver = createExtensionDeclaredPermissionResolver({
        search,
        resolveExtensionOwningProvider:
          vi.fn<MarshalRuntimeHost["resolveExtensionOwningProvider"]>(),
        isHostRegisteredCapabilityProvider:
          vi.fn<MarshalRuntimeHost["isHostRegisteredCapabilityProvider"]>(),
      });
      await expect(
        resolver("codereview.read", "codereview.accounts.list", scope()),
      ).resolves.toEqual({ indeterminate: true, reason: "resolver-search-threw" });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.args[1]).toMatchObject({
        reason: "resolver-search-threw",
        permission: "codereview.read",
        capability: "codereview.accounts.list",
      });
      // Never logs input values or customer content beyond the permission id
      // (already surfaced in the deny reason string) and capability name.
      expect(JSON.stringify(entries[0]?.args)).not.toContain("boom");
    } finally {
      remove();
    }
  });

  function declaringCodereviewSearch(): ReturnType<MarshalRuntimeHost["search"]> {
    return Promise.resolve({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      query: "",
      detail: "full",
      matches: [
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          score: 1,
          matchedTerms: [],
          matchedFields: [],
          capability: {
            protocolVersion: RUNTIME_PROTOCOL_VERSION,
            name: "codereview.accounts.list",
            version: "1.0.0",
            description: "List code review accounts.",
            outputSchema: {},
            permissions: [{ permission: "codereview.read" }],
            provider: { id: "codereview-provider" },
          },
        },
      ],
    });
  }

  it("returns false without a breadcrumb when the owner lookup returns null and the provider carries affirmative host provenance (F-DEPLOY-5c)", async () => {
    const { entries, remove } = captureBreadcrumbs();
    try {
      const isHostRegisteredCapabilityProvider = vi
        .fn<MarshalRuntimeHost["isHostRegisteredCapabilityProvider"]>()
        .mockResolvedValue(true);
      const resolver = createExtensionDeclaredPermissionResolver({
        search: vi.fn<MarshalRuntimeHost["search"]>().mockReturnValue(declaringCodereviewSearch()),
        resolveExtensionOwningProvider: vi
          .fn<MarshalRuntimeHost["resolveExtensionOwningProvider"]>()
          .mockResolvedValue(null),
        isHostRegisteredCapabilityProvider,
      });
      await expect(resolver("codereview.read", "codereview.accounts.list", scope())).resolves.toBe(
        false,
      );
      expect(isHostRegisteredCapabilityProvider).toHaveBeenCalledWith("codereview-provider");
      expect(entries).toEqual([]);
    } finally {
      remove();
    }
  });

  it("returns indeterminate and logs an owner-unresolved breadcrumb when the owner lookup returns null WITHOUT host provenance (F-DEPLOY-5b / F-DEPLOY-5c)", async () => {
    const { entries, remove } = captureBreadcrumbs();
    try {
      const resolver = createExtensionDeclaredPermissionResolver({
        search: vi.fn<MarshalRuntimeHost["search"]>().mockReturnValue(declaringCodereviewSearch()),
        resolveExtensionOwningProvider: vi
          .fn<MarshalRuntimeHost["resolveExtensionOwningProvider"]>()
          .mockResolvedValue(null),
        isHostRegisteredCapabilityProvider: vi
          .fn<MarshalRuntimeHost["isHostRegisteredCapabilityProvider"]>()
          .mockResolvedValue(false),
      });
      await expect(
        resolver("codereview.read", "codereview.accounts.list", scope()),
      ).resolves.toEqual({ indeterminate: true, reason: "owner-unresolved" });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.args[1]).toMatchObject({ reason: "owner-unresolved" });
    } finally {
      remove();
    }
  });

  it("returns indeterminate and logs an owner-unresolved breadcrumb when the host-provenance lookup throws (F-DEPLOY-5c)", async () => {
    const { entries, remove } = captureBreadcrumbs();
    try {
      const resolver = createExtensionDeclaredPermissionResolver({
        search: vi.fn<MarshalRuntimeHost["search"]>().mockReturnValue(declaringCodereviewSearch()),
        resolveExtensionOwningProvider: vi
          .fn<MarshalRuntimeHost["resolveExtensionOwningProvider"]>()
          .mockResolvedValue(null),
        isHostRegisteredCapabilityProvider: vi
          .fn<MarshalRuntimeHost["isHostRegisteredCapabilityProvider"]>()
          .mockRejectedValue(new Error("bindings unavailable")),
      });
      await expect(
        resolver("codereview.read", "codereview.accounts.list", scope()),
      ).resolves.toEqual({ indeterminate: true, reason: "owner-unresolved" });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.args[1]).toMatchObject({ reason: "owner-unresolved" });
      expect(JSON.stringify(entries[0]?.args)).not.toContain("bindings unavailable");
    } finally {
      remove();
    }
  });

  it("returns indeterminate and logs a capability-missing-at-authorize breadcrumb without calling search (F-DEPLOY-4 / F-DEPLOY-5b)", async () => {
    const search = vi.fn<MarshalRuntimeHost["search"]>();
    const { entries, remove } = captureBreadcrumbs();
    try {
      const resolver = createExtensionDeclaredPermissionResolver({
        search,
        resolveExtensionOwningProvider:
          vi.fn<MarshalRuntimeHost["resolveExtensionOwningProvider"]>(),
        isHostRegisteredCapabilityProvider:
          vi.fn<MarshalRuntimeHost["isHostRegisteredCapabilityProvider"]>(),
      });
      await expect(resolver("codereview.read", "", scope())).resolves.toEqual({
        indeterminate: true,
        reason: "capability-missing-at-authorize",
      });
      expect(search).not.toHaveBeenCalled();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.args[1]).toMatchObject({ reason: "capability-missing-at-authorize" });
    } finally {
      remove();
    }
  });
});

describe("F-DEPLOY-5b: unresolved/invalid ownership fails closed on the builtin branch (Codex adjudication)", () => {
  // r1-r3 drive the REAL createExtensionDeclaredPermissionResolver through the
  // production authorize() builtin branch. Honest red at unmodified bd211dcc0:
  // every resolver-infrastructure failure
  // collapsed to `false`, which the builtin branch read as "not declared" →
  // unconditional builtin allow — a kernel outage silently disarmed the F-R2
  // guard. Post-fix these deny with the ownership-unverified reason while the
  // resolver's existing breadcrumbs still fire exactly once each.
  const OWNERSHIP_DENY =
    "Marshal Runtime permission ownership could not be verified: swarm.execute.";

  function declaringSwarmSearchResponse(): Awaited<ReturnType<MarshalRuntimeHost["search"]>> {
    return {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      query: "",
      detail: "full",
      matches: [
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          score: 1,
          matchedTerms: [],
          matchedFields: [],
          capability: {
            protocolVersion: RUNTIME_PROTOCOL_VERSION,
            name: "swarm.runs.create",
            version: "1.0.0",
            description: "Create a swarm run.",
            outputSchema: {},
            permissions: [{ permission: "swarm.execute" }],
            provider: { id: "swarm-provider" },
          },
        },
      ],
    };
  }

  function portsWithRealResolver(options: {
    host: Pick<
      MarshalRuntimeHost,
      "search" | "resolveExtensionOwningProvider" | "isHostRegisteredCapabilityProvider"
    >;
    evaluateDetailed?: PermissionPolicy["evaluateDetailed"];
  }) {
    const evaluateDetailed =
      options.evaluateDetailed ?? vi.fn<PermissionPolicy["evaluateDetailed"]>();
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
    });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({ evaluateDetailed }),
      workspaceDir: "Q:\\default-workspace",
      resolveExtensionDeclaredPermission: createExtensionDeclaredPermissionResolver(options.host),
    });
    return { ports, evaluateDetailed };
  }

  function invokeSwarmBuiltin(ports: ReturnType<typeof portsWithRealResolver>["ports"]) {
    return ports.authority.authorize({
      scope: { sessionId: "session-1", workspaceName: "Engineering" },
      capability: "swarm.runs.create",
      input: { objective: "objective" },
      permissions: ["swarm.execute"],
    });
  }

  it("denies a builtin permission invoke when the kernel catalog search throws (r1)", async () => {
    const { entries, remove } = captureBreadcrumbs();
    try {
      const { ports, evaluateDetailed } = portsWithRealResolver({
        host: {
          search: vi
            .fn<MarshalRuntimeHost["search"]>()
            .mockRejectedValue(new Error("kernel search infrastructure down")),
          resolveExtensionOwningProvider:
            vi.fn<MarshalRuntimeHost["resolveExtensionOwningProvider"]>(),
          isHostRegisteredCapabilityProvider:
            vi.fn<MarshalRuntimeHost["isHostRegisteredCapabilityProvider"]>(),
        },
      });
      await expect(invokeSwarmBuiltin(ports)).resolves.toMatchObject({
        decision: "deny",
        code: "permission_denied",
        reason: OWNERSHIP_DENY,
      });
      expect(evaluateDetailed).not.toHaveBeenCalled();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.args[1]).toMatchObject({ reason: "resolver-search-threw" });
    } finally {
      remove();
    }
  });

  it("denies a builtin permission invoke when the owning extension resolves to null WITHOUT affirmative host provenance (r2, F-DEPLOY-5c)", async () => {
    // F-DEPLOY-5c: a verified host-registered provider (affirmative provenance)
    // now routes owner-null to the builtin allow — see the F-DEPLOY-5c block
    // below. A null WITHOUT provenance stays the 5b indeterminate deny: it is
    // exactly the enable/disable race window shape where an extension's
    // provider is kernel-visible before (or after) its lifecycle projection.
    const { entries, remove } = captureBreadcrumbs();
    try {
      const { ports, evaluateDetailed } = portsWithRealResolver({
        host: {
          search: vi
            .fn<MarshalRuntimeHost["search"]>()
            .mockResolvedValue(declaringSwarmSearchResponse()),
          resolveExtensionOwningProvider: vi
            .fn<MarshalRuntimeHost["resolveExtensionOwningProvider"]>()
            .mockResolvedValue(null),
          isHostRegisteredCapabilityProvider: vi
            .fn<MarshalRuntimeHost["isHostRegisteredCapabilityProvider"]>()
            .mockResolvedValue(false),
        },
      });
      await expect(invokeSwarmBuiltin(ports)).resolves.toMatchObject({
        decision: "deny",
        code: "permission_denied",
        reason: OWNERSHIP_DENY,
      });
      expect(evaluateDetailed).not.toHaveBeenCalled();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.args[1]).toMatchObject({ reason: "owner-unresolved" });
    } finally {
      remove();
    }
  });

  it("denies a builtin permission invoke when the owning-extension lookup throws (r3)", async () => {
    const { entries, remove } = captureBreadcrumbs();
    try {
      const { ports, evaluateDetailed } = portsWithRealResolver({
        host: {
          search: vi
            .fn<MarshalRuntimeHost["search"]>()
            .mockResolvedValue(declaringSwarmSearchResponse()),
          resolveExtensionOwningProvider: vi
            .fn<MarshalRuntimeHost["resolveExtensionOwningProvider"]>()
            .mockRejectedValue(new Error("owner lookup infrastructure down")),
          isHostRegisteredCapabilityProvider:
            vi.fn<MarshalRuntimeHost["isHostRegisteredCapabilityProvider"]>(),
        },
      });
      await expect(invokeSwarmBuiltin(ports)).resolves.toMatchObject({
        decision: "deny",
        code: "permission_denied",
        reason: OWNERSHIP_DENY,
      });
      expect(evaluateDetailed).not.toHaveBeenCalled();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.args[1]).toMatchObject({ reason: "owner-unresolved" });
    } finally {
      remove();
    }
  });

  it("keeps the unconditional builtin allow, zero policy calls, when search succeeds and no descriptor declares the id (g4)", async () => {
    const { entries, remove } = captureBreadcrumbs();
    try {
      const { ports, evaluateDetailed } = portsWithRealResolver({
        host: {
          search: vi.fn<MarshalRuntimeHost["search"]>().mockResolvedValue({
            protocolVersion: RUNTIME_PROTOCOL_VERSION,
            query: "",
            detail: "full",
            matches: [],
          }),
          resolveExtensionOwningProvider:
            vi.fn<MarshalRuntimeHost["resolveExtensionOwningProvider"]>(),
          isHostRegisteredCapabilityProvider:
            vi.fn<MarshalRuntimeHost["isHostRegisteredCapabilityProvider"]>(),
        },
      });
      await expect(invokeSwarmBuiltin(ports)).resolves.toMatchObject({ decision: "allow" });
      expect(evaluateDetailed).not.toHaveBeenCalled();
      expect(entries).toEqual([]);
    } finally {
      remove();
    }
  });

  it("keeps the identity-qualified policy route for a verified declared builtin id (g5)", async () => {
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockReturnValue(testDouble({ decision: "approve" }));
    const { ports } = portsWithRealResolver({
      evaluateDetailed,
      host: {
        search: vi
          .fn<MarshalRuntimeHost["search"]>()
          .mockResolvedValue(declaringSwarmSearchResponse()),
        resolveExtensionOwningProvider: vi
          .fn<MarshalRuntimeHost["resolveExtensionOwningProvider"]>()
          .mockResolvedValue("@marshal/swarm"),
        isHostRegisteredCapabilityProvider:
          vi.fn<MarshalRuntimeHost["isHostRegisteredCapabilityProvider"]>(),
      },
    });
    await expect(invokeSwarmBuiltin(ports)).resolves.toMatchObject({ decision: "allow" });
    expect(evaluateDetailed).toHaveBeenCalledTimes(1);
    expect(evaluateDetailed).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: `${EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX}@marshal/swarm:swarm.execute`,
      }),
    );
  });

  it("indeterminate on the non-builtin declared branch still falls through to the unsupported-permission deny (g6)", async () => {
    const evaluateDetailed = vi.fn<PermissionPolicy["evaluateDetailed"]>();
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
    });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({ evaluateDetailed }),
      workspaceDir: "Q:\\default-workspace",
      resolveExtensionDeclaredPermission: vi
        .fn<ExtensionDeclaredPermissionResolver>()
        .mockResolvedValue({ indeterminate: true, reason: "resolver-search-threw" }),
    });

    await expect(
      ports.authority.authorize({
        scope: { sessionId: "session-1", workspaceName: "Engineering" },
        capability: "codereview.pr.list",
        input: { repo: "owner/name" },
        permissions: ["codereview.read"],
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      code: "permission_denied",
      reason: "Marshal Runtime permission is not supported: codereview.read.",
    });
    expect(evaluateDetailed).not.toHaveBeenCalled();
  });

  it("indeterminate blocks (never bypasses) the F-R2 self-tool smuggle guard (g7)", async () => {
    // Simulates a stored session always-allow for the real "runtimeInvoke"
    // self tool; an unverifiable declaration on the marshal.tool.invoke:
    // channel must deny, never fall through to policyDecision("runtimeInvoke").
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockReturnValue(testDouble({ decision: "approve" }));
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
    });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({ evaluateDetailed }),
      workspaceDir: "Q:\\default-workspace",
      resolveExtensionDeclaredPermission: vi
        .fn<ExtensionDeclaredPermissionResolver>()
        .mockResolvedValue({ indeterminate: true, reason: "owner-unresolved" }),
    });

    await expect(
      ports.authority.authorize({
        scope: { sessionId: "session-1", workspaceName: "Engineering" },
        capability: "extension.runtime-invoke.capability",
        input: { value: 1 },
        permissions: [`${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}runtimeInvoke`],
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      code: "permission_denied",
      reason: `Marshal Runtime permission is not supported: ${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}runtimeInvoke.`,
    });
    expect(evaluateDetailed).not.toHaveBeenCalled();
  });
});

describe("F-DEPLOY-5c: affirmative host provenance routes owner-null to the builtin allow", () => {
  // r1/r2 reproduce the two live casualties of the F-DEPLOY-5b fail-closed
  // deny (05:01:53Z + 36 further denials): host-registered capability
  // descriptors legitimately declare builtin permission ids
  // (runtime.delegation.spawn via marshal.delegation, ui.application.* via
  // marshal.runtime-ui), the extension-owner lookup verifiably returns null
  // for them, and 5b's blanket owner-null→indeterminate denied the builtin
  // invoke with "ownership could not be verified". Honest red at unmodified
  // 09d7e72b7. Post-fix: owner-null PLUS
  // affirmative host provenance (MarshalRuntimeHost.isHostRegisteredCapabilityProvider,
  // backed by the bindings.providers bootstrap registry) is verified
  // not-extension-declared → the plain builtin allow with zero policy calls.
  // Owner-null WITHOUT provenance still denies (see r2 in the 5b block above).
  function hostOwnedSearchResponse(options: {
    capability: string;
    permission: string;
    providerId: string;
  }): Awaited<ReturnType<MarshalRuntimeHost["search"]>> {
    return {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      query: "",
      detail: "full",
      matches: [
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          score: 1,
          matchedTerms: [],
          matchedFields: [],
          capability: {
            protocolVersion: RUNTIME_PROTOCOL_VERSION,
            name: options.capability,
            version: "1.0.0",
            description: "Host-registered capability.",
            outputSchema: {},
            permissions: [{ permission: options.permission }],
            provider: { id: options.providerId },
          },
        },
      ],
    };
  }

  function portsWithHostOwnedResolver(options: {
    capability: string;
    permission: string;
    providerId: string;
  }) {
    const evaluateDetailed = vi.fn<PermissionPolicy["evaluateDetailed"]>();
    const isHostRegisteredCapabilityProvider = vi
      .fn<MarshalRuntimeHost["isHostRegisteredCapabilityProvider"]>()
      .mockResolvedValue(true);
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
    });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({ evaluateDetailed }),
      workspaceDir: "Q:\\default-workspace",
      resolveExtensionDeclaredPermission: createExtensionDeclaredPermissionResolver({
        search: vi
          .fn<MarshalRuntimeHost["search"]>()
          .mockResolvedValue(hostOwnedSearchResponse(options)),
        resolveExtensionOwningProvider: vi
          .fn<MarshalRuntimeHost["resolveExtensionOwningProvider"]>()
          .mockResolvedValue(null),
        isHostRegisteredCapabilityProvider,
      }),
    });
    return { ports, evaluateDetailed, isHostRegisteredCapabilityProvider };
  }

  it("grants the builtin allow with zero policy calls for host-owned runtime.delegation.spawn (r1)", async () => {
    const { entries, remove } = captureBreadcrumbs();
    try {
      const { ports, evaluateDetailed, isHostRegisteredCapabilityProvider } =
        portsWithHostOwnedResolver({
          capability: "runtime.delegation.spawn",
          permission: "runtime.delegation.spawn",
          providerId: "marshal.delegation",
        });
      await expect(
        ports.authority.authorize({
          scope: { sessionId: "session-1", workspaceName: "Engineering" },
          capability: "runtime.delegation.spawn",
          input: { prompt: "objective" },
          permissions: ["runtime.delegation.spawn"],
        }),
      ).resolves.toMatchObject({ decision: "allow" });
      expect(evaluateDetailed).not.toHaveBeenCalled();
      expect(isHostRegisteredCapabilityProvider).toHaveBeenCalledWith("marshal.delegation");
      // Verified-null is steady state for every host capability — it must not
      // spam warn breadcrumbs (F-DEPLOY-5c breadcrumb demotion).
      expect(entries).toEqual([]);
    } finally {
      remove();
    }
  });

  it("grants the builtin allow with zero policy calls for host-owned marshal.ui.application.list (r2)", async () => {
    const { entries, remove } = captureBreadcrumbs();
    try {
      const { ports, evaluateDetailed, isHostRegisteredCapabilityProvider } =
        portsWithHostOwnedResolver({
          capability: "ui.application.list",
          permission: "marshal.ui.application.list",
          providerId: "marshal.runtime-ui",
        });
      await expect(
        ports.authority.authorize({
          scope: { sessionId: "session-1", workspaceName: "Engineering" },
          capability: "ui.application.list",
          input: {},
          permissions: ["marshal.ui.application.list"],
        }),
      ).resolves.toMatchObject({ decision: "allow" });
      expect(evaluateDetailed).not.toHaveBeenCalled();
      expect(isHostRegisteredCapabilityProvider).toHaveBeenCalledWith("marshal.runtime-ui");
      expect(entries).toEqual([]);
    } finally {
      remove();
    }
  });

  it("keeps the unsupported-permission deny for a NON-builtin declared id whose owner is null even with host provenance (g6)", async () => {
    // `false` semantics on the dedicated extension-declared branch are
    // unchanged by F-DEPLOY-5c: a host-owned descriptor declaring a
    // non-builtin id has no policy bucket to route to, so it falls through to
    // the unsupported-permission deny exactly as before.
    const { ports, evaluateDetailed } = portsWithHostOwnedResolver({
      capability: "codereview.pr.list",
      permission: "codereview.read",
      providerId: "marshal.codereview-host",
    });
    await expect(
      ports.authority.authorize({
        scope: { sessionId: "session-1", workspaceName: "Engineering" },
        capability: "codereview.pr.list",
        input: { repo: "owner/name" },
        permissions: ["codereview.read"],
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      code: "permission_denied",
      reason: "Marshal Runtime permission is not supported: codereview.read.",
    });
    expect(evaluateDetailed).not.toHaveBeenCalled();
  });
});

describe("portable-ui permission policy routing (authored React surface)", () => {
  function harness(opts: {
    evaluateDetailed: PermissionPolicy["evaluateDetailed"];
    resolver?: ExtensionDeclaredPermissionResolver;
    withResolver?: boolean;
  }) {
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: vi
        .fn<SessionManager["getSessionScopeAsync"]>()
        .mockResolvedValue(session()),
      listWorkspacesForSelfTools: vi
        .fn<SessionManager["listWorkspacesForSelfTools"]>()
        .mockReturnValue([{ name: "Engineering", path: "Q:\\workspaces\\engineering" }]),
    });
    return createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy: testDouble<PermissionPolicy>({ evaluateDetailed: opts.evaluateDetailed }),
      workspaceDir: "Q:\\default-workspace",
      ...(opts.withResolver === false
        ? {}
        : {
            resolveExtensionDeclaredPermission:
              opts.resolver ??
              (vi
                .fn<ExtensionDeclaredPermissionResolver>()
                .mockResolvedValue(false) as ExtensionDeclaredPermissionResolver),
          }),
    });
  }
  const scope = { sessionId: "session-1", workspaceName: "Engineering" } as const;

  it("routes verified builtin-owned portable-ui permissions to the namespaced policy bucket", async () => {
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockReturnValue(testDouble({ decision: "approve" }));
    const ports = harness({ evaluateDetailed });
    await expect(
      ports.authority.authorize({
        scope,
        capability: "ui.compile",
        input: { entryPath: "panel.tsx" },
        permissions: ["trusted_ui"],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(evaluateDetailed).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "runtime-portable-ui:trusted_ui" }),
    );
  });

  it("propagates the policy's prompt decision instead of allowing or denying silently", async () => {
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockReturnValue(testDouble({ decision: "prompt" }));
    const ports = harness({ evaluateDetailed });
    await expect(
      ports.authority.authorize({
        scope,
        capability: "ui.render",
        input: {},
        permissions: ["ui.render"],
      }),
    ).resolves.toMatchObject({ decision: "approval" });
  });

  it("propagates the policy's deny (reviewer/tool-free restrictions stay enforced by policy)", async () => {
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockReturnValue(testDouble({ decision: "deny", denyReason: "reviewer scope" }));
    const ports = harness({ evaluateDetailed });
    await expect(
      ports.authority.authorize({
        scope,
        capability: "ui.applications.list",
        input: {},
        permissions: ["ui.applications.list"],
      }),
    ).resolves.toMatchObject({ decision: "deny" });
  });

  it("routes an extension-declared match for a portable-ui id to the EXTENSION bucket, never the portable bucket (spoof prevention)", async () => {
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockReturnValue(testDouble({ decision: "approve" }));
    const resolver = vi
      .fn<ExtensionDeclaredPermissionResolver>()
      .mockResolvedValue({ declared: true, extensionId: "evil-extension" });
    const ports = harness({ evaluateDetailed, resolver });
    await expect(
      ports.authority.authorize({
        scope,
        capability: "ui.compile",
        input: {},
        permissions: ["trusted_ui"],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(evaluateDetailed).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "runtime-extension:evil-extension:trusted_ui" }),
    );
    expect(evaluateDetailed).not.toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "runtime-portable-ui:trusted_ui" }),
    );
  });

  it("denies fail-closed on an indeterminate ownership result", async () => {
    const evaluateDetailed = vi.fn<PermissionPolicy["evaluateDetailed"]>();
    const resolver = vi
      .fn<ExtensionDeclaredPermissionResolver>()
      .mockResolvedValue({ indeterminate: true, reason: "resolver-search-threw" });
    const ports = harness({ evaluateDetailed, resolver });
    await expect(
      ports.authority.authorize({
        scope,
        capability: "ui.render",
        input: {},
        permissions: ["ui.render"],
      }),
    ).resolves.toMatchObject({ decision: "deny" });
    expect(evaluateDetailed).not.toHaveBeenCalled();
  });

  it("denies fail-closed when no declared-permission resolver is wired", async () => {
    const evaluateDetailed = vi.fn<PermissionPolicy["evaluateDetailed"]>();
    const ports = harness({ evaluateDetailed, withResolver: false });
    await expect(
      ports.authority.authorize({
        scope,
        capability: "ui.compile",
        input: {},
        permissions: ["trusted_ui"],
      }),
    ).resolves.toMatchObject({ decision: "deny" });
    expect(evaluateDetailed).not.toHaveBeenCalled();
  });

  it("routes authored-state read and write pairs to their exact policy buckets", async () => {
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockReturnValue(testDouble({ decision: "approve" }));
    const ports = harness({ evaluateDetailed });
    await expect(
      ports.authority.authorize({
        scope,
        capability: "ui.authored.list",
        input: {},
        permissions: ["ui.authored.read"],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(evaluateDetailed).toHaveBeenLastCalledWith(
      expect.objectContaining({ toolName: "runtime-portable-ui:ui.authored.read" }),
    );
    evaluateDetailed.mockReturnValue(testDouble({ decision: "prompt" }));
    await expect(
      ports.authority.authorize({
        scope,
        capability: "ui.authored.create",
        input: { request: {} },
        permissions: ["ui.authored.write"],
      }),
    ).resolves.toMatchObject({ decision: "approval" });
    expect(evaluateDetailed).toHaveBeenLastCalledWith(
      expect.objectContaining({ toolName: "runtime-portable-ui:ui.authored.write" }),
    );
  });

  it("routes an extension-declared ui.authored.write to the extension bucket (ownership fail-closed)", async () => {
    const evaluateDetailed = vi
      .fn<PermissionPolicy["evaluateDetailed"]>()
      .mockReturnValue(testDouble({ decision: "approve" }));
    const resolver = vi
      .fn<ExtensionDeclaredPermissionResolver>()
      .mockResolvedValue({ declared: true, extensionId: "evil-extension" });
    const ports = harness({ evaluateDetailed, resolver });
    await expect(
      ports.authority.authorize({
        scope,
        capability: "ui.authored.create",
        input: {},
        permissions: ["ui.authored.write"],
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(evaluateDetailed).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "runtime-extension:evil-extension:ui.authored.write" }),
    );
    expect(evaluateDetailed).not.toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "runtime-portable-ui:ui.authored.write" }),
    );
  });

  it("does not route an authored permission id paired with the wrong authored capability", async () => {
    const evaluateDetailed = vi.fn<PermissionPolicy["evaluateDetailed"]>();
    const resolver = vi.fn<ExtensionDeclaredPermissionResolver>().mockResolvedValue(false);
    const ports = harness({ evaluateDetailed, resolver });
    await expect(
      ports.authority.authorize({
        scope,
        capability: "ui.authored.create",
        input: {},
        permissions: ["ui.authored.read"],
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("not supported"),
    });
    expect(evaluateDetailed).not.toHaveBeenCalled();
  });

  it("does not route a portable-ui permission id on a foreign capability (pair pinning)", async () => {
    const evaluateDetailed = vi.fn<PermissionPolicy["evaluateDetailed"]>();
    const resolver = vi.fn<ExtensionDeclaredPermissionResolver>().mockResolvedValue(false);
    const ports = harness({ evaluateDetailed, resolver });
    await expect(
      ports.authority.authorize({
        scope,
        capability: "evil.compile",
        input: {},
        permissions: ["trusted_ui"],
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("not supported"),
    });
    expect(evaluateDetailed).not.toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "runtime-portable-ui:trusted_ui" }),
    );
  });
});
