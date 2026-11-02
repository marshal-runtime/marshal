import {
  MARSHAL_CLOUD_RUNTIME_ID,
  CLAUDE_RUNTIME_ID,
  CODEX_RUNTIME_ID,
  COPILOT_RUNTIME_ID,
  CURSOR_RUNTIME_ID,
  GATEWAY_RUNTIME_ID,
  getRuntimeMetadata,
} from "../../common/runtime-config";
import { PEER_RUNTIME_IDS } from "../../common/runtime-qualified-model";
import type { HostedRuntimeProvider } from "../hosted-runtime/contracts";
import { resolveHostedRuntimeProvider } from "../hosted-runtime/current";
import {
  createClaudeClientFactory,
  type ClaudeClientFactoryOptions,
} from "./claude/client-factory";
import { createCloudClientFactory } from "./cloud/client";
import { createLocalRuntimeCapabilities } from "./local/capabilities";
import { createClaudeLocalRuntimeStrategy } from "./claude/strategy";
import { codexAccountHome } from "./codex/accounts";
import { createCodexClientFactory, type CodexClientFactoryOptions } from "./codex/factory";
import { createCodexLocalRuntimeStrategy } from "./codex/strategy";
import { createRealClientFactory } from "./copilot/client-factory";
import { createMockClientFactory } from "./copilot/mock-client";
import { CopilotBackend } from "./copilot/provider";
import { createCursorClientFactory } from "./cursor/factory";
import { createCursorLocalRuntimeStrategy } from "./cursor/strategy";
import { MockGatewayWsClient } from "./gateway/mock-ws-client";
import type { GatewayNodeSubsystemDeps } from "./gateway/node-subsystem";
import { GatewayBackend, type GatewayBackendConfig } from "./gateway/provider";
import type { PeerClientFactoryResolver } from "./local/peer-clients";
import { LocalBackend } from "./local/provider";
import { RuntimeAdapterRegistry, type RuntimeAdapterCreateContext } from "./registry";
import type { RuntimeClientFactory } from "./runtime-contract";
import type { IBackendProvider } from "./types";

export interface CreateBackendConfig extends RuntimeAdapterCreateContext {
  runtimeId: string;
  gatewayE2E?: boolean;
  gatewayDeviceIdentityPath?: string;
  gatewayNodeDeps?: GatewayNodeSubsystemDeps;
}

type BuiltinRuntimeContext = Omit<CreateBackendConfig, "runtimeId">;

export function buildCodexClientFactoryOptions(
  config: Pick<BuiltinRuntimeContext, "isPackaged" | "resourcesPath">,
): CodexClientFactoryOptions {
  return {
    ...(config.isPackaged !== undefined ? { isPackaged: config.isPackaged } : {}),
    ...(config.resourcesPath ? { resourcesPath: config.resourcesPath } : {}),
  };
}

export function buildClaudeClientFactoryOptions(
  config: Pick<BuiltinRuntimeContext, "isPackaged" | "resourcesPath">,
): ClaudeClientFactoryOptions {
  return {
    ...(config.isPackaged !== undefined ? { isPackaged: config.isPackaged } : {}),
    ...(config.resourcesPath ? { resourcesPath: config.resourcesPath } : {}),
  };
}

export function buildGatewayBackendConfig(opts: {
  deviceIdentityPath: string;
  hostedRuntime?: HostedRuntimeProvider;
}): GatewayBackendConfig {
  const hostedRuntime = opts.hostedRuntime ?? resolveHostedRuntimeProvider();
  const endpoint = hostedRuntime.resolveEndpoint();
  // Marshal identity: the MARSHAL_* name and endpoint path are Gateway service contracts.
  return {
    gatewayUrl: process.env.MARSHAL_GATEWAY_URL ?? "ws://localhost:8001/v1/marshal-gateway",
    hostedGatewayUrl: endpoint.url,
    deviceIdentityPath: hostedRuntime.resolveDeviceIdentityPath(opts.deviceIdentityPath),
    gatewayToken: endpoint.sharedToken,
    hostedRuntime,
  };
}

function peerClientFactoryResolver(
  registry: RuntimeAdapterRegistry<BuiltinRuntimeContext>,
  config: BuiltinRuntimeContext,
): PeerClientFactoryResolver {
  return (runtimeId, accountId) =>
    PEER_RUNTIME_IDS.has(runtimeId)
      ? registry.createClientFactory(runtimeId, config, accountId)
      : null;
}

export function createBuiltinRuntimeRegistry(): RuntimeAdapterRegistry<BuiltinRuntimeContext> {
  const registry = new RuntimeAdapterRegistry<BuiltinRuntimeContext>();
  registry.register({
    id: MARSHAL_CLOUD_RUNTIME_ID, origin: "copilot",
    createClientFactory: () => createCloudClientFactory(),
    create: config => new LocalBackend({
      workspaceDir: config.workspaceDir, clientFactory: createCloudClientFactory(),
      strategy: { runtimeId: MARSHAL_CLOUD_RUNTIME_ID, origin: "copilot", displayName: "Marshal Cloud",
        sessionConfigTraceFilename: "m-cloud-session-config-trace.jsonl", defaultInferenceModel: "",
        preferredDefaultModelIds: [], accountIdentityPrefix: "marshal-cloud",
        capabilities: createLocalRuntimeCapabilities(), loadWorkspaceFiles: () => null },
      peerClientFactory: peerClientFactoryResolver(registry, config),
    }),
  });
  registry.register({
    id: COPILOT_RUNTIME_ID,
    origin: getRuntimeMetadata(COPILOT_RUNTIME_ID).compatibilityOrigin,
    create: (config) =>
      new CopilotBackend({
        workspaceDir: config.workspaceDir,
        clientFactory: config.mockMode ? createMockClientFactory() : createRealClientFactory(),
      }),
    createClientFactory: (config) =>
      config.mockMode ? createMockClientFactory() : createRealClientFactory(),
  });
  registry.register({
    id: CLAUDE_RUNTIME_ID,
    origin: getRuntimeMetadata(CLAUDE_RUNTIME_ID).compatibilityOrigin,
    create: (config) =>
      new LocalBackend({
        workspaceDir: config.workspaceDir,
        clientFactory: createClaudeClientFactory(buildClaudeClientFactoryOptions(config)),
        strategy: createClaudeLocalRuntimeStrategy(),
        peerClientFactory: peerClientFactoryResolver(registry, config),
      }),
    createClientFactory: (config, accountId) =>
      createClaudeClientFactory({
        ...buildClaudeClientFactoryOptions(config),
        ...(accountId ? { accountId } : {}),
      }),
  });
  registry.register({
    id: CODEX_RUNTIME_ID,
    origin: getRuntimeMetadata(CODEX_RUNTIME_ID).compatibilityOrigin,
    create: (config) =>
      new LocalBackend({
        workspaceDir: config.workspaceDir,
        clientFactory: createCodexClientFactory(buildCodexClientFactoryOptions(config)),
        strategy: createCodexLocalRuntimeStrategy(),
        peerClientFactory: peerClientFactoryResolver(registry, config),
      }),
    createClientFactory: (config, accountId) =>
      createCodexClientFactory({
        ...buildCodexClientFactoryOptions(config),
        ...(accountId ? { codexHome: codexAccountHome(accountId) } : {}),
      }),
  });
  registry.register({
    id: CURSOR_RUNTIME_ID,
    origin: getRuntimeMetadata(CURSOR_RUNTIME_ID).compatibilityOrigin,
    create: (config) =>
      new LocalBackend({
        workspaceDir: config.workspaceDir,
        clientFactory: createCursorClientFactory(),
        strategy: createCursorLocalRuntimeStrategy(),
        peerClientFactory: peerClientFactoryResolver(registry, config),
      }),
    createClientFactory: (_config, accountId) =>
      createCursorClientFactory(accountId ? { accountId } : {}),
  });
  registry.register({
    id: GATEWAY_RUNTIME_ID,
    origin: getRuntimeMetadata(GATEWAY_RUNTIME_ID).compatibilityOrigin,
    create: (config) => {
      if (!config.gatewayDeviceIdentityPath) {
        throw new Error(
          `Runtime adapter "${GATEWAY_RUNTIME_ID}" requires gatewayDeviceIdentityPath`,
        );
      }
      if (config.mockMode && !config.gatewayE2E) {
        throw new Error(
          `Runtime adapter "${GATEWAY_RUNTIME_ID}" only supports mock mode through the gateway E2E composition`,
        );
      }
      return new GatewayBackend(
        buildGatewayBackendConfig({ deviceIdentityPath: config.gatewayDeviceIdentityPath }),
        config.gatewayNodeDeps,
        config.mockMode ? (_args) => new MockGatewayWsClient() : undefined,
      );
    },
  });
  return registry;
}

const builtinRuntimeRegistry = createBuiltinRuntimeRegistry();

export function createBackend(config: CreateBackendConfig): IBackendProvider {
  const { runtimeId, ...context } = config;
  return builtinRuntimeRegistry.create(runtimeId, context);
}

export function createClientFactory(
  runtimeId: string,
  config: BuiltinRuntimeContext,
  accountId?: string,
): RuntimeClientFactory | null {
  return builtinRuntimeRegistry.createClientFactory(runtimeId, config, accountId);
}
