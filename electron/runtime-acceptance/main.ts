import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type RuntimeHostProviderSource,
} from "@marshal/runtime";
import { computeRuntimeExtensionIntegrity } from "@marshal/runtime/extensions";

import { DEFAULT_PERMISSIONS } from "../../common/marshal-default-settings";
import type {
  RuntimeAcceptanceAbort,
  RuntimeAcceptanceAPI,
  RuntimeAcceptanceAuthorityAuditEntry,
  RuntimeAcceptanceBridgeInfo,
  RuntimeAcceptanceFixture,
  RuntimeAcceptanceFixtureMutation,
  RuntimeAcceptanceFixtureProfile,
  RuntimeAcceptanceFixtureRequest,
  RuntimeAcceptanceFixtureResult,
  RuntimeAcceptanceFixtureSpec,
  RuntimeAcceptanceInvocationCounts,
  RuntimeAcceptanceLaunchProfile,
  RuntimeAcceptanceLifecycleEvent,
  RuntimeAcceptancePaths,
  RuntimeAcceptancePermissionDecision,
  RuntimeAcceptancePackageRootVariant,
  RuntimeAcceptanceRegistrationInventory,
  RuntimeAcceptanceResult,
  RuntimeAcceptanceScope,
  RuntimeAcceptanceSelfToolDescriptor,
  RuntimeAcceptanceTypeScriptProfile,
} from "../../common/runtime-acceptance";
import type { RuntimeUiJsonValue, RuntimeUiResult } from "../../common/runtime-ui";
import type { AgentMessageOutbox } from "../agent-message-outbox";
import type { IMemoryStore } from "../backend/ports";
import type { RuntimeTool } from "../backend/runtime-contract";
import { FilesystemMemoryStore } from "../filesystem-memory-store";
import type { createIpcHandle } from "../ipc/ipc-handle";
import type { SessionManagerRuntimeAgentAdapter } from "../marshal-runtime/agent-orchestration";
import type { ProductionMarshalRuntimeApi } from "../marshal-runtime/api";
import type {
  MarshalRuntimeAuthorityDecisionEvent,
  MarshalRuntimeDiagnostics,
} from "../marshal-runtime/contracts";
import { MARSHAL_RUNTIME_DEFAULT_WORKSPACE } from "../marshal-runtime/contracts";
import type { MarshalRuntimeHost } from "../marshal-runtime/host";
import { RUNTIME_SELF_TOOL_NAMES } from "../marshal-runtime/runtime-self-tools";
import type { MarshalRuntimeUiController } from "../marshal-runtime/ui-controller";
import type { PermissionPolicy } from "../permission-policy";
import { SessionMetadataSchema } from "../schemas/session-schema";
import type { PersistedSession } from "../session-store";
import type { SessionManager } from "../sessions";
import type { SettingsManager } from "../settings-manager";

type IpcHandle = ReturnType<typeof createIpcHandle>;

interface RuntimeAcceptanceInstances {
  readonly host: MarshalRuntimeHost;
  readonly api: ProductionMarshalRuntimeApi;
  readonly sessionManager: SessionManager;
  readonly memoryManager: IMemoryStore;
  readonly agents: SessionManagerRuntimeAgentAdapter;
  readonly agentMessageOutbox: AgentMessageOutbox;
  readonly permissionPolicy: PermissionPolicy;
  readonly settingsManager: SettingsManager;
  readonly authority: object;
  readonly uiController: MarshalRuntimeUiController;
  readonly resolveSelfTools: (sessionId: string) => readonly RuntimeTool[];
  readonly backendIdentity: {
    readonly runtimeId: string;
    readonly origin: "copilot" | "gateway";
  };
}

interface RuntimeAcceptanceEnvironment {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly userDataRoot: string;
  readonly appDataRoot: string;
  readonly env: NodeJS.ProcessEnv;
}

function isFixtureProfile(value: unknown): value is RuntimeAcceptanceFixtureProfile {
  return (
    value === "echo" ||
    value === "invocation-delay" ||
    value === "activation-delay" ||
    value === "activation-failure" ||
    value === "disposal-failure" ||
    value === "multi-contribution" ||
    value === "duplicate-capability" ||
    value === "duplicate-resource" ||
    value === "unsupported-import" ||
    value === "strict-manifest" ||
    value === "unknown-permission" ||
    value === "ui-application" ||
    value === "file-count-limit" ||
    value === "file-size-limit" ||
    value === "tree-size-limit" ||
    value === "collision"
  );
}

interface MaterializedFixture extends RuntimeAcceptanceFixture {
  readonly profile: RuntimeAcceptanceFixtureProfile;
  readonly location: "trusted" | "outside-root";
}

interface AcceptanceAuditRecord {
  readonly sequence: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly operation: string;
  readonly durationMs: number;
  readonly outcome: "success" | "error";
  readonly scope?: RuntimeAcceptanceScope;
  readonly idempotencyKey?: string;
  readonly resultCode?: string;
  readonly resultMessage?: string;
  readonly receiptStatuses?: readonly string[];
  readonly cancellationState?: string;
}

const CODE_READ_CAPABILITIES = [
  "code.query",
  "code.context",
  "code.status",
  "code.index.status",
] as const;

const FIXTURE_EVENT_GLOBAL = "__marshalRuntimeAcceptanceFixtureEvents";
const FIXTURE_EVENT_SINK = "__marshalRuntimeAcceptanceFixtureEventSink";

export class RuntimeAcceptanceHarness implements MarshalRuntimeDiagnostics {
  readonly paths: RuntimeAcceptancePaths;
  readonly launchProfile: RuntimeAcceptanceLaunchProfile;
  readonly nodeExecutable: string;

  private readonly lifecycleEvents: RuntimeAcceptanceLifecycleEvent[] = [];
  private readonly authorityAudit: RuntimeAcceptanceAuthorityAuditEntry[] = [];
  private readonly fixtures = new Map<string, MaterializedFixture>();
  private readonly allowedSessionIds = new Set<string>();
  private readonly objectIds = new WeakMap<object, string>();
  private readonly runtimeObjects = new Map<"kernel" | "extension-manager", object[]>();
  private readonly runtimeSelfToolsBySession = new Map<string, readonly RuntimeTool[]>();
  private readonly bridgeOperations = new Map<string, number>();
  private readonly ordinaryToolListings = new Map<string, { objectId: string; count: number }>();
  private readonly ordinaryToolInvocations = new Map<string, { objectId: string; count: number }>();
  private readonly uiNotifications: Array<{
    sessionId: string;
    titleSha256: string;
    titleLength: number;
    bodySha256: string;
    bodyLength: number;
  }> = [];
  private readonly fixtureEventAbortControllers = new Map<string, Set<AbortController>>();
  private readonly generatedTypeScriptSources: Array<{
    profile: RuntimeAcceptanceTypeScriptProfile;
    capability?: string;
    idempotencyKey: string;
    sourceSha256: string;
    sourceLength: number;
  }> = [];
  private readonly expectedToken: Buffer;
  private startupError: { readonly code: string; readonly message: string } | null = null;
  private instances: RuntimeAcceptanceInstances | null = null;
  private uiChatPersistenceGate: {
    readonly reached: Promise<void>;
    readonly release: Promise<void>;
    readonly signalReached: () => void;
    readonly signalRelease: () => void;
  } | null = null;
  private auditSequence = 0;
  private memoryStoredNotifications = 0;

  private constructor(environment: RuntimeAcceptanceEnvironment, token: string) {
    this.paths = resolveAcceptancePaths(environment);
    this.launchProfile = resolveLaunchProfile(environment.env.MARSHAL_RUNTIME_ACCEPTANCE_PROFILE);
    this.nodeExecutable = requireAbsolutePath(
      environment.env.MARSHAL_RUNTIME_ACCEPTANCE_NODE_EXECUTABLE ?? process.execPath,
      "Node executable",
    );
    this.expectedToken = Buffer.from(token, "utf8");
    fs.mkdirSync(this.paths.evidenceRoot, { recursive: true });
    this.restoreAuditState();
    Reflect.set(globalThis, FIXTURE_EVENT_SINK, (fixture: string, event: string) => {
      appendJsonLine(path.join(this.paths.evidenceRoot, "fixture-events.jsonl"), {
        timestamp: new Date().toISOString(),
        fixture,
        event,
      });
      const key = `${fixture}:${event}`;
      for (const controller of this.fixtureEventAbortControllers.get(key) ?? []) {
        controller.abort();
      }
      this.fixtureEventAbortControllers.delete(key);
    });
    this.onEvent({
      type: "acceptance.harness.created",
      details: { pid: process.pid, ppid: process.ppid },
    });
  }

  static create(environment: RuntimeAcceptanceEnvironment): RuntimeAcceptanceHarness | null {
    if (environment.env.MARSHAL_E2E !== "1" || environment.env.MARSHAL_RUNTIME_ACCEPTANCE !== "1") {
      return null;
    }
    if (environment.isPackaged) {
      throw new Error("Marshal Runtime acceptance mode is forbidden in packaged applications.");
    }
    const token = environment.env.MARSHAL_RUNTIME_ACCEPTANCE_TOKEN?.trim();
    if (!token) return null;
    return new RuntimeAcceptanceHarness(environment, token);
  }

  onEvent(event: {
    readonly type: string;
    readonly details?: Readonly<Record<string, unknown>>;
  }): void {
    const lifecycleEvent: RuntimeAcceptanceLifecycleEvent = {
      timestamp: new Date().toISOString(),
      type: event.type,
      ...(event.details ? { details: event.details } : {}),
    };
    this.lifecycleEvents.push(lifecycleEvent);
    appendJsonLine(path.join(this.paths.evidenceRoot, "lifecycle.jsonl"), lifecycleEvent);
  }

  onAuthorityDecision(event: MarshalRuntimeAuthorityDecisionEvent): void {
    const decisionCode =
      "code" in event.decision && typeof event.decision.code === "string"
        ? event.decision.code
        : undefined;
    const entry: RuntimeAcceptanceAuthorityAuditEntry = {
      timestamp: new Date().toISOString(),
      sessionId: event.scope.sessionId,
      workspaceName: event.scope.workspaceName,
      capability: event.capability,
      permissions: [...event.permissions],
      decision: event.decision.decision,
      ...(event.decision.reason ? { reason: event.decision.reason } : {}),
      ...(decisionCode ? { code: decisionCode } : {}),
    };
    this.authorityAudit.push(entry);
    appendJsonLine(path.join(this.paths.evidenceRoot, "authority-audit.jsonl"), entry);
  }

  onRuntimeObject(kind: "kernel" | "extension-manager", instance: object): void {
    const instances = this.runtimeObjects.get(kind) ?? [];
    if (!instances.includes(instance)) instances.push(instance);
    this.runtimeObjects.set(kind, instances);
    this.onEvent({
      type: `${kind}.constructed`,
      details: {
        objectId: this.objectId(instance, kind),
        count: instances.length,
      },
    });
  }

  captureStartupError(error: unknown): void {
    const details = acceptanceErrorDetails(error);
    this.startupError = {
      code: details.code,
      message: details.message,
    };
  }

  captureDisposalError(error: unknown): void {
    this.onEvent({
      type: "host.dispose.failed",
      details: { error: acceptanceErrorTree(error) },
    });
  }

  runtimePackageLocation(location: {
    readonly isPackaged: boolean;
    readonly appPath: string;
    readonly resourcesPath: string;
  }): {
    readonly isPackaged: boolean;
    readonly appPath: string;
    readonly resourcesPath: string;
  } {
    if (this.launchProfile !== "runtime-startup-failure") return location;
    const appPath = path.join(this.paths.runRoot, "runtime-startup-failure-app");
    fs.mkdirSync(appPath, { recursive: true });
    return { isPackaged: false, appPath, resourcesPath: location.resourcesPath };
  }

  onOrdinaryToolInvoked(tool: RuntimeTool): void {
    const objectId = this.objectId(tool, `ordinary-tool:${tool.name}`);
    const existing = this.ordinaryToolInvocations.get(tool.name);
    this.ordinaryToolInvocations.set(tool.name, {
      objectId,
      count: (existing?.count ?? 0) + 1,
    });
  }

  onOrdinaryToolsListed(tools: readonly RuntimeTool[]): void {
    for (const tool of tools) {
      const objectId = this.objectId(tool, `ordinary-tool:${tool.name}`);
      const existing = this.ordinaryToolListings.get(tool.name);
      this.ordinaryToolListings.set(tool.name, {
        objectId,
        count: (existing?.count ?? 0) + 1,
      });
    }
  }

  onUiNotification(delivery: {
    readonly owner: { readonly sessionId: string };
    readonly title: string;
    readonly message: string;
  }): void {
    this.uiNotifications.push({
      sessionId: delivery.owner.sessionId,
      titleSha256: createHash("sha256").update(delivery.title).digest("hex"),
      titleLength: delivery.title.length,
      bodySha256: createHash("sha256").update(delivery.message).digest("hex"),
      bodyLength: delivery.message.length,
    });
  }

  async beforeUiChatMessagePersistence(delivery: {
    readonly owner: { readonly sessionId: string };
    readonly deliveryId: string;
  }): Promise<void> {
    const gate = this.uiChatPersistenceGate;
    if (!gate) return;
    this.onEvent({
      type: "acceptance.ui-chat-persistence.reached",
      details: {
        sessionId: delivery.owner.sessionId,
        deliveryId: delivery.deliveryId,
      },
    });
    gate.signalReached();
    await gate.release;
    this.onEvent({
      type: "acceptance.ui-chat-persistence.released",
      details: {
        sessionId: delivery.owner.sessionId,
        deliveryId: delivery.deliveryId,
      },
    });
    if (this.uiChatPersistenceGate === gate) this.uiChatPersistenceGate = null;
  }

  onMemoryStored(): void {
    this.memoryStoredNotifications++;
  }

  runtimeProviderSources(): readonly RuntimeHostProviderSource[] {
    if (this.launchProfile !== "disposal-aggregation") return [];
    const descriptor: CapabilityDescriptor = Object.freeze({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      name: "acceptance.disposal.probe",
      version: "1.0.0",
      title: "Acceptance disposal probe",
      description: "Finite acceptance provider used to exercise runtime disposal aggregation.",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      },
    });
    const provider: CapabilityProvider = Object.freeze({
      id: "acceptance.disposal.provider",
      version: "1.0.0",
      list: () => [descriptor],
      get: (name: string) => (name === descriptor.name ? descriptor : undefined),
      invoke: async () => ({ output: { ok: true } }),
    });
    return [
      () => ({
        providers: [provider],
        dispose: () => {
          this.onEvent({ type: "acceptance.provider.dispose.attempted" });
          throw Object.assign(new Error("Acceptance provider disposal failure."), {
            code: "ACCEPTANCE_PROVIDER_DISPOSAL_FAILED",
          });
        },
      }),
    ];
  }

  register(ipcHandle: IpcHandle, instances: RuntimeAcceptanceInstances): void {
    if (this.instances) throw new Error("Marshal Runtime acceptance bridge is already registered.");
    this.instances = instances;

    ipcHandle("runtime-acceptance:getBridgeInfo", (_event, token) =>
      this.run(token, "getBridgeInfo", [], () => this.getBridgeInfo(instances)),
    );
    ipcHandle("runtime-acceptance:getStatus", (_event, token) =>
      this.run(token, "getStatus", [], () => instances.api.getStatus()),
    );
    ipcHandle("runtime-acceptance:getStartupError", (_event, token) =>
      this.run(token, "getStartupError", [], () => this.startupError),
    );
    ipcHandle("runtime-acceptance:getPaths", (_event, token) =>
      this.run(token, "getPaths", [], () => this.paths),
    );
    ipcHandle("runtime-acceptance:getLifecycleEvents", (_event, token) =>
      this.run(token, "getLifecycleEvents", [], () => [...this.lifecycleEvents]),
    );
    ipcHandle("runtime-acceptance:listRegisteredSelfTools", (_event, token) =>
      this.run(token, "listRegisteredSelfTools", [], () => this.selfToolDescriptors(instances)),
    );
    ipcHandle("runtime-acceptance:listOrdinarySelfTools", (_event, token, sessionId) =>
      this.run(token, "listOrdinarySelfTools", [sessionId], async () => {
        await this.readSession(instances, sessionId);
        return instances.sessionManager
          .listSelfToolsForSession(sessionId)
          .filter((tool) => !RUNTIME_SELF_TOOL_NAMES.some((name) => name === tool.name))
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: record(tool.parameters),
            supportsAbortSignal: tool.supportsAbortSignal === true,
            objectId: this.objectId(tool, `ordinary-tool:${tool.name}`),
          }));
      }),
    );
    ipcHandle("runtime-acceptance:invokeRegisteredSelfTool", (_event, token, request) =>
      this.run(token, "invokeRegisteredSelfTool", [request], async () => {
        const tool = this.runtimeSelfTools(instances, request.sessionId).find(
          (candidate) => candidate.name === request.name,
        );
        if (!tool) throw new Error(`Unknown registered runtime self-tool: ${request.name}`);
        const result = await tool.handler(
          normalizeSelfToolArguments(this, request.name, request.arguments),
          {
            sessionId: request.sessionId,
            toolCallId: request.toolCallId,
            toolName: request.name,
            arguments: request.arguments,
            signal: abortSignal(request.abort),
          },
        );
        this.learnSessionIds(result);
        return result;
      }),
    );
    ipcHandle("runtime-acceptance:search", (_event, token, request) =>
      this.run(token, "search", [request], () =>
        instances.api.search({ ...request, signal: abortSignal(request.abort) }),
      ),
    );
    ipcHandle("runtime-acceptance:invoke", (_event, token, request) =>
      this.run(token, "invoke", [request], () =>
        instances.api.invoke({ ...request, signal: abortSignal(request.abort) }),
      ),
    );
    ipcHandle("runtime-acceptance:executeTypeScript", (_event, token, request) =>
      this.run(token, "executeTypeScript", [request], () => {
        const source = typeScriptSource(request.profile, request.capability);
        this.generatedTypeScriptSources.push({
          profile: request.profile,
          ...(request.capability ? { capability: request.capability } : {}),
          idempotencyKey: request.idempotencyKey,
          sourceSha256: createHash("sha256").update(source).digest("hex"),
          sourceLength: source.length,
        });
        return instances.api.executeTypeScript({
          ...request,
          source,
          signal: this.typeScriptAbortSignal(request.abort, request.capability),
        });
      }),
    );
    ipcHandle("runtime-acceptance:listResources", (_event, token, request) =>
      this.run(token, "listResources", [request], () =>
        instances.host.listResources(runtimeCallContext(request, request.abort)),
      ),
    );
    ipcHandle("runtime-acceptance:readResource", (_event, token, request) =>
      this.run(token, "readResource", [request], async () => {
        const resource = await instances.host.readResource(
          request.uri,
          runtimeCallContext(request, request.abort),
        );
        return {
          uri: resource.uri,
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          ...(resource.text ? { text: resource.text } : {}),
          ...(resource.blob ? { blob: resource.blob } : {}),
        };
      }),
    );
    ipcHandle("runtime-acceptance:listExtensions", (_event, token, request) =>
      this.run(token, "listExtensions", [request], () =>
        instances.api.listExtensions({ ...request, signal: abortSignal(request.abort) }),
      ),
    );
    ipcHandle("runtime-acceptance:installExtension", (_event, token, request) =>
      this.run(token, "installExtension", [request], () => {
        const fixture = this.requireFixture(request.fixtureId);
        return instances.api.installExtension({
          ...request,
          packageRoot: extensionPackageRoot(
            request.packageRootVariant ?? "fixture",
            fixture.packageRoot,
          ),
          integrity: fixture.integrity,
          signal: this.abortSignal(request.abort, fixture.fixtureId),
        });
      }),
    );
    ipcHandle("runtime-acceptance:updateExtension", (_event, token, request) =>
      this.run(token, "updateExtension", [request], () => {
        const fixture = this.requireFixture(request.fixtureId);
        return instances.api.updateExtension({
          ...request,
          packageRoot: fixture.packageRoot,
          integrity: fixture.integrity,
          signal: this.abortSignal(request.abort, fixture.fixtureId),
        });
      }),
    );
    ipcHandle("runtime-acceptance:enableExtension", (_event, token, request) =>
      this.run(token, "enableExtension", [request], () =>
        instances.api.enableExtension({ ...request, signal: abortSignal(request.abort) }),
      ),
    );
    ipcHandle("runtime-acceptance:disableExtension", (_event, token, request) =>
      this.run(token, "disableExtension", [request], () =>
        instances.api.disableExtension({ ...request, signal: abortSignal(request.abort) }),
      ),
    );
    ipcHandle("runtime-acceptance:removeExtension", (_event, token, request) =>
      this.run(token, "removeExtension", [request], () =>
        instances.api.removeExtension({ ...request, signal: abortSignal(request.abort) }),
      ),
    );
    ipcHandle("runtime-acceptance:materializeExtensionFixture", (_event, token, spec) =>
      this.run(token, "materializeExtensionFixture", [spec], () =>
        this.materializeExtensionFixture(spec),
      ),
    );
    ipcHandle("runtime-acceptance:mutateExtensionFixture", (_event, token, spec) =>
      this.run(token, "mutateExtensionFixture", [spec], () =>
        this.mutateExtensionFixture(spec.fixtureId, spec.mutation),
      ),
    );
    ipcHandle("runtime-acceptance:readSession", (_event, token, sessionId) =>
      this.run(token, "readSession", [sessionId], () => this.readSession(instances, sessionId)),
    );
    ipcHandle("runtime-acceptance:readMemories", (_event, token) =>
      this.run(token, "readMemories", [], () => instances.memoryManager.list()),
    );
    ipcHandle("runtime-acceptance:setAcceptancePermission", (_event, token, permission, decision) =>
      this.run(token, "setAcceptancePermission", [permission, decision], () =>
        this.setAcceptancePermission(instances, permission, decision),
      ),
    );
    ipcHandle("runtime-acceptance:getAuthorityAudit", (_event, token) =>
      this.run(token, "getAuthorityAudit", [], () => [...this.authorityAudit]),
    );
    ipcHandle("runtime-acceptance:getRegistrationInventory", (_event, token) =>
      this.run(token, "getRegistrationInventory", [], () => this.registrationInventory(instances)),
    );
    ipcHandle("runtime-acceptance:getInvocationCounts", (_event, token) =>
      this.run(token, "getInvocationCounts", [], () => this.invocationCounts()),
    );
    ipcHandle("runtime-acceptance:probeRuntimeUiOperation", (_event, token, request) =>
      this.run<RuntimeUiResult<unknown>>(token, "probeRuntimeUiOperation", [request], () =>
        this.probeRuntimeUiOperation(instances.uiController, request),
      ),
    );
    ipcHandle("runtime-acceptance:fixture", (_event, token, request) =>
      this.run(token, "fixture", [request], () => this.runFixture(instances, request)),
    );
    const bridgeInfo = this.getBridgeInfo(instances);
    this.onEvent({
      type: "acceptance.bridge.registered",
      details: {
        instanceIds: bridgeInfo.instanceIds,
      },
    });
  }

  private async run<T>(
    token: string,
    operation: keyof RuntimeAcceptanceAPI,
    args: readonly unknown[],
    action: () => T | Promise<T>,
  ): Promise<RuntimeAcceptanceResult<T>> {
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const request = record(args[0]);
    this.bridgeOperations.set(operation, (this.bridgeOperations.get(operation) ?? 0) + 1);
    this.auditSequence += 1;
    const sequence = this.auditSequence;
    try {
      this.authenticateToken(token);
      const value = await action();
      this.learnSessionIds(value);
      const completedAt = new Date().toISOString();
      const result = { success: true as const, value };
      this.writeAudit({
        sequence,
        startedAt: startedAtIso,
        completedAt,
        operation,
        durationMs: Date.now() - startedAt,
        outcome: "success",
        ...(scopeFromRecord(request) ? { scope: scopeFromRecord(request) } : {}),
        ...(typeof request.idempotencyKey === "string"
          ? { idempotencyKey: request.idempotencyKey }
          : {}),
        ...(acceptanceResultCode(value) ? { resultCode: acceptanceResultCode(value) } : {}),
        ...auditResultMetadata(value),
      });
      this.writeTranscript({
        sequence,
        startedAt: startedAtIso,
        completedAt,
        operation,
        args,
        result,
      });
      return result;
    } catch (error) {
      const completedAt = new Date().toISOString();
      const result = {
        success: false as const,
        error: {
          code: errorCode(error),
          message:
            error instanceof Error && error.message.trim()
              ? error.message.slice(0, 1_024)
              : "Marshal Runtime acceptance operation failed.",
        },
      };
      this.writeAudit({
        sequence,
        startedAt: startedAtIso,
        completedAt,
        operation,
        durationMs: Date.now() - startedAt,
        outcome: "error",
        resultCode: errorCode(error),
        ...(scopeFromRecord(request) ? { scope: scopeFromRecord(request) } : {}),
      });
      this.writeTranscript({
        sequence,
        startedAt: startedAtIso,
        completedAt,
        operation,
        args,
        result,
      });
      return result;
    }
  }

  private getBridgeInfo(instances: RuntimeAcceptanceInstances): RuntimeAcceptanceBridgeInfo {
    return {
      compileTimeGate: true,
      runtimeGates: {
        unpackaged: true,
        marshalE2E: true,
        runtimeAcceptance: true,
        tokenAuthenticated: true,
      },
      mainProcessPid: process.pid,
      preloadIdentity: "runtime-acceptance-preload.cjs",
      nodeExecutable: this.nodeExecutable,
      backendIdentity: instances.backendIdentity,
      instanceIds: {
        host: this.objectId(instances.host, "host"),
        api: this.objectId(instances.api, "api"),
        kernel: this.runtimeObjectId("kernel"),
        extensionManager: this.runtimeObjectId("extension-manager"),
        uiController: this.objectId(instances.uiController, "ui-controller"),
        sessionManager: this.objectId(instances.sessionManager, "session-manager"),
        memoryManager: this.objectId(instances.memoryManager, "memory-manager"),
        authority: this.objectId(instances.authority, "authority"),
      },
      instanceCounts: {
        host: 1,
        api: 1,
        kernel: this.runtimeObjects.get("kernel")?.length ?? 0,
        extensionManager: this.runtimeObjects.get("extension-manager")?.length ?? 0,
        uiController: 1,
        sessionManager: 1,
        memoryManager: 1,
      },
    };
  }

  private authenticateToken(token: string): void {
    const receivedToken = typeof token === "string" ? Buffer.from(token, "utf8") : Buffer.alloc(0);
    if (
      receivedToken.length === this.expectedToken.length &&
      timingSafeEqual(receivedToken, this.expectedToken)
    ) {
      return;
    }
    throw Object.assign(new Error("Marshal Runtime acceptance token is invalid."), {
      code: "acceptance-token-invalid",
    });
  }

  private async runFixture(
    instances: RuntimeAcceptanceInstances,
    request: RuntimeAcceptanceFixtureRequest,
  ): Promise<RuntimeAcceptanceFixtureResult> {
    switch (request.action) {
      case "create-agent": {
        const session = await instances.sessionManager.createSession(request.model, undefined, {
          name: request.name,
          source: request.source,
          parentSessionId: request.parentSessionId,
          runtimeAgentRole: request.runtimeAgentRole,
          workspaceName: request.workspaceName,
          reasoningEffort: request.reasoningEffort,
          skills: [],
          mcp: [],
          setActive: false,
        });
        this.allowedSessionIds.add(session.id);
        return { action: request.action, session };
      }
      case "append-hidden-message":
        return {
          action: request.action,
          appended: instances.sessionManager.appendMessage(request.sessionId, {
            id: `runtime-acceptance-hidden-${randomUUID()}`,
            role: "user",
            content: request.content,
            timestamp: new Date().toISOString(),
            goalContinuation: true,
            internalControl: {
              kind: "goal-continuation",
              exchangeId: `runtime-acceptance:${randomUUID()}`,
              side: "request",
            },
          }),
        };
      case "set-session-workspace": {
        const session = instances.sessionManager.getSession(request.sessionId);
        if (!session) throw new Error(`Acceptance session is unavailable: ${request.sessionId}`);
        const before = session.workspaceName;
        const updatedAt = new Date().toISOString();
        const updatedSession = {
          ...session,
          workspaceName: request.workspaceName,
          updatedAt,
        };
        const store = instances.sessionManager.getSessionStore();
        store.saveSessionData(updatedSession);
        await store.withIndexLock((index) => {
          const metadata = index.sessions.find((candidate) => candidate.id === request.sessionId);
          if (!metadata)
            throw new Error(`Acceptance session index row is missing: ${request.sessionId}`);
          metadata.workspaceName = request.workspaceName;
          metadata.updatedAt = updatedAt;
        });
        return { action: request.action, before, after: request.workspaceName };
      }
      case "seed-memory":
        return {
          action: request.action,
          entry: await instances.memoryManager.add(
            request.fact,
            request.category ?? "fact",
            request.source,
          ),
        };
      case "seed-raw-memory": {
        const session = await this.readSession(instances, request.sessionId);
        const workspaceName =
          session && typeof session.workspaceName === "string"
            ? session.workspaceName.trim()
            : undefined;
        if (!session || workspaceName !== request.workspaceName.trim()) {
          throw new Error("Raw acceptance memory scope does not match a live session.");
        }
        const source = `marshal-runtime:v1:workspace=${encodeURIComponent(
          request.workspaceName.trim(),
        )};session=${encodeURIComponent(request.sessionId)}`;
        return {
          action: request.action,
          entry: requireFilesystemAcceptanceMemory(
            instances.memoryManager,
          ).seedRuntimeAcceptanceRawMemory(request.fact, "fact", source),
        };
      }
      case "recall-memory-backing":
        return {
          action: request.action,
          entries: await instances.memoryManager.recall(request.query, request.limit),
        };
      case "configure-memory-backing": {
        const memory = requireFilesystemAcceptanceMemory(instances.memoryManager);
        return {
          action: request.action,
          diagnostics: memory.configureRuntimeAcceptanceBoundary(request.control),
        };
      }
      case "diagnostics": {
        switch (request.target) {
          case "agent":
            return {
              action: request.action,
              target: request.target,
              diagnostics: instances.agents.getRuntimeAcceptanceDiagnostics(),
            };
          case "memory":
            return {
              action: request.action,
              target: request.target,
              diagnostics: requireFilesystemAcceptanceMemory(
                instances.memoryManager,
              ).getRuntimeAcceptanceDiagnostics(),
            };
          case "memory-notifications":
            return {
              action: request.action,
              target: request.target,
              diagnostics: { stored: this.memoryStoredNotifications },
            };
        }
        throw new Error("Unsupported runtime acceptance diagnostic target.");
      }
      case "agent-outbox":
        if (request.state === "stopped") instances.agentMessageOutbox.stop();
        else await instances.agentMessageOutbox.start();
        return { action: request.action, state: request.state };
      case "validate-agent-role": {
        return {
          action: request.action,
          valid: SessionMetadataSchema.safeParse({
            id: "runtime-acceptance-role-probe",
            name: "Runtime acceptance role probe",
            runtimeAgentRole: request.role,
          }).success,
        };
      }
      case "load-persisted-agent-role-fixtures": {
        const scope = this.firstWorkspaceScope(instances);
        const store = instances.sessionManager.getSessionStore();
        const source = store.loadSessionData(scope.sessionId);
        if (!source) throw new Error("Acceptance owner session could not seed role fixtures.");
        const now = new Date().toISOString();
        const invalidId = `runtime-acceptance-invalid-role-${randomUUID()}`;
        const absentId = `runtime-acceptance-absent-role-${randomUUID()}`;
        const invalid: PersistedSession = {
          ...source,
          id: invalidId,
          name: "Runtime acceptance invalid role",
          createdAt: now,
          updatedAt: now,
          messages: [],
        };
        Reflect.set(invalid, "runtimeAgentRole", "generic");
        const absent: PersistedSession = {
          ...source,
          id: absentId,
          name: "Runtime acceptance absent role",
          createdAt: now,
          updatedAt: now,
          messages: [],
        };
        delete absent.runtimeAgentRole;
        try {
          store.saveSessionData(invalid);
          store.saveSessionData(absent);
          const loadedInvalid = store.loadSessionData(invalidId);
          const loadedAbsent = store.loadSessionData(absentId);
          return {
            action: request.action,
            invalidGeneric: { id: invalidId, loaded: loadedInvalid !== null },
            absentRole: {
              id: absentId,
              loaded: loadedAbsent !== null,
              ...(loadedAbsent?.runtimeAgentRole
                ? { runtimeAgentRole: loadedAbsent.runtimeAgentRole }
                : {}),
            },
          };
        } finally {
          store.deleteSessionData(invalidId);
          store.deleteSessionData(absentId);
        }
      }
      case "ui-chat-persistence-gate": {
        if (request.command === "arm") {
          if (this.uiChatPersistenceGate) {
            throw new Error("Runtime UI chat persistence gate is already armed.");
          }
          let signalReached!: () => void;
          let signalRelease!: () => void;
          const reached = new Promise<void>((resolve) => {
            signalReached = resolve;
          });
          const release = new Promise<void>((resolve) => {
            signalRelease = resolve;
          });
          this.uiChatPersistenceGate = { reached, release, signalReached, signalRelease };
          return { action: request.action, state: "armed" };
        }
        const gate = this.uiChatPersistenceGate;
        if (!gate) throw new Error("Runtime UI chat persistence gate is not armed.");
        if (request.command === "wait") {
          await gate.reached;
          return { action: request.action, state: "reached" };
        }
        gate.signalRelease();
        return { action: request.action, state: "released" };
      }
    }
    throw new Error("Unsupported runtime acceptance fixture action.");
  }

  private selfToolDescriptors(
    instances: RuntimeAcceptanceInstances,
  ): readonly RuntimeAcceptanceSelfToolDescriptor[] {
    return this.runtimeSelfTools(instances).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: record(tool.parameters),
      supportsAbortSignal: tool.supportsAbortSignal === true,
      objectId: this.objectId(tool, `self-tool:${tool.name}`),
    }));
  }

  private runtimeSelfTools(
    instances: RuntimeAcceptanceInstances,
    sessionId = this.firstWorkspaceScope(instances).sessionId,
  ): readonly RuntimeTool[] {
    const cached = this.runtimeSelfToolsBySession.get(sessionId);
    if (cached) return cached;
    const available = instances.resolveSelfTools(sessionId);
    const tools = RUNTIME_SELF_TOOL_NAMES.map((name) =>
      available.find((candidate) => candidate.name === name),
    );
    const resolved = tools.filter((tool): tool is RuntimeTool => tool !== undefined);
    if (resolved.length !== RUNTIME_SELF_TOOL_NAMES.length) {
      throw new Error("Marshal Runtime acceptance could not resolve every production self-tool.");
    }
    this.runtimeSelfToolsBySession.set(sessionId, resolved);
    return resolved;
  }

  private runtimeObjectId(kind: "kernel" | "extension-manager"): string | null {
    const instances = this.runtimeObjects.get(kind) ?? [];
    return instances.length === 1 ? this.objectId(instances[0], kind) : null;
  }

  private async materializeExtensionFixture(
    spec: RuntimeAcceptanceFixtureSpec,
  ): Promise<RuntimeAcceptanceFixture> {
    if (!isFixtureProfile(spec.profile)) {
      throw new Error("Acceptance fixture profile is not allowlisted.");
    }
    const fixtureId = `fixture-${randomUUID()}`;
    const location = spec.location ?? "trusted";
    const packageRoot =
      location === "trusted"
        ? path.join(this.paths.trustedExtensionRoot, fixtureId)
        : path.join(this.paths.runRoot, "fixtures", "outside-extensions", fixtureId);
    const requestedIdentity = spec.identity?.trim();
    if (requestedIdentity && !/^[a-z0-9][a-z0-9._-]{0,213}$/i.test(requestedIdentity)) {
      throw new Error("Acceptance fixture identity is invalid.");
    }
    const identity = spec.identityFixtureId
      ? this.requireFixture(spec.identityFixtureId).identity
      : requestedIdentity || `acceptance.${fixtureId}`;
    const version = spec.version?.trim() || "1.0.0";
    const collisionTarget = spec.collisionFixtureId
      ? this.requireFixture(spec.collisionFixtureId)
      : undefined;
    if (spec.profile === "collision" && (!collisionTarget || !spec.collisionKind)) {
      throw new Error("Collision fixtures require a target fixture and collision kind.");
    }
    const layout = fixtureLayout(identity, spec, collisionTarget);
    fs.mkdirSync(packageRoot, { recursive: true });
    writeFixtureFiles({
      packageRoot,
      identity,
      version,
      spec,
      eventKey: fixtureEventKey(fixtureId),
      layout,
    });
    const fixture: MaterializedFixture = {
      fixtureId,
      packageRoot,
      integrity: isOversizedFixture(spec.profile)
        ? {
            algorithm: "sha256",
            domain: "marshal-runtime-extension-package-v1",
            value: "0".repeat(64),
          }
        : computeRuntimeExtensionIntegrity(packageRoot),
      identity,
      version,
      capabilityNames: layout.capabilityNames,
      providerIds: layout.providerIds,
      catalogProviderIds: layout.catalogProviderIds,
      catalogIds: layout.catalogIds,
      resourceUris: layout.resourceUris,
      uiApplicationIds: layout.uiApplicationIds,
      profile: spec.profile,
      location,
    };
    this.fixtures.set(fixtureId, fixture);
    return fixture;
  }

  resolveFixtureForSelfTool(fixtureId: string): MaterializedFixture {
    return this.requireFixture(fixtureId);
  }

  private async mutateExtensionFixture(
    fixtureId: string,
    mutation: RuntimeAcceptanceFixtureMutation,
  ): Promise<RuntimeAcceptanceFixture> {
    const fixture = this.requireFixture(fixtureId);
    const manifestPath = path.join(fixture.packageRoot, "runtime-extension.json");
    const packagePath = path.join(fixture.packageRoot, "package.json");
    const entrypointPath = path.join(fixture.packageRoot, "index.cjs");
    const manifest = readJsonRecord(manifestPath);
    const packageMetadata = readJsonRecord(packagePath);
    let refreshIntegrity = true;
    let updatedFixture = fixture;
    switch (mutation) {
      case "post-hash-mutation":
        fs.appendFileSync(entrypointPath, "\n// digest mismatch\n");
        refreshIntegrity = false;
        break;
      case "wrong-digest":
        updatedFixture = {
          ...fixture,
          integrity: { ...fixture.integrity, value: "0".repeat(64) },
        };
        refreshIntegrity = false;
        break;
      case "invalid-integrity-descriptor":
        updatedFixture = {
          ...fixture,
          integrity: { ...fixture.integrity, value: "invalid" },
        };
        refreshIntegrity = false;
        break;
      case "add-unexpected-file":
        fs.writeFileSync(path.join(fixture.packageRoot, "unexpected.txt"), "unexpected");
        break;
      case "delete-entrypoint":
        fs.rmSync(entrypointPath, { force: true });
        break;
      case "source-unavailable":
        fs.rmSync(fixture.packageRoot, { recursive: true, force: true });
        refreshIntegrity = false;
        break;
      case "manifest-identity":
        writeJson(manifestPath, { ...manifest, identity: `${fixture.identity}.changed` });
        break;
      case "manifest-version":
        writeJson(manifestPath, { ...manifest, version: "99.0.0" });
        break;
      case "manifest-extra-key":
        writeJson(manifestPath, { ...manifest, unexpected: true });
        break;
      case "manifest-missing-key": {
        const { identity: _identity, ...withoutIdentity } = manifest;
        writeJson(manifestPath, withoutIdentity);
        break;
      }
      case "manifest-missing-entrypoint": {
        const { entrypoint: _entrypoint, ...withoutEntrypoint } = manifest;
        writeJson(manifestPath, withoutEntrypoint);
        break;
      }
      case "manifest-unsupported-format":
        writeJson(manifestPath, { ...manifest, moduleFormat: "esm" });
        break;
      case "manifest-invalid-utf8":
        fs.writeFileSync(manifestPath, Buffer.from([0xc3, 0x28]));
        break;
      case "manifest-oversized":
        fs.writeFileSync(
          manifestPath,
          JSON.stringify({ ...manifest, padding: "x".repeat(2_000_000) }),
        );
        break;
      case "unsafe-entrypoint":
      case "tree-escape":
        writeJson(manifestPath, { ...manifest, entrypoint: "../outside.cjs" });
        writeJson(packagePath, { ...packageMetadata, main: "../outside.cjs" });
        break;
      case "reserved-entrypoint":
        writeJson(manifestPath, { ...manifest, entrypoint: "CON.cjs" });
        writeJson(packagePath, { ...packageMetadata, main: "CON.cjs" });
        break;
      case "non-cjs-entrypoint":
        fs.renameSync(entrypointPath, path.join(fixture.packageRoot, "index.js"));
        writeJson(manifestPath, { ...manifest, entrypoint: "index.js" });
        writeJson(packagePath, { ...packageMetadata, main: "index.js" });
        break;
      case "package-type-mismatch":
        writeJson(packagePath, { ...packageMetadata, type: "module" });
        break;
      case "package-main-mismatch":
        writeJson(packagePath, { ...packageMetadata, main: "other.cjs" });
        break;
      case "unsupported-import":
        fs.writeFileSync(entrypointPath, `require("acceptance-unsupported-import");`);
        break;
      case "module-load-throw":
        fs.writeFileSync(entrypointPath, `throw new Error("acceptance module load failure");`);
        break;
      case "missing-activate":
        fs.writeFileSync(entrypointPath, "module.exports={};");
        break;
      case "activation-failure":
        fs.writeFileSync(
          entrypointPath,
          `module.exports={activate(){throw new Error("acceptance activation failure")}};`,
        );
        break;
      case "duplicate-capability":
      case "duplicate-resource": {
        const profile =
          mutation === "duplicate-capability" ? "duplicate-capability" : "duplicate-resource";
        const spec = { profile } satisfies RuntimeAcceptanceFixtureSpec;
        fs.writeFileSync(
          entrypointPath,
          fixtureSource(
            fixture.identity,
            fixture.version,
            profile,
            fixtureEventKey(fixtureId),
            spec,
            fixtureLayout(fixture.identity, spec),
          ),
        );
        break;
      }
      case "case-colliding-paths":
        fs.writeFileSync(path.join(fixture.packageRoot, "Case.txt"), "first");
        fs.writeFileSync(path.join(fixture.packageRoot, "case.txt"), "second");
        refreshIntegrity = false;
        break;
      case "trailing-dot-path":
        fs.writeFileSync(
          extendedWindowsPath(path.join(fixture.packageRoot, "trailing.")),
          "unsafe",
        );
        refreshIntegrity = false;
        break;
      case "symlink-entrypoint": {
        const outside = path.join(this.paths.runRoot, `${fixtureId}-outside.cjs`);
        fs.writeFileSync(outside, "module.exports={activate(){return {}}};");
        fs.rmSync(entrypointPath, { force: true });
        fs.symlinkSync(outside, entrypointPath, "file");
        refreshIntegrity = false;
        break;
      }
      case "symlink-root": {
        const outside = path.join(this.paths.runRoot, `${fixtureId}-outside-root`);
        fs.mkdirSync(outside, { recursive: true });
        fs.cpSync(fixture.packageRoot, outside, { recursive: true });
        fs.rmSync(fixture.packageRoot, { recursive: true, force: true });
        fs.symlinkSync(outside, fixture.packageRoot, "junction");
        refreshIntegrity = false;
        break;
      }
    }
    if (refreshIntegrity) {
      updatedFixture = {
        ...updatedFixture,
        integrity: computeRuntimeExtensionIntegrity(fixture.packageRoot),
      };
    }
    this.fixtures.set(fixtureId, updatedFixture);
    return updatedFixture;
  }

  private abortSignal(
    abort: RuntimeAcceptanceAbort | undefined,
    fixtureId: string,
  ): AbortSignal | undefined {
    if (abort?.timing !== "fixture-event") return abortSignal(abort);
    if (abort.event === "invoke:start") {
      throw new Error("Extension fixture-event cancellation requires an activation event.");
    }
    const controller = new AbortController();
    const key = `${fixtureEventKey(fixtureId)}:${abort.event}`;
    const controllers = this.fixtureEventAbortControllers.get(key) ?? new Set<AbortController>();
    controllers.add(controller);
    this.fixtureEventAbortControllers.set(key, controllers);
    return controller.signal;
  }

  private typeScriptAbortSignal(
    abort: RuntimeAcceptanceAbort | undefined,
    capability: string | undefined,
  ): AbortSignal | undefined {
    if (abort?.timing !== "fixture-event") return abortSignal(abort);
    if (abort.event !== "invoke:start" || !capability) {
      throw new Error("TypeScript fixture-event cancellation requires invoke:start capability.");
    }
    const fixture = [...this.fixtures.values()].find((candidate) =>
      candidate.capabilityNames.includes(capability),
    );
    if (!fixture) throw new Error(`No acceptance fixture owns capability ${capability}.`);
    const controller = new AbortController();
    const key = `${fixtureEventKey(fixture.fixtureId)}:invoke:${capability}`;
    const controllers = this.fixtureEventAbortControllers.get(key) ?? new Set<AbortController>();
    controllers.add(controller);
    this.fixtureEventAbortControllers.set(key, controllers);
    return controller.signal;
  }

  private async readSession(
    instances: RuntimeAcceptanceInstances,
    sessionId: string,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    for (const knownSessionId of instances.sessionManager.listAllSessionIds()) {
      this.allowedSessionIds.add(knownSessionId);
    }
    const session = instances.sessionManager.getSession(sessionId);
    if (!this.allowedSessionIds.has(sessionId) && !session) {
      throw new Error(`Session is outside the acceptance allowlist: ${sessionId}`);
    }
    // Restart evidence reads persisted sessions before SessionManager reactivates them.
    if (session) this.allowedSessionIds.add(sessionId);
    return session ? { ...session } : null;
  }

  private setAcceptancePermission(
    instances: RuntimeAcceptanceInstances,
    permission: string,
    decision: RuntimeAcceptancePermissionDecision,
  ): { readonly permission: string; readonly decision: string } {
    const keys = permissionToolKeys(permission);
    const settings = instances.settingsManager.get();
    const permissions = settings.permissions ?? DEFAULT_PERMISSIONS;
    const tools = { ...permissions.tools };
    for (const key of keys) {
      if (decision === "prompt") delete tools[key];
      else tools[key] = decision === "allow";
    }
    const scope = this.firstWorkspaceScope(instances);
    if (decision === "deny") {
      instances.permissionPolicy.setDenyPrompt(scope.sessionId);
    } else {
      instances.permissionPolicy.clearDenyPrompt(scope.sessionId);
    }
    instances.settingsManager.save({
      ...settings,
      permissions: { ...permissions, tools },
    });
    return { permission, decision };
  }

  private async registrationInventory(
    instances: RuntimeAcceptanceInstances,
  ): Promise<RuntimeAcceptanceRegistrationInventory> {
    const scope = this.firstWorkspaceScope(instances);
    const [searchResult, extensionsResult, resources] = await Promise.all([
      instances.api.search({ ...scope, query: "", detail: "full", limit: 1_000 }),
      instances.api.listExtensions(scope),
      instances.host.listResources(runtimeCallContext(scope)),
    ]);
    if (!searchResult.ok) throw new Error(searchResult.error.message);
    if (!extensionsResult.ok) throw new Error(extensionsResult.error.message);
    return {
      scope,
      search: searchResult.value,
      extensions: extensionsResult.value,
      resources,
      selfTools: this.selfToolDescriptors(instances),
    };
  }

  private invocationCounts(): RuntimeAcceptanceInvocationCounts {
    const rawEvents = record(Reflect.get(globalThis, FIXTURE_EVENT_GLOBAL));
    const fixtureEvents = Object.fromEntries(
      Object.entries(rawEvents).filter(
        (entry): entry is [string, readonly string[]] =>
          Array.isArray(entry[1]) && entry[1].every((value) => typeof value === "string"),
      ),
    );
    return {
      bridgeOperations: Object.fromEntries(this.bridgeOperations),
      fixtureEvents,
      ordinaryToolListings: Object.fromEntries(this.ordinaryToolListings),
      ordinaryToolInvocations: Object.fromEntries(this.ordinaryToolInvocations),
      uiNotifications: [...this.uiNotifications],
      generatedTypeScriptSources: [...this.generatedTypeScriptSources],
    };
  }

  private probeRuntimeUiOperation(
    controller: MarshalRuntimeUiController,
    request: Parameters<RuntimeAcceptanceAPI["probeRuntimeUiOperation"]>[0],
  ) {
    const signal = abortSignal(request.abort);
    const owner = {
      sessionId: request.sessionId,
      workspaceName: request.workspaceName,
      extensionId: request.extensionId,
      applicationId: request.applicationId,
    };
    if (request.operation === "open") {
      return controller.open(
        {
          ...owner,
          surface: "inline-card",
          content: { kind: "text", text: "runtime-ui-acceptance-probe" },
          idempotencyKey: request.idempotencyKey,
        },
        signal,
      );
    }
    if (request.operation === "prototype-pollution") {
      const state: Record<string, RuntimeUiJsonValue> = { safe: "value" };
      Object.defineProperty(state, "__proto__", {
        value: { polluted: true },
        enumerable: true,
      });
      return controller.open(
        {
          ...owner,
          surface: "inline-card",
          content: {
            kind: "application",
            renderId: "acceptance-renderer",
            resource: { uri: "runtime://acceptance/application", mimeType: "text/html" },
            descriptor: {
              version: "1.0.0",
              presentationModes: ["inline"],
              actions: [],
              tools: [],
            },
            state,
          },
          idempotencyKey: request.idempotencyKey,
        },
        signal,
      );
    }
    if (request.operation === "update") {
      return controller.update(
        {
          ...owner,
          instanceId: request.instanceId ?? "runtime-ui-acceptance-missing",
          content: { kind: "text", text: "runtime-ui-acceptance-probe-updated" },
          idempotencyKey: request.idempotencyKey,
        },
        signal,
      );
    }
    if (request.operation === "focus") {
      return controller.focus(
        {
          ...owner,
          instanceId: request.instanceId ?? "runtime-ui-acceptance-missing",
          idempotencyKey: request.idempotencyKey,
        },
        signal,
      );
    }
    if (request.operation === "close") {
      return controller.close(
        {
          ...owner,
          instanceId: request.instanceId ?? "runtime-ui-acceptance-missing",
          idempotencyKey: request.idempotencyKey,
        },
        signal,
      );
    }
    if (request.operation === "list") {
      return controller.list(owner, signal);
    }
    if (request.operation === "snapshot") {
      return controller.snapshot(request, signal);
    }
    if (request.operation === "notification") {
      return controller.showNotification(
        {
          ...owner,
          title: "Runtime UI acceptance probe",
          message: "Runtime UI acceptance probe",
          idempotencyKey: request.idempotencyKey,
        },
        signal,
      );
    }
    if (request.operation === "chat-message") {
      return controller.postChatMessage(
        {
          ...owner,
          content: { kind: "text", text: "Runtime UI acceptance probe" },
          idempotencyKey: request.idempotencyKey,
        },
        signal,
      );
    }
    return controller.showChatCard(
      {
        ...owner,
        content: { kind: "text", text: "Runtime UI acceptance probe" },
        idempotencyKey: request.idempotencyKey,
      },
      signal,
    );
  }

  private firstWorkspaceScope(instances: RuntimeAcceptanceInstances): RuntimeAcceptanceScope {
    for (const sessionId of instances.sessionManager.listAllSessionIds()) {
      this.allowedSessionIds.add(sessionId);
      const workspaceName = instances.sessionManager.getSession(sessionId)?.workspaceName;
      return {
        sessionId,
        workspaceName: workspaceName?.trim() || MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
      };
    }
    for (const sessionId of this.allowedSessionIds) {
      const session = instances.sessionManager.getSession(sessionId);
      if (!session) continue;
      return {
        sessionId,
        workspaceName: session.workspaceName?.trim() || MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
      };
    }
    throw new Error("No acceptance session is available.");
  }

  private requireFixture(fixtureId: string): MaterializedFixture {
    const fixture = this.fixtures.get(fixtureId);
    if (!fixture) throw new Error(`Acceptance fixture was not materialized: ${fixtureId}`);
    const allowedRoot =
      fixture.location === "trusted"
        ? this.paths.trustedExtensionRoot
        : path.join(this.paths.runRoot, "fixtures", "outside-extensions");
    assertPathInside(allowedRoot, fixture.packageRoot, "fixture package root");
    return fixture;
  }

  private objectId(value: object, prefix: string): string {
    const existing = this.objectIds.get(value);
    if (existing) return existing;
    const id = `${prefix}:${randomUUID()}`;
    this.objectIds.set(value, id);
    return id;
  }

  private learnSessionIds(value: unknown, depth = 0): void {
    if (depth > 4 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) this.learnSessionIds(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (
        (key === "sessionId" || key === "childSessionId") &&
        typeof child === "string" &&
        child.trim()
      ) {
        this.allowedSessionIds.add(child);
      } else {
        this.learnSessionIds(child, depth + 1);
      }
    }
  }

  private writeAudit(entry: AcceptanceAuditRecord): void {
    appendJsonLine(path.join(this.paths.evidenceRoot, "api-audit.jsonl"), entry);
  }

  private writeTranscript(entry: unknown): void {
    appendJsonLine(path.join(this.paths.evidenceRoot, "api-transcript.jsonl"), entry);
  }

  private restoreAuditState(): void {
    const auditPath = path.join(this.paths.evidenceRoot, "api-audit.jsonl");
    if (!fs.existsSync(auditPath)) return;
    for (const line of fs.readFileSync(auditPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      // SF-4: self-written acceptance JSONL restores only bounded sequence and scope metadata.
      const parsed: unknown = JSON.parse(line);
      const entry = record(parsed);
      if (Number.isSafeInteger(entry.sequence) && Number(entry.sequence) > this.auditSequence) {
        this.auditSequence = Number(entry.sequence);
      }
      const sessionId = record(entry.scope).sessionId;
      if (typeof sessionId === "string" && sessionId.trim()) {
        this.allowedSessionIds.add(sessionId);
      }
    }
  }
}

function resolveAcceptancePaths(environment: RuntimeAcceptanceEnvironment): RuntimeAcceptancePaths {
  const runRoot = requireAbsolutePath(
    environment.env.MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT,
    "run root",
  );
  const evidenceRoot = environment.env.MARSHAL_RUNTIME_ACCEPTANCE_EVIDENCE_ROOT
    ? requireAbsolutePath(environment.env.MARSHAL_RUNTIME_ACCEPTANCE_EVIDENCE_ROOT, "evidence root")
    : path.join(runRoot, "evidence");
  const runtimeRoot = path.join(environment.appDataRoot, "marshal-runtime");
  const paths: RuntimeAcceptancePaths = {
    runRoot,
    evidenceRoot,
    electronUserDataRoot: environment.userDataRoot,
    marshalAppDataRoot: environment.appDataRoot,
    runtimeRoot,
    workspaceRoot: path.join(runtimeRoot, "workspace"),
    protectedResultsRoot: path.join(runtimeRoot, "protected-results"),
    worktreeRoot: path.join(runtimeRoot, "worktrees"),
    trustedExtensionRoot: path.join(runtimeRoot, "extensions"),
  };
  for (const [label, target] of Object.entries(paths)) {
    if (label !== "runRoot") assertPathInside(runRoot, target, label);
  }
  return paths;
}

function requireAbsolutePath(value: string | undefined, label: string): string {
  if (!value?.trim() || !path.isAbsolute(value)) {
    throw new Error(`Marshal Runtime acceptance ${label} must be an absolute path.`);
  }
  return path.resolve(value);
}

function extendedWindowsPath(filePath: string): string {
  if (process.platform !== "win32") return filePath;
  const resolved = path.resolve(filePath);
  return resolved.startsWith("\\\\") ? `\\\\?\\UNC\\${resolved.slice(2)}` : `\\\\?\\${resolved}`;
}

function assertPathInside(root: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new Error(`Marshal Runtime acceptance ${label} must stay inside the run root.`);
}

function appendJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function abortSignal(abort: RuntimeAcceptanceAbort | undefined): AbortSignal | undefined {
  if (!abort || abort.timing === "none") return undefined;
  if (abort.timing === "after-ms") return AbortSignal.timeout(abort.delayMs);
  if (abort.timing === "fixture-event") {
    throw new Error("Fixture-event cancellation requires an event-aware acceptance handler.");
  }
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

function runtimeCallContext(scope: RuntimeAcceptanceScope, abort?: RuntimeAcceptanceAbort) {
  return {
    sessionId: scope.sessionId,
    metadata: { marshalWorkspaceName: scope.workspaceName },
    signal: abortSignal(abort),
  };
}

function typeScriptSource(
  profile: RuntimeAcceptanceTypeScriptProfile,
  capability?: string,
): string {
  if (profile === "source-empty") return "";
  if (profile === "source-whitespace") return " \r\n\t ";
  if (profile === "source-at-limit") {
    const prefix = "export default async () => true;/*";
    const suffix = "*/";
    return `${prefix}${"x".repeat(2 * 1024 * 1024 - prefix.length - suffix.length)}${suffix}`;
  }
  if (profile === "invoke-capability") {
    if (!capability?.trim()) throw new Error("invoke-capability requires a capability.");
    return `export default async (input, context) => context.runtime.invoke(${JSON.stringify(capability)}, input);`;
  }
  if (profile === "search-capability") {
    return `export default async (input, context) => context.runtime.search(input);`;
  }
  if (profile === "ambient-fs") {
    return ambientAuthorityProbe("node:fs");
  }
  if (profile === "ambient-child-process") {
    return ambientAuthorityProbe("node:child_process");
  }
  if (profile === "ambient-process") {
    return `export default async () => { try { return { available: Boolean(process) }; } catch (error) { console.error(error instanceof Error ? error.name : "Error"); return { available: false, errorName: error instanceof Error ? error.name : "Error" }; } };`;
  }
  if (profile === "undeclared-import") {
    return ambientAuthorityProbe("acceptance-undeclared");
  }
  if (profile === "source-over-limit") return "x".repeat(2 * 1024 * 1024 + 1);
  if (profile === "timeout") {
    return `export default async () => { await new Promise(() => {}); };`;
  }
  return `export default async () => { console.log("x".repeat(4 * 1024 * 1024)); return null; };`;
}

function ambientAuthorityProbe(specifier: string): string {
  return `export default async () => { try { const load = Function("specifier", "return import(specifier)"); await load(${JSON.stringify(specifier)}); return { available: true }; } catch (error) { console.error(error instanceof Error ? error.name : "Error"); return { available: false, errorName: error instanceof Error ? error.name : "Error" }; } };`;
}

function normalizeSelfToolArguments(
  harness: RuntimeAcceptanceHarness,
  toolName: string,
  input: unknown,
): unknown {
  const args = { ...record(input) };
  if (toolName === "runtimeExecuteTypeScript") {
    assertAllowedArgumentKeys(args, [
      "acceptanceProfile",
      "capability",
      "input",
      "timeoutMs",
      "idempotencyKey",
    ]);
    if ("source" in args) throw new Error("Acceptance self-tool calls do not accept source code.");
    if (!isTypeScriptProfile(args.acceptanceProfile)) {
      throw new Error("Acceptance TypeScript self-tool calls require acceptanceProfile.");
    }
    args.source = typeScriptSource(
      args.acceptanceProfile,
      typeof args.capability === "string" ? args.capability : undefined,
    );
    delete args.acceptanceProfile;
    delete args.capability;
  }
  if (toolName === "runtimeInstallExtension" || toolName === "runtimeUpdateExtension") {
    assertAllowedArgumentKeys(args, ["identity", "fixtureId", "idempotencyKey", "version"]);
    if ("packageRoot" in args || "integritySha256" in args) {
      throw new Error("Acceptance extension self-tool calls do not accept package roots.");
    }
    const fixture =
      typeof args.fixtureId === "string"
        ? harness.resolveFixtureForSelfTool(args.fixtureId)
        : undefined;
    if (!fixture) throw new Error("Acceptance extension self-tool calls require fixtureId.");
    args.packageRoot = fixture.packageRoot;
    args.integritySha256 = fixture.integrity.value;
    delete args.fixtureId;
  }
  return args;
}

function assertAllowedArgumentKeys(
  args: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  const rejected = Object.keys(args).filter((key) => !allowed.has(key));
  if (rejected.length > 0) {
    throw new Error(`Acceptance self-tool arguments are not allowlisted: ${rejected.join(", ")}`);
  }
}

interface FixtureLayout {
  readonly capabilityNames: readonly string[];
  readonly providerIds: readonly string[];
  readonly providerCapabilities: readonly (readonly string[])[];
  readonly catalogProviderIds: readonly string[];
  readonly catalogIds: readonly string[];
  readonly resourceUris: readonly string[];
  readonly uiApplicationIds: readonly string[];
}

function fixtureLayout(
  identity: string,
  spec: RuntimeAcceptanceFixtureSpec,
  collisionTarget?: MaterializedFixture,
): FixtureLayout {
  const ownCapabilities =
    spec.profile === "multi-contribution"
      ? [`${identity}.echo`, `${identity}.secondary`]
      : [`${identity}.echo`];
  const ownProviders =
    spec.profile === "multi-contribution"
      ? [`${identity}.provider.primary`, `${identity}.provider.secondary`]
      : spec.profile === "duplicate-capability"
        ? [`${identity}.provider.primary`, `${identity}.provider.duplicate`]
        : [`${identity}.provider.main`];
  const ownCatalogProviders =
    spec.profile === "multi-contribution"
      ? [`${identity}.catalog-provider.primary`, `${identity}.catalog-provider.secondary`]
      : [`${identity}.catalog-provider.main`];
  const ownCatalogIds =
    spec.profile === "multi-contribution"
      ? [`${identity}.catalog.primary`, `${identity}.catalog.secondary`]
      : [`${identity}.catalog.main`];
  const ownResources =
    spec.profile === "duplicate-resource"
      ? ["ui://acceptance/duplicate", "ui://acceptance/duplicate"]
      : spec.profile === "multi-contribution"
        ? [`ui://acceptance/${identity}/primary`, `ui://acceptance/${identity}/secondary`]
        : [`ui://acceptance/${identity}`];
  const ownUiApplications =
    spec.profile === "multi-contribution"
      ? [
          spec.uiApplicationId?.trim() || `${identity}.application.primary`,
          `${identity}.application.secondary`,
        ]
      : spec.profile === "ui-application"
        ? [spec.uiApplicationId?.trim() || `${identity}.application`]
        : [];
  if (spec.profile !== "collision" || !collisionTarget || !spec.collisionKind) {
    return {
      capabilityNames: ownCapabilities,
      providerIds: ownProviders,
      providerCapabilities:
        spec.profile === "multi-contribution"
          ? [[ownCapabilities[0]], [ownCapabilities[1]]]
          : spec.profile === "duplicate-capability"
            ? [ownCapabilities, ownCapabilities]
            : [ownCapabilities],
      catalogProviderIds: ownCatalogProviders,
      catalogIds: ownCatalogIds,
      resourceUris: ownResources,
      uiApplicationIds: ownUiApplications,
    };
  }
  const capabilityNames =
    spec.collisionKind === "capability" ? [collisionTarget.capabilityNames[0]] : ownCapabilities;
  return {
    capabilityNames,
    providerIds:
      spec.collisionKind === "provider" ? [collisionTarget.providerIds[0]] : ownProviders,
    providerCapabilities: [capabilityNames],
    catalogProviderIds:
      spec.collisionKind === "catalog-provider"
        ? [collisionTarget.catalogProviderIds[0]]
        : ownCatalogProviders,
    catalogIds:
      spec.collisionKind === "catalog-entry" ? [collisionTarget.catalogIds[0]] : ownCatalogIds,
    resourceUris:
      spec.collisionKind === "resource" ? [collisionTarget.resourceUris[0]] : ownResources,
    uiApplicationIds: [],
  };
}

function isOversizedFixture(profile: RuntimeAcceptanceFixtureProfile): boolean {
  return (
    profile === "file-count-limit" || profile === "file-size-limit" || profile === "tree-size-limit"
  );
}

function writeFixtureFiles(options: {
  readonly packageRoot: string;
  readonly identity: string;
  readonly version: string;
  readonly spec: RuntimeAcceptanceFixtureSpec;
  readonly eventKey: string;
  readonly layout: FixtureLayout;
}): void {
  writeJson(path.join(options.packageRoot, "package.json"), {
    name: options.identity,
    version: options.version,
    type: "commonjs",
    main: "index.cjs",
  });
  writeJson(path.join(options.packageRoot, "runtime-extension.json"), {
    schemaVersion: 1,
    identity: options.identity,
    version: options.version,
    entrypoint: "index.cjs",
    moduleFormat: "commonjs-bundle-v1",
  });
  fs.writeFileSync(
    path.join(options.packageRoot, "index.cjs"),
    fixtureSource(
      options.identity,
      options.version,
      options.spec.profile,
      options.eventKey,
      options.spec,
      options.layout,
    ),
  );
  if (options.spec.profile === "file-count-limit") {
    for (let index = 0; index < (options.spec.fileCount ?? 2_049); index += 1) {
      fs.writeFileSync(path.join(options.packageRoot, `limit-${index}.txt`), "");
    }
  }
  if (options.spec.profile === "file-size-limit") {
    const filePath = path.join(options.packageRoot, "large.bin");
    fs.writeFileSync(filePath, "");
    fs.truncateSync(filePath, options.spec.fileSizeBytes ?? 33 * 1024 * 1024);
  }
  if (options.spec.profile === "tree-size-limit") {
    const bytes = options.spec.treeSizeBytes ?? 129 * 1024 * 1024;
    const filePath = path.join(options.packageRoot, "tree.bin");
    fs.writeFileSync(filePath, "");
    fs.truncateSync(filePath, bytes);
  }
}

function fixtureSource(
  identity: string,
  version: string,
  profile: RuntimeAcceptanceFixtureProfile,
  eventKey: string,
  spec: RuntimeAcceptanceFixtureSpec | undefined,
  layout: FixtureLayout,
): string {
  if (profile === "unsupported-import") return `require("acceptance-unsupported-import");`;
  const providerDefinitions = layout.providerIds.map((id, index) => ({
    id,
    capabilities: layout.providerCapabilities[index] ?? layout.capabilityNames,
  }));
  const catalogDefinitions = layout.catalogProviderIds.map((id, index) => ({
    id,
    catalogId: layout.catalogIds[index] ?? layout.catalogIds[0],
  }));
  const resources = layout.resourceUris.map((uri, index) => ({
    name: `resource-${index}`,
    uri,
  }));
  const uiApplications =
    layout.uiApplicationIds.length > 0
      ? JSON.stringify(
          layout.uiApplicationIds.map((applicationId) => ({
            id: applicationId,
            title: "Acceptance application",
            description: "Acceptance application",
            renderId: "acceptance-renderer",
            resource: {
              uri: `ui://acceptance/${identity}/application/${encodeURIComponent(applicationId)}`,
              name: "application",
              mimeType: "text/html",
              text: "<main>application</main>",
            },
            application: {
              version,
              presentationModes: ["inline", "fullscreen", "pip"],
              actions: [],
              tools: [],
            },
          })),
        )
      : "undefined";
  const activation =
    profile === "activation-delay"
      ? `await new Promise((resolve) => setTimeout(resolve, ${spec?.activationDelayMs ?? 250}));`
      : profile === "activation-failure"
        ? `throw Object.assign(new Error("acceptance activation failure"), { code: "ACTIVATION_FAILED" });`
        : "";
  const invocationDelay =
    profile === "invocation-delay"
      ? `
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, ${spec?.invocationDelayMs ?? 250});
          const signal = context?.signal;
          if (!signal) return;
          const abort = () => {
            clearTimeout(timer);
            emit("invoke:aborted:" + name);
            reject(Object.assign(new Error("acceptance invocation aborted"), { code: "aborted" }));
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
        emit("invoke:released:" + name);
      `
      : "";
  const disposal =
    profile === "disposal-failure"
      ? `throw Object.assign(new Error("acceptance disposal failure"), { code: "DISPOSAL_FAILED" });`
      : "";
  return `
    const store = globalThis[${JSON.stringify(FIXTURE_EVENT_GLOBAL)}] ??= {};
    const events = store[${JSON.stringify(eventKey)}] ??= [];
    const emit = (event) => {
      events.push(event);
      globalThis[${JSON.stringify(FIXTURE_EVENT_SINK)}]?.(${JSON.stringify(eventKey)}, event);
    };
    const descriptors = ${JSON.stringify(layout.capabilityNames)}.map((name) => Object.freeze({
      protocolVersion: ${JSON.stringify(RUNTIME_PROTOCOL_VERSION)},
      name,
      version: ${JSON.stringify(version)},
      title: "Acceptance fixture",
      description: "Acceptance fixture capability.",
      inputSchema: { type: "object", additionalProperties: true },
      outputSchema: {
        type: "object",
        properties: { version: { type: "string" }, input: {} },
        required: ["version", "input"],
        additionalProperties: false
      },
      permissions: ${
        profile === "unknown-permission"
          ? `[{ permission: "acceptance.unknown", risk: "high" }]`
          : profile === "invocation-delay"
            ? `[{ permission: "marshal.tool.invoke:" + name, risk: "low" }]`
            : "undefined"
      }
    }));
    const providers = ${JSON.stringify(providerDefinitions)}.map((definition) => ({
      id: definition.id,
      version: ${JSON.stringify(version)},
      list() { return descriptors.filter((descriptor) => definition.capabilities.includes(descriptor.name)); },
      get(name) { return descriptors.find((descriptor) => definition.capabilities.includes(name) && descriptor.name === name); },
      async invoke(name, input, context) {
        emit("invoke:" + name);
        if (!definition.capabilities.includes(name)) throw Object.assign(new Error("not found"), { code: "not_found" });
        ${invocationDelay}
        return { output: { version: ${JSON.stringify(version)}, input } };
      }
    }));
    const catalogProviders = ${JSON.stringify(catalogDefinitions)}.map((definition) => {
      const entry = {
        id: definition.catalogId,
        kind: "host_tool",
        title: "Acceptance catalog entry",
        description: "Acceptance catalog entry",
        tags: ["acceptance"],
        action: { type: "host_tool", toolId: "acceptance.fixture" }
      };
      return {
        id: definition.id,
        list() { return [entry]; },
        get(id) { return id === entry.id ? entry : undefined; }
      };
    });
    const resources = ${JSON.stringify(resources)}.map((definition) => ({
      uri: definition.uri,
      name: definition.name,
      mimeType: "text/html",
      text: "<main>" + definition.name + "</main>"
    }));
    module.exports = {
      async activate() {
        emit("activate:start");
        ${activation}
        emit("activate:complete");
        return {
          capabilityProviders: providers,
          catalogProviders,
          resourceProviders: [{
            listResources() { return resources; },
            readResource(uri) {
              const match = resources.find((candidate) => candidate.uri === uri);
              if (!match) throw Object.assign(new Error("not found"), { code: "RESOURCE_NOT_FOUND" });
              return match;
            }
          }],
          uiApplications: ${uiApplications},
          dispose() { emit("dispose"); ${disposal} }
        };
      }
    };
  `;
}

function fixtureEventKey(fixtureId: string): string {
  return `fixture:${fixtureId}`;
}

function permissionToolKeys(permission: string): readonly string[] {
  if (permission.startsWith("ui.")) {
    throw new Error("Fixed built-in UI permissions cannot be changed by the acceptance bridge.");
  }
  if (permission === "code.read") {
    return CODE_READ_CAPABILITIES.map((capability) => `tool:${capability}`);
  }
  if (permission.startsWith("code.")) return [`tool:${permission}`];
  const prefix = "marshal.tool.invoke:";
  if (permission.startsWith(prefix) && permission.length > prefix.length) {
    return [`tool:${permission.slice(prefix.length)}`];
  }
  throw new Error(`Unsupported acceptance permission control: ${permission}`);
}

function isTypeScriptProfile(value: unknown): value is RuntimeAcceptanceTypeScriptProfile {
  return [
    "invoke-capability",
    "search-capability",
    "ambient-fs",
    "ambient-child-process",
    "ambient-process",
    "undeclared-import",
    "source-over-limit",
    "timeout",
    "output-overflow",
  ].includes(String(value));
}

function scopeFromRecord(value: Record<string, unknown>): RuntimeAcceptanceScope | undefined {
  return typeof value.sessionId === "string" && typeof value.workspaceName === "string"
    ? { sessionId: value.sessionId, workspaceName: value.workspaceName }
    : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? Object.fromEntries(Object.entries(value)) : {};
}

function requireFilesystemAcceptanceMemory(memory: IMemoryStore): FilesystemMemoryStore {
  if (memory instanceof FilesystemMemoryStore) return memory;
  throw Object.assign(
    new Error("Runtime acceptance memory controls require the local filesystem memory provider."),
    { code: "acceptance-memory-provider-unsupported" },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function acceptanceResultCode(value: unknown): string | undefined {
  const result = record(value);
  if (result.ok === true) return "ok";
  const error = record(result.error);
  return typeof error.code === "string" ? error.code : undefined;
}

function auditResultMetadata(value: unknown): {
  readonly resultMessage?: string;
  readonly receiptStatuses?: readonly string[];
  readonly cancellationState?: string;
} {
  const result = record(value);
  const error = record(result.error);
  const receipts = Array.isArray(result.receipts) ? result.receipts : [];
  const receiptStatuses = receipts
    .map((receipt) => record(receipt).status)
    .filter((status): status is string => typeof status === "string");
  const resultCode = acceptanceResultCode(value);
  return {
    ...(typeof error.message === "string" ? { resultMessage: error.message.slice(0, 1_024) } : {}),
    ...(receiptStatuses.length > 0 ? { receiptStatuses } : {}),
    ...(resultCode === "aborted" ? { cancellationState: "aborted" } : {}),
  };
}

function errorCode(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "acceptance-operation-failed";
}

function resolveLaunchProfile(value: string | undefined): RuntimeAcceptanceLaunchProfile {
  const profile = value?.trim() || "default";
  if (
    profile === "default" ||
    profile === "pre-ready-quit" ||
    profile === "disposal-aggregation" ||
    profile === "startup-delay" ||
    profile === "runtime-startup-failure"
  ) {
    return profile;
  }
  throw new Error(`Unsupported Marshal Runtime acceptance launch profile: ${profile}`);
}

function extensionPackageRoot(
  variant: RuntimeAcceptancePackageRootVariant,
  fixtureRoot: string,
): string {
  if (variant === "fixture") return fixtureRoot;
  if (variant === "empty") return "";
  if (variant === "whitespace") return " \r\n\t ";
  if (variant === "at-limit") return "x".repeat(32_768);
  return "x".repeat(32_769);
}

function acceptanceErrorDetails(error: unknown): {
  readonly code: string;
  readonly message: string;
} {
  const flattened = flattenErrors(error);
  const preferred =
    flattened.find((entry) => entry.code && entry.code !== "runtime_unavailable") ??
    flattened.find((entry) => entry.code) ??
    flattened[0];
  const code = preferred?.code ?? "acceptance-operation-failed";
  const message = isFileSystemErrorCode(code)
    ? `Marshal Runtime startup failed (${code}).`
    : preferred?.message || "Marshal Runtime host failed to start.";
  return { code, message: message.slice(0, 1_024) };
}

function acceptanceErrorTree(error: unknown, depth = 0): Readonly<Record<string, unknown>> {
  if (depth >= 4) return { code: errorCode(error), message: "Nested disposal error." };
  const summary = {
    name: error instanceof Error ? error.name : "Error",
    code: errorCode(error),
    message:
      error instanceof Error && error.message.trim()
        ? error.message.slice(0, 512)
        : "Marshal Runtime disposal failed.",
  };
  const nested =
    error instanceof AggregateError
      ? error.errors
      : error instanceof Error && error.cause !== undefined
        ? [error.cause]
        : [];
  return {
    ...summary,
    ...(nested.length > 0
      ? { errors: nested.slice(0, 12).map((entry) => acceptanceErrorTree(entry, depth + 1)) }
      : {}),
  };
}

function flattenErrors(
  error: unknown,
  depth = 0,
): readonly { readonly code?: string; readonly message?: string }[] {
  if (depth >= 6) return [];
  const current = {
    ...(typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? { code: error.code }
      : {}),
    ...(error instanceof Error && error.message.trim()
      ? { message: error.message.slice(0, 1_024) }
      : {}),
  };
  const nested =
    error instanceof AggregateError
      ? error.errors
      : error instanceof Error && error.cause !== undefined
        ? [error.cause]
        : [];
  return [current, ...nested.flatMap((entry) => flattenErrors(entry, depth + 1))];
}

function isFileSystemErrorCode(code: string): boolean {
  return ["EACCES", "EPERM", "EROFS", "ENOENT", "ENOTDIR", "EEXIST"].includes(code);
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  // SF-4: acceptance-owned manifest is read only to produce bounded corruption fixtures.
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return record(parsed);
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value));
}
