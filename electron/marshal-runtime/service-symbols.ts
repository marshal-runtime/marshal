import {
  createRuntimeServiceToken,
  type InvocationContext,
  type RuntimeCompositionServiceDescriptor,
} from "@marshal/runtime";
import type { PermissionDecision } from "@marshal/runtime/core";

import type {
  OverlayReviewLaunchRequest,
  SessionRuntimeAgentRole,
} from "../../common/marshal-ipc-contract";
import type { MemoryProviderRegistrationService } from "../active-memory-store";
import type {
  MarshalRuntimeAgentMessageResult,
  MarshalRuntimeAgentSummary,
  MarshalRuntimeAgentTranscript,
  MarshalRuntimeAgentWaitResult,
} from "./agent-orchestration";
import type {
  MarshalRuntimeBrainMessageResult,
  MarshalRuntimeBrainSummary,
  MarshalRuntimeBrainTranscript,
  MarshalRuntimeBrainWaitResult,
} from "./brain-provider";
import type { MarshalRuntimeBrowserCommandResult } from "./browser-command-executor";
import type { ResolvedMarshalRuntimeScope } from "./contracts";
import type {
  MarshalRuntimeMemoryRecallResult,
  MarshalRuntimeMemoryStoreResult,
} from "./runtime-memory";
import type {
  RuntimeUiChatCardDelivery,
  RuntimeUiChatMessageDelivery,
  RuntimeUiNotificationDelivery,
} from "./ui-controller";

export interface MarshalAuthorityService {
  resolveScope(
    input: MarshalRuntimeEmptyInput,
    context?: InvocationContext,
  ): Promise<ResolvedMarshalRuntimeScope | null>;
  authorize(
    input: MarshalRuntimeAuthorizeInput,
    context?: InvocationContext,
  ): Promise<PermissionDecision>;
}
export interface MarshalCatalogService {
  listTools(
    input: MarshalRuntimeEmptyInput,
    context?: InvocationContext,
  ): Promise<{
    readonly tools: readonly MarshalRuntimeToolDescriptor[];
  }>;
  listNativeTools(sessionId: string): readonly import("../backend/runtime-contract").RuntimeTool[];
  onToolsListed?(tools: readonly import("../backend/runtime-contract").RuntimeTool[]): void;
  onToolInvoked?(tool: import("../backend/runtime-contract").RuntimeTool): void;
  listSkills(
    input: MarshalRuntimeEmptyInput,
    context?: InvocationContext,
  ): Promise<{
    readonly skills: readonly {
      readonly id: string;
      readonly name: string;
      readonly displayName?: string;
      readonly description: string;
      readonly instructions: string;
      readonly enabled: boolean;
      readonly createdAt: string;
      readonly scope: "local" | "global" | "bundled";
      readonly bundleDirs?: string[];
    }[];
  }>;
  getSkill(
    input: MarshalRuntimeGetSkillInput,
    context?: InvocationContext,
  ): Promise<{
    readonly skill: {
      readonly name: string;
      readonly displayName?: string;
      readonly description: string;
      readonly instructions: string;
      readonly resourceDir: string | null;
      readonly enabled: boolean;
      readonly createdAt: string;
      readonly scope: "local" | "global" | "bundled";
      readonly bundleDirs?: string[];
    } | null;
  }>;
  listWorkspaces(
    input: MarshalRuntimeEmptyInput,
    context?: InvocationContext,
  ): Promise<{
    readonly workspaces: readonly { readonly name: string; readonly path: string }[];
  }>;
  getSessionContext(
    input: MarshalRuntimeEmptyInput,
    context?: InvocationContext,
  ): Promise<{
    readonly session: {
      readonly id: string;
      readonly name: string;
      readonly workspaceName?: string;
      readonly repoPath?: string;
      readonly source?: string;
    } | null;
  }>;
}
export interface MarshalAgentsService {
  launch(
    input: MarshalRuntimeAgentLaunchInput,
    context?: InvocationContext,
  ): Promise<{ readonly agent: MarshalRuntimeAgentSummary }>;
  list(
    input: MarshalRuntimeEmptyInput,
    context?: InvocationContext,
  ): Promise<{ readonly agents: readonly MarshalRuntimeAgentSummary[] }>;
  get(
    input: MarshalRuntimeAgentGetInput,
    context?: InvocationContext,
  ): Promise<{ readonly agent: MarshalRuntimeAgentSummary | null }>;
  send(
    input: MarshalRuntimeAgentSendInput,
    context?: InvocationContext,
  ): Promise<MarshalRuntimeAgentMessageResult>;
  transcript(
    input: MarshalRuntimeAgentTranscriptInput,
    context?: InvocationContext,
  ): Promise<MarshalRuntimeAgentTranscript>;
  wait(
    input: MarshalRuntimeAgentWaitInput,
    context?: InvocationContext,
  ): Promise<MarshalRuntimeAgentWaitResult>;
  cancel(
    input: MarshalRuntimeAgentGetInput,
    context?: InvocationContext,
  ): Promise<{ readonly agent: MarshalRuntimeAgentSummary }>;
  setModel(
    input: MarshalRuntimeAgentSetModelInput,
    context?: InvocationContext,
  ): Promise<{ readonly agent: MarshalRuntimeAgentSummary }>;
}
export interface MarshalBrainService {
  launch(
    input: MarshalRuntimeBrainLaunchInput,
    context?: InvocationContext,
  ): Promise<{ readonly agent: MarshalRuntimeBrainSummary }>;
  get(
    input: MarshalRuntimeEmptyInput,
    context?: InvocationContext,
  ): Promise<{ readonly agent: MarshalRuntimeBrainSummary | null }>;
  send(
    input: MarshalRuntimeBrainSendInput,
    context?: InvocationContext,
  ): Promise<MarshalRuntimeBrainMessageResult>;
  transcript(
    input: MarshalRuntimeBrainTranscriptInput,
    context?: InvocationContext,
  ): Promise<MarshalRuntimeBrainTranscript>;
  wait(
    input: MarshalRuntimeBrainWaitInput,
    context?: InvocationContext,
  ): Promise<MarshalRuntimeBrainWaitResult>;
  cancel(
    input: MarshalRuntimeEmptyInput,
    context?: InvocationContext,
  ): Promise<{ readonly agent: MarshalRuntimeBrainSummary }>;
}
export interface MarshalMemoryService {
  store(
    input: MarshalRuntimeMemoryStoreInput,
    context?: InvocationContext,
  ): Promise<MarshalRuntimeMemoryStoreResult>;
  recall(
    input: MarshalRuntimeMemoryRecallInput,
    context?: InvocationContext,
  ): Promise<MarshalRuntimeMemoryRecallResult>;
}
export interface MarshalBrowserExecutionService {
  execute(
    input: MarshalRuntimeBrowserInput,
    context?: InvocationContext,
  ): Promise<MarshalRuntimeBrowserCommandResult>;
  dispose(): Promise<void>;
}
export interface MarshalUiDeliveryService {
  notification(
    input: RuntimeUiNotificationDelivery,
    context?: InvocationContext,
  ): Promise<void> | void;
  chatMessage(
    input: RuntimeUiChatMessageDelivery,
    context?: InvocationContext,
  ): Promise<void> | void;
  chatCard(input: RuntimeUiChatCardDelivery, context?: InvocationContext): Promise<void> | void;
}
export interface MarshalUiReviewService {
  launch(request: OverlayReviewLaunchRequest): void | Promise<void>;
}

const authority = createRuntimeServiceToken<MarshalAuthorityService>("@marshal/marshal:authority");
const catalog = createRuntimeServiceToken<MarshalCatalogService>("@marshal/marshal:catalog");
const agents = createRuntimeServiceToken<MarshalAgentsService>("@marshal/marshal:agents");
const brain = createRuntimeServiceToken<MarshalBrainService>("@marshal/marshal:brain");
const memory = createRuntimeServiceToken<MarshalMemoryService>("@marshal/marshal:memory");
const memoryProviderRegistry = createRuntimeServiceToken<MemoryProviderRegistrationService>(
  "@marshal/marshal:memory-provider-registry",
);
const browserExecution = createRuntimeServiceToken<MarshalBrowserExecutionService>(
  "@marshal/marshal:browser.execution",
);
const uiDelivery = createRuntimeServiceToken<MarshalUiDeliveryService>(
  "@marshal/marshal:ui.delivery",
);
const uiReview = createRuntimeServiceToken<MarshalUiReviewService>("@marshal/marshal:ui.review");

export const MarshalServiceSymbols = Object.freeze({
  authority,
  catalog,
  agents,
  brain,
  memory,
  memoryProviderRegistry,
  browserExecution,
  uiDelivery,
  uiReview,
});

export type MarshalServiceName = keyof typeof MarshalServiceSymbols;

export interface MarshalServiceMap {
  readonly authority: MarshalAuthorityService;
  readonly catalog: MarshalCatalogService;
  readonly agents: MarshalAgentsService;
  readonly brain: MarshalBrainService;
  readonly memory: MarshalMemoryService;
  readonly memoryProviderRegistry: MemoryProviderRegistrationService;
  readonly browserExecution: MarshalBrowserExecutionService;
  readonly uiDelivery: MarshalUiDeliveryService;
  readonly uiReview: MarshalUiReviewService;
}

export type MarshalRuntimeEmptyInput = Readonly<Record<string, never>>;
export interface MarshalRuntimeGetSkillInput {
  readonly name: string;
}
export interface MarshalRuntimeToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}
export interface MarshalRuntimeAuthorizeInput {
  readonly capability: string;
  readonly permissions: readonly string[];
  readonly input: unknown;
}
export interface MarshalRuntimeBrowserInput {
  readonly command: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly context: {
    readonly chatId: string;
    readonly executionId: string;
    readonly browserSessionId: string;
  };
}
export interface MarshalRuntimeAgentLaunchInput {
  readonly task: string;
  readonly idempotencyKey: string;
  readonly sessionId?: string;
  readonly workspaceName?: string;
  readonly repoPath?: string;
  readonly name?: string;
  readonly agentName?: string;
  readonly model?: string;
  readonly runtime?: string;
  readonly reasoningEffort?: string;
  readonly soul?: string;
  readonly runtimeAgentRole?: SessionRuntimeAgentRole;
  readonly allowedTools?: readonly string[];
  readonly systemPrompt?: string;
  readonly attachments?: readonly string[];
  readonly createWorktree?: boolean;
  readonly worktreeName?: string;
  readonly branchName?: string;
  readonly baseRef?: string;
}
export interface MarshalRuntimeAgentGetInput {
  readonly agentId: string;
}
export interface MarshalRuntimeAgentSendInput extends MarshalRuntimeAgentGetInput {
  readonly message: string;
  readonly deliveryMode?: "queue" | "interrupt";
}
export interface MarshalRuntimeAgentTranscriptInput extends MarshalRuntimeAgentGetInput {
  readonly limit?: number;
}
export interface MarshalRuntimeAgentWaitInput extends MarshalRuntimeAgentGetInput {
  readonly messageId?: string;
  readonly timeoutMs?: number;
}
export interface MarshalRuntimeAgentSetModelInput extends MarshalRuntimeAgentGetInput {
  readonly model: string;
  readonly reasoningEffort?: string;
}
export interface MarshalRuntimeBrainLaunchInput {
  readonly task?: string;
  readonly name?: string;
  readonly agentName?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly soul?: string;
}
export interface MarshalRuntimeBrainSendInput {
  readonly message: string;
  readonly deliveryMode?: "queue" | "interrupt";
}
export interface MarshalRuntimeBrainTranscriptInput {
  readonly limit?: number;
}
export interface MarshalRuntimeBrainWaitInput {
  readonly messageId?: string;
  readonly timeoutMs?: number;
}
export interface MarshalRuntimeMemoryStoreInput {
  readonly fact: string;
  readonly category?: "preference" | "fact" | "decision" | "context";
}
export interface MarshalRuntimeMemoryRecallInput {
  readonly query: string;
  readonly limit?: number;
}

export const MARSHAL_APP_SERVICE_DECLARATIONS = {
  agents: `export interface IAgents {
  launch(input: MarshalRuntimeAgentLaunchInput): Promise<{ agent: MarshalRuntimeAgentSummary }>;
  list(input: MarshalRuntimeEmptyInput): Promise<{ agents: MarshalRuntimeAgentSummary[] }>;
  get(input: MarshalRuntimeAgentGetInput): Promise<{ agent: MarshalRuntimeAgentSummary | null }>;
  send(input: MarshalRuntimeAgentSendInput): Promise<MarshalRuntimeAgentMessageResult>;
  transcript(input: MarshalRuntimeAgentTranscriptInput): Promise<MarshalRuntimeAgentTranscript>;
  wait(input: MarshalRuntimeAgentWaitInput): Promise<MarshalRuntimeAgentWaitResult>;
  cancel(input: MarshalRuntimeAgentGetInput): Promise<{ agent: MarshalRuntimeAgentSummary }>;
  setModel(input: MarshalRuntimeAgentSetModelInput): Promise<{ agent: MarshalRuntimeAgentSummary }>;
}
export interface MarshalRuntimeEmptyInput {}
export interface MarshalRuntimeAgentLaunchInput { task: string; idempotencyKey: string; sessionId?: string; workspaceName?: string; repoPath?: string; name?: string; agentName?: string; model?: string; runtime?: string; reasoningEffort?: string; soul?: string; runtimeAgentRole?: "planner" | "worker" | "reviewer" | "validator" | "reconciler" | "brain" | "swarm"; allowedTools?: string[]; systemPrompt?: string; attachments?: string[]; createWorktree?: boolean; worktreeName?: string; branchName?: string; baseRef?: string; }
export interface MarshalRuntimeAgentGetInput { agentId: string }
export interface MarshalRuntimeAgentSendInput extends MarshalRuntimeAgentGetInput { message: string; deliveryMode?: "queue" | "interrupt"; }
export interface MarshalRuntimeAgentTranscriptInput extends MarshalRuntimeAgentGetInput { limit?: number }
export interface MarshalRuntimeAgentWaitInput extends MarshalRuntimeAgentGetInput { messageId?: string; timeoutMs?: number }
export interface MarshalRuntimeAgentSetModelInput extends MarshalRuntimeAgentGetInput { model: string; reasoningEffort?: string }
export interface MarshalRuntimeAgentSummary { id: string; name: string; state: "running" | "idle"; createdAt: string; updatedAt: string; workspaceName?: string; repoPath?: string; model?: string; reasoningEffort?: string; soul?: string; runtimeAgentRole?: "planner" | "worker" | "reviewer" | "validator" | "reconciler" | "brain" | "swarm" }
export interface MarshalRuntimeAgentMessageResult { agent: MarshalRuntimeAgentSummary; accepted: true; messageId?: string; deliveryState?: string }
export interface MarshalRuntimeAgentTranscript { agent: MarshalRuntimeAgentSummary; messageCount: number; showing: number; messages: Array<{ id: string; role: "user" | "assistant" | "system"; content: string; timestamp: string; error?: boolean }>; result?: string }
export interface MarshalRuntimeAgentWaitResult { state: "completed" | "timeout"; agent: MarshalRuntimeAgentSummary; result?: string; usage?: { tokens?: number; costUsd?: number } }`,
  brain: `export interface IBrain {
  launch(input: MarshalRuntimeBrainLaunchInput): Promise<{ agent: MarshalRuntimeBrainSummary }>;
  get(input: MarshalRuntimeEmptyInput): Promise<{ agent: MarshalRuntimeBrainSummary | null }>;
  send(input: MarshalRuntimeBrainSendInput): Promise<MarshalRuntimeBrainMessageResult>;
  transcript(input: MarshalRuntimeBrainTranscriptInput): Promise<MarshalRuntimeBrainTranscript>;
  wait(input: MarshalRuntimeBrainWaitInput): Promise<MarshalRuntimeBrainWaitResult>;
  cancel(input: MarshalRuntimeEmptyInput): Promise<{ agent: MarshalRuntimeBrainSummary }>;
}
export interface MarshalRuntimeEmptyInput {}
export interface MarshalRuntimeBrainLaunchInput { task?: string; name?: string; agentName?: string; model?: string; reasoningEffort?: string; soul?: string }
export interface MarshalRuntimeBrainSendInput { message: string; deliveryMode?: "queue" | "interrupt" }
export interface MarshalRuntimeBrainTranscriptInput { limit?: number }
export interface MarshalRuntimeBrainWaitInput { messageId?: string; timeoutMs?: number }
export interface MarshalRuntimeBrainSummary { id: string; name: string; state: "running" | "idle"; createdAt: string; updatedAt: string; workspaceName?: string; repoPath?: string; model?: string; reasoningEffort?: string; soul?: string; runtimeAgentRole: "brain" }
export interface MarshalRuntimeBrainMessageResult { agent: MarshalRuntimeBrainSummary; accepted: true; messageId?: string; deliveryState?: string }
export interface MarshalRuntimeBrainTranscript { agent: MarshalRuntimeBrainSummary; messageCount: number; showing: number; messages: Array<{ id: string; role: "user" | "assistant" | "system"; content: string; timestamp: string; error?: boolean }>; result?: string }
export interface MarshalRuntimeBrainWaitResult { state: "completed" | "timeout"; agent: MarshalRuntimeBrainSummary; result?: string }`,
  memory: `export interface IMemory {
  store(input: MarshalRuntimeMemoryStoreInput): Promise<MarshalRuntimeMemoryStoreResult>;
  recall(input: MarshalRuntimeMemoryRecallInput): Promise<MarshalRuntimeMemoryRecallResult>;
}
export interface MarshalRuntimeMemoryStoreInput { fact: string; category?: "preference" | "fact" | "decision" | "context" }
export interface MarshalRuntimeMemoryRecallInput { query: string; limit?: number }
export interface MarshalRuntimeMemoryValue { id: string; fact: string; category: "preference" | "fact" | "decision" | "context"; source: string; createdAt: string; lastAccessedAt: string; accessCount: number }
export interface MarshalRuntimeMemoryStoreResult { memory: MarshalRuntimeMemoryValue; deduplicated: boolean; visibility: "exact-runtime-scope" }
export interface MarshalRuntimeMemoryRecallResult { memories: MarshalRuntimeMemoryValue[]; visibility: "exact-runtime-scope" }`,
  memoryProviderRegistry: `export interface IMemoryProviderRegistry {
  register(provider: MemoryStoreProvider): Promise<{ dispose(): Promise<void> }>;
}
export interface MemoryStoreProvider { id: string; store: unknown; dispose?(): void | Promise<void> }`,
  authority: `export interface IAuthority {
  resolveScope(input: {}): Promise<{ sessionId: string; workspaceName: string; workspacePath: string } | null>;
  authorize(input: { capability: string; permissions: string[]; input: unknown }): Promise<"approve" | "deny" | "prompt">;
}`,
  catalog: `export interface ICatalog {
  listSkills(input: {}): Promise<{ skills: Array<{ id: string; name: string; displayName?: string; description: string; instructions: string; enabled: boolean; createdAt: string; scope: "local" | "global" | "bundled"; bundleDirs?: string[] }> }>;
  getSkill(input: { name: string }): Promise<{ skill: { name: string; displayName?: string; description: string; instructions: string; resourceDir: string | null; enabled: boolean; createdAt: string; scope: "local" | "global" | "bundled"; bundleDirs?: string[] } | null }>;
  listWorkspaces(input: {}): Promise<{ workspaces: Array<{ name: string; path: string }> }>;
  getSessionContext(input: {}): Promise<{ session: { id: string; name: string; workspaceName?: string; repoPath?: string; source?: string } | null }>;
  listTools(input: {}): Promise<{ tools: Array<{ name: string; description?: string; parameters?: unknown }> }>;
}`,
  browserExecution: `export interface IBrowserExecution {
  execute(input: { command: string; input: Record<string, unknown>; context: { chatId: string; executionId: string; browserSessionId: string }}): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown }; metadata?: { duration: number; timestamp: number; commandId?: string; context?: { chatId: string; executionId: string; browserSessionId: string } } }>;
}`,
  uiDelivery: `export interface IUiDelivery {
  notification(input: { deliveryId: string; owner: unknown; title: string; message: string }): Promise<void>;
  chatMessage(input: { deliveryId: string; owner: unknown; content: unknown }): Promise<void>;
  chatCard(input: { deliveryId: string; owner: unknown; content: unknown }): Promise<void>;
}`,
  uiReview: `export interface IUiReview {
  launch(input: { sessionId: string; sessionTitle?: string }): Promise<void>;
}`,
} as const;

const authorityComposition: RuntimeCompositionServiceDescriptor<MarshalAuthorityService> = {
  key: "@marshal/marshal:authority",
  token: authority,
  contract: {
    name: "@marshal/marshal:authority",
    version: "1.0.0",
    declaration: MARSHAL_APP_SERVICE_DECLARATIONS.authority,
    methods: [
      {
        name: "resolveScope",
        input: "{}",
        output: "{ sessionId: string; workspaceName: string; workspacePath: string } | null",
        description: "Resolve the current invocation to an authorized workspace scope.",
      },
      {
        name: "authorize",
        input: "{ capability: string; permissions: string[]; input: unknown }",
        output: '"approve" | "deny" | "prompt"',
        description: "Evaluate a capability request using the current Marshal policy.",
      },
    ],
  },
};
const catalogComposition: RuntimeCompositionServiceDescriptor<MarshalCatalogService> = {
  key: "@marshal/marshal:catalog",
  token: catalog,
  contract: {
    name: "@marshal/marshal:catalog",
    version: "1.0.0",
    declaration: MARSHAL_APP_SERVICE_DECLARATIONS.catalog,
    methods: [
      {
        name: "listSkills",
        input: "{}",
        output:
          '{ skills: Array<{ id: string; name: string; displayName?: string; description: string; instructions: string; enabled: boolean; createdAt: string; scope: "local" | "global" | "bundled"; bundleDirs?: string[] }> }',
        description: "List skills visible to the current session.",
      },
      {
        name: "getSkill",
        input: "{ name: string }",
        output:
          '{ skill: { name: string; displayName?: string; description: string; instructions: string; resourceDir: string | null; enabled: boolean; createdAt: string; scope: "local" | "global" | "bundled"; bundleDirs?: string[] } | null }',
        description: "Read one visible skill.",
      },
      {
        name: "listWorkspaces",
        input: "{}",
        output: "{ workspaces: Array<{ name: string; path: string }> }",
        description: "List available Marshal workspaces.",
      },
      {
        name: "getSessionContext",
        input: "{}",
        output:
          "{ session: { id: string; name: string; workspaceName?: string; repoPath?: string; source?: string } | null }",
        description: "Read the current session context.",
      },
      {
        name: "listTools",
        input: "{}",
        output: "{ tools: Array<{ name: string; description?: string; parameters?: unknown }> }",
        description: "List tool descriptors. Executable handlers remain native host values.",
      },
    ],
  },
};
const agentsComposition: RuntimeCompositionServiceDescriptor<MarshalAgentsService> = {
  key: "@marshal/marshal:agents",
  token: agents,
  contract: {
    name: "@marshal/marshal:agents",
    version: "1.0.0",
    declaration: MARSHAL_APP_SERVICE_DECLARATIONS.agents,
    methods: [
      {
        name: "launch",
        input: "MarshalRuntimeAgentLaunchInput",
        output: "{ agent: MarshalRuntimeAgentSummary }",
        description:
          "Launch an ordinary child agent, optionally on a selected runtime account or in a specified workspace or worktree.",
        examples: [
          "await AppServices.getAgents().launch({ task, idempotencyKey, workspaceName, createWorktree: true });",
          'await AppServices.getAgents().launch({ task, idempotencyKey, runtime: "claude@work", model: "opus" });',
        ],
      },
      {
        name: "list",
        input: "MarshalRuntimeEmptyInput",
        output: "{ agents: MarshalRuntimeAgentSummary[] }",
        description: "List child agents owned by the current session.",
      },
      {
        name: "get",
        input: "MarshalRuntimeAgentGetInput",
        output: "{ agent: MarshalRuntimeAgentSummary | null }",
        description: "Get one child agent by id.",
      },
      {
        name: "send",
        input: "MarshalRuntimeAgentSendInput",
        output: "MarshalRuntimeAgentMessageResult",
        description: "Send a message to a child agent.",
      },
      {
        name: "transcript",
        input: "MarshalRuntimeAgentTranscriptInput",
        output: "MarshalRuntimeAgentTranscript",
        description: "Read a bounded child-agent transcript.",
      },
      {
        name: "wait",
        input: "MarshalRuntimeAgentWaitInput",
        output: "MarshalRuntimeAgentWaitResult",
        description: "Wait for a child agent to complete or time out.",
      },
      {
        name: "cancel",
        input: "MarshalRuntimeAgentGetInput",
        output: "{ agent: MarshalRuntimeAgentSummary }",
        description: "Cancel the current child-agent turn.",
      },
      {
        name: "setModel",
        input: "MarshalRuntimeAgentSetModelInput",
        output: "{ agent: MarshalRuntimeAgentSummary }",
        description:
          "Switch an idle child agent's model in place, including to a model on another runtime.",
      },
    ],
  },
};
const brainComposition: RuntimeCompositionServiceDescriptor<MarshalBrainService> = {
  key: "@marshal/marshal:brain",
  token: brain,
  contract: {
    name: "@marshal/marshal:brain",
    version: "1.0.0",
    declaration: MARSHAL_APP_SERVICE_DECLARATIONS.brain,
    methods: [
      {
        name: "launch",
        input: "MarshalRuntimeBrainLaunchInput",
        output: "{ agent: MarshalRuntimeBrainSummary }",
        description: "Launch or recover the Brain agent.",
        examples: ["await AppServices.getBrain().launch({});"],
      },
      {
        name: "get",
        input: "MarshalRuntimeEmptyInput",
        output: "{ agent: MarshalRuntimeBrainSummary | null }",
        description: "Get the Brain agent for the current session.",
      },
      {
        name: "send",
        input: "MarshalRuntimeBrainSendInput",
        output: "MarshalRuntimeBrainMessageResult",
        description: "Send a message to the Brain agent.",
      },
      {
        name: "transcript",
        input: "MarshalRuntimeBrainTranscriptInput",
        output: "MarshalRuntimeBrainTranscript",
        description: "Read the Brain transcript.",
      },
      {
        name: "wait",
        input: "MarshalRuntimeBrainWaitInput",
        output: "MarshalRuntimeBrainWaitResult",
        description: "Wait for the Brain agent to complete or time out.",
      },
      {
        name: "cancel",
        input: "MarshalRuntimeEmptyInput",
        output: "{ agent: MarshalRuntimeBrainSummary }",
        description: "Cancel the Brain's current turn.",
      },
    ],
  },
};
const memoryComposition: RuntimeCompositionServiceDescriptor<MarshalMemoryService> = {
  key: "@marshal/marshal:memory",
  token: memory,
  contract: {
    name: "@marshal/marshal:memory",
    version: "1.0.0",
    declaration: MARSHAL_APP_SERVICE_DECLARATIONS.memory,
    methods: [
      {
        name: "store",
        input: "MarshalRuntimeMemoryStoreInput",
        output: "MarshalRuntimeMemoryStoreResult",
        description: "Store a memory attributed to the current session.",
        examples: ['await AppServices.getMemory().store({ fact, category: "fact" });'],
      },
      {
        name: "recall",
        input: "MarshalRuntimeMemoryRecallInput",
        output: "MarshalRuntimeMemoryRecallResult",
        description: "Search memories attributed to the current session.",
        examples: ["await AppServices.getMemory().recall({ query, limit: 10 });"],
      },
    ],
  },
};
const memoryProviderRegistryComposition: RuntimeCompositionServiceDescriptor<MemoryProviderRegistrationService> =
  {
    key: "@marshal/marshal:memory-provider-registry",
    token: memoryProviderRegistry,
    contract: {
      name: "@marshal/marshal:memory-provider-registry",
      version: "1.0.0",
      declaration: MARSHAL_APP_SERVICE_DECLARATIONS.memoryProviderRegistry,
      methods: [
        {
          name: "register",
          input: "MemoryStoreProvider",
          output: "Promise<{ dispose(): Promise<void> }>",
          description: "Register and atomically activate an extension-owned memory provider.",
        },
      ],
    },
  };
const browserExecutionComposition: RuntimeCompositionServiceDescriptor<MarshalBrowserExecutionService> =
  {
    key: "@marshal/marshal:browser.execution",
    token: browserExecution,
    contract: {
      name: "@marshal/marshal:browser.execution",
      version: "1.0.0",
      declaration: MARSHAL_APP_SERVICE_DECLARATIONS.browserExecution,
      methods: [
        {
          name: "execute",
          input:
            "{ command: string; input: Record<string, unknown>; context: { chatId: string; executionId: string; browserSessionId: string } }",
          output:
            "{ success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown }; metadata?: unknown }",
          description: "Execute a browser command in the current authorized browser session.",
        },
      ],
    },
  };
const uiDeliveryComposition: RuntimeCompositionServiceDescriptor<MarshalUiDeliveryService> = {
  key: "@marshal/marshal:ui.delivery",
  token: uiDelivery,
  contract: {
    name: "@marshal/marshal:ui.delivery",
    version: "1.0.0",
    declaration: MARSHAL_APP_SERVICE_DECLARATIONS.uiDelivery,
    methods: [
      {
        name: "notification",
        input: "{ deliveryId: string; owner: unknown; title: string; message: string }",
        output: "void",
        description: "Deliver a notification through the current Marshal UI.",
      },
      {
        name: "chatMessage",
        input: "{ deliveryId: string; owner: unknown; content: unknown }",
        output: "void",
        description: "Deliver a chat message through the current Marshal UI.",
      },
      {
        name: "chatCard",
        input: "{ deliveryId: string; owner: unknown; content: unknown }",
        output: "void",
        description: "Deliver a structured chat card through the current Marshal UI.",
      },
    ],
  },
};
const uiReviewComposition: RuntimeCompositionServiceDescriptor<MarshalUiReviewService> = {
  key: "@marshal/marshal:ui.review",
  token: uiReview,
  contract: {
    name: "@marshal/marshal:ui.review",
    version: "1.0.0",
    declaration: MARSHAL_APP_SERVICE_DECLARATIONS.uiReview,
    methods: [
      {
        name: "launch",
        input: "{ sessionId: string; sessionTitle?: string }",
        output: "void",
        description: "Launch the existing Marshal review workflow for a session.",
      },
    ],
  },
};
export const MarshalRuntimeCompositionServices = Object.freeze({
  authority: authorityComposition,
  catalog: catalogComposition,
  agents: agentsComposition,
  brain: brainComposition,
  memory: memoryComposition,
  memoryProviderRegistry: memoryProviderRegistryComposition,
  browserExecution: browserExecutionComposition,
  uiDelivery: uiDeliveryComposition,
  uiReview: uiReviewComposition,
});
