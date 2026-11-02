/**
 * Mock runtime client + session for E2E testing through the Copilot adapter.
 *
 * Implements the host-owned runtime client contract that SessionManager
 * actually calls. When injected via the client-factory seam, session creation runs
 * its FULL real code path — wiring onPermissionRequest, onPreToolUse, onPostToolUse
 * hooks — but send() drives scripted scenarios instead of a real LLM.
 *
 * This means the real PermissionPolicy → PermissionCardManager pipeline is exercised
 * end-to-end in E2E tests.
 */
import { randomUUID } from "crypto";

import type { PermissionKind, ReasoningEffort } from "../../../common/marshal-ipc-contract";
import type { MockStep } from "../../../common/marshal-mock-scenarios";
import type {
  RuntimeAssistantMessageEvent,
  RuntimeSessionEvent,
} from "../../../common/runtime-events";
import { pickScenario } from "../../mock-session";
import type {
  RuntimeClientFactory,
  RuntimePermissionResult,
  RuntimeSendOptions,
  RuntimeSessionConfig,
  RuntimeToolResultObject,
} from "../runtime-contract";
import type {
  CopilotClientSubset,
  CopilotSessionSubset,
  PreToolUseHookInput,
  PostToolUseHookInput,
} from "./provider";

// ---------------------------------------------------------------------------
// Classifier mock — maps a command substring to a canned classification JSON
// string matching the CommandClassification shape. Kept dumb and local: no
// LLM, no heuristics — just enough to drive the E2E assertions.
// ---------------------------------------------------------------------------

/** Commands whose text contains this marker cause the classifier to delay
 *  2s, so E2E tests can assert the permission card renders before the
 *  classifier finishes (card-decoupling invariant). Using a package-name
 *  marker (rather than a prefix) keeps the command's first token real so
 *  guardrails don't reject the LLM's broader suggestion on first-token
 *  mismatch. */
const SLOW_CLASSIFY_MARKER = "slow-classify-pkg";
const SYSTEM_INSTRUCTION_PREFIX_PATTERN =
  /^\s*<system_instruction>[\s\S]*?<\/system_instruction>\s*/;

function promptForScenarioSelection(prompt: string): string {
  return prompt.replace(SYSTEM_INSTRUCTION_PREFIX_PATTERN, "");
}

function mockClassificationFor(command: string): string {
  if (command.startsWith("npm install")) {
    return JSON.stringify({
      explanation: "Installs an npm dependency.",
      category: "writes",
      suggestedPattern: "npm install *",
      patternRationale: "Install commands vary by package name; path-independent.",
    });
  }
  // Default: classifier couldn't decide — return an unknown-category fallback.
  return JSON.stringify({
    explanation: "Runs a shell command.",
    category: "unknown",
    suggestedPattern: null,
    patternRationale: null,
  });
}

// ---------------------------------------------------------------------------
// MockCopilotSession
// ---------------------------------------------------------------------------

type SessionConfigLike = RuntimeSessionConfig & Record<string, unknown>;

export class MockCopilotSession implements CopilotSessionSubset {
  readonly sessionId: string;
  readonly workspacePath?: string;
  readonly rpc: NonNullable<CopilotSessionSubset["rpc"]> = {
    history: {
      compact: async () => {
        this.emit({
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          parentId: null,
          type: "session.compaction_complete",
          data: {},
        });
        return {};
      },
    },
    mcp: {
      list: async () => ({ servers: [] }),
      enable: async () => {},
      disable: async () => {},
      reload: async () => {},
      oauth: {
        login: async (): Promise<{ authorizationUrl?: string }> => ({}),
      },
    },
    permissions: {
      handlePendingPermissionRequest: async () => ({ success: true }),
      setApproveAll: async () => ({ success: true }),
      resetSessionApprovals: async () => ({ success: true }),
    },
    plugins: { list: async () => ({ plugins: [] }) },
    auth: {
      getStatus: async () => ({
        isAuthenticated: true,
        authType: "user" as const,
        host: "github.com",
        login: "mock-user",
        statusMessage: "Authenticated as mock-user",
        copilotPlan: "enterprise" as const,
      }),
    },
  };

  private eventHandlers: Array<(event: RuntimeSessionEvent) => void> = [];
  protected config: SessionConfigLike;
  private abortDelayMs = 0;
  private abortShouldFail = false;
  private playbackGeneration = 0;

  constructor(config: SessionConfigLike) {
    this.sessionId = `mock-sdk-${randomUUID()}`;
    this.config = config;
  }

  // --- Event registration (called by createSDKSession:2073) ---

  on(handler: (event: RuntimeSessionEvent) => void): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const index = this.eventHandlers.indexOf(handler);
      if (index >= 0) this.eventHandlers.splice(index, 1);
    };
  }

  // --- Core: send a message → play scripted scenario ---

  async send(options: RuntimeSendOptions): Promise<string> {
    const prompt = promptForScenarioSelection(options.prompt);
    this.abortDelayMs =
      prompt.includes("cancel-long") || prompt.includes("cancel-activity-only") ? 600 : 0;
    this.abortShouldFail = prompt.includes("cancel-failure");
    const scenario = pickScenario(prompt);
    await this.playScenario(scenario, this.playbackGeneration);
    return `mock-msg-${Date.now()}`;
  }

  // --- sendAndWait — used by CopilotBackend.infer() for one-shot LLM calls ---

  async sendAndWait(
    options: RuntimeSendOptions,
    _timeout?: number,
  ): Promise<RuntimeAssistantMessageEvent | undefined> {
    // Classifier infer calls use a specific prompt prefix; return a shaped
    // classification response so E2E can exercise the pattern-generalisation
    // flow end-to-end. Anything else gets the generic explain string.
    const prompt = options.prompt;
    const isClassify = prompt.startsWith("Classify this command:");
    const commandText = isClassify ? prompt.slice("Classify this command:".length).trim() : "";
    // Slow-classifier scenario: delay 2s before replying so the permission
    // card must render from the synchronous heuristic alone. The secondary
    // "Allow broader pattern" should then appear once the delay is up.
    if (isClassify && commandText.includes(SLOW_CLASSIFY_MARKER)) {
      await delay(2000);
    }
    const content = isClassify
      ? mockClassificationFor(commandText)
      : "This command will perform the requested operation.";
    return {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      parentId: null,
      type: "assistant.message",
      data: { content, messageId: `mock-explain-${Date.now()}` },
    };
  }

  // --- Lifecycle no-ops ---

  async destroy(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async abort(): Promise<void> {
    await delay(this.abortDelayMs);
    if (this.abortShouldFail) {
      throw Object.assign(new Error("Mock backend rejected cancellation."), {
        code: "operation_failed",
      });
    }
    this.playbackGeneration++;
  }
  async setModel(_model: string, _options?: { reasoningEffort?: ReasoningEffort }): Promise<void> {}
  registerTools(): void {}
  registerPermissionHandler(): void {}
  registerHooks(): void {}
  registerTransformCallbacks(): void {}
  async getMessages(): Promise<RuntimeSessionEvent[]> {
    return [];
  }
  async log(): Promise<void> {}

  // --- Internal: scenario playback ---

  protected emit(event: RuntimeSessionEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  /* eslint-disable no-await-in-loop -- scenario steps are inherently sequential: delays, permission blocking, and hook invocations must execute in order */
  private async playScenario(steps: MockStep[], generation: number): Promise<void> {
    let skipUntilNextNonTool = false;
    // Track emitted delta text so the final assistant.message reflects reality
    const emittedDeltas: string[] = [];
    let anyDenied = false;

    for (const step of steps) {
      await delay(step.delay);
      // A successful abort must stop old scripted events reaching a resumed session.
      if (generation !== this.playbackGeneration) return;

      if (step.type === "permission-request") {
        const result = await this.triggerPermissionRequest(step.permissionRequest);
        if (!result.kind.startsWith("approve-")) {
          skipUntilNextNonTool = true;
          anyDenied = true;
        }
        continue;
      }

      if (step.type === "pre-tool-use") {
        if (skipUntilNextNonTool) continue;
        const result = await this.triggerPreToolUse(step.toolCall);
        if (isPreHookDeny(result)) {
          skipUntilNextNonTool = true;
          anyDenied = true;
        }
        continue;
      }

      if (step.type === "post-tool-use") {
        if (skipUntilNextNonTool) continue;
        await this.triggerPostToolUse(step.toolCall);
        continue;
      }

      // Regular event step (MockEventStep)
      if (skipUntilNextNonTool) {
        const eventType = step.event.type;
        if (eventType.startsWith("tool.")) continue;
        // First non-tool event after denial: replace message_delta with denial text
        skipUntilNextNonTool = false;
        if (eventType === "assistant.message_delta") {
          const denialDelta = "I wasn't able to complete that operation.\n\n";
          emittedDeltas.push(denialDelta);
          this.emit({
            ...step.event,
            data: { ...step.event.data, deltaContent: denialDelta },
          } as RuntimeSessionEvent);
          continue;
        }
      }

      // Track emitted deltas for final message reconstruction
      if (step.event.type === "assistant.message_delta") {
        const delta = step.event.data.deltaContent;
        if (typeof delta === "string") emittedDeltas.push(delta);
      }

      // Replace final assistant.message content with actually-emitted text
      if (anyDenied && step.event.type === "assistant.message") {
        this.emit({
          ...step.event,
          data: { ...step.event.data, content: emittedDeltas.join("") },
        } as RuntimeSessionEvent);
        continue;
      }

      this.emit(step.event);
    }
  }
  /* eslint-enable no-await-in-loop */

  private async triggerPermissionRequest(req: {
    kind: PermissionKind;
    toolCallId?: string;
    [key: string]: unknown;
  }): Promise<RuntimePermissionResult> {
    const handler = this.config.onPermissionRequest;
    if (handler) {
      return handler(req, { sessionId: this.sessionId });
    }
    return { kind: "approve-once" as const };
  }

  private async triggerPreToolUse(toolCall: {
    toolCallId: string;
    toolName: string;
    toolArgs?: unknown;
    serverName?: string;
  }): Promise<unknown> {
    const hook = this.config.hooks?.onPreToolUse;
    if (hook) {
      const input: PreToolUseHookInput = {
        toolName: toolCall.toolName,
        toolArgs: toolCall.toolArgs ?? {},
        timestamp: Date.now(),
        cwd: process.cwd(),
        toolCallId: toolCall.toolCallId,
        serverName: toolCall.serverName ?? "",
      };
      return hook(input, { sessionId: this.sessionId });
    }
    return {};
  }

  private async triggerPostToolUse(toolCall: {
    toolCallId: string;
    toolName: string;
    toolResult?: unknown;
    serverName?: string;
  }): Promise<void> {
    const hook = this.config.hooks?.onPostToolUse;
    if (hook) {
      const toolResult: RuntimeToolResultObject =
        toolCall.toolResult != null
          ? // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- mock scenarios provide the declared tool-result shape
            (toolCall.toolResult as RuntimeToolResultObject)
          : MOCK_TOOL_RESULT;
      const input: PostToolUseHookInput = {
        toolName: toolCall.toolName,
        toolArgs: {},
        toolResult,
        timestamp: Date.now(),
        cwd: process.cwd(),
        toolCallId: toolCall.toolCallId,
        serverName: toolCall.serverName ?? "",
      };
      await hook(input, { sessionId: this.sessionId });
    }
  }
}

// ---------------------------------------------------------------------------
// MockCopilotClient
// ---------------------------------------------------------------------------

export class MockCopilotClient implements CopilotClientSubset {
  async start(): Promise<void> {}
  async stop(): Promise<Error[]> {
    return [];
  }
  async forceStop(): Promise<void> {}

  async createSession(config: SessionConfigLike): Promise<CopilotSessionSubset> {
    return new MockCopilotSession(config);
  }

  async resumeSession(_id: string, config: SessionConfigLike): Promise<CopilotSessionSubset> {
    return new MockCopilotSession(config);
  }

  async deleteSession(_id: string): Promise<void> {}

  getState(): string {
    return "connected";
  }

  async ping(): Promise<{ message: string; timestamp: number }> {
    return { message: "pong", timestamp: Date.now() };
  }

  async getStatus() {
    return { status: "ok", version: "mock", protocolVersion: 1 };
  }

  async getAuthStatus(): Promise<{
    isAuthenticated: boolean;
    login?: string;
    statusMessage?: string;
  }> {
    return { isAuthenticated: true, login: "e2e-user", statusMessage: "Authenticated" };
  }

  async listModels(): ReturnType<CopilotClientSubset["listModels"]> {
    const caps = {
      supports: {
        vision: false,
        reasoningEffort: true,
      },
      limits: { max_context_window_tokens: 128000 },
    };
    return [
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        capabilities: {
          supports: {
            vision: true,
            reasoningEffort: true,
          },
          limits: { max_context_window_tokens: 1_050_000 },
        },
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        defaultReasoningEffort: "medium",
        billing: {
          tokenPrices: {
            contextMax: 272_000,
            longContext: { contextMax: 922_000 },
          },
        },
      },
      {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        capabilities: caps,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
        billing: { multiplier: 3 },
      },
      {
        id: "claude-opus-4.7",
        name: "Claude Opus 4.7",
        capabilities: caps,
        billing: { multiplier: 3 },
      },
      { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", capabilities: caps },
      { id: "gpt-5.5", name: "GPT-5.5", capabilities: caps },
      { id: "gpt-5.4", name: "GPT-5.4", capabilities: caps },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", capabilities: caps },
      { id: "gpt-4o", name: "GPT-4o", capabilities: caps },
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", capabilities: caps },
    ];
  }

  async getLastSessionId(): Promise<string | undefined> {
    return undefined;
  }

  async listSessions() {
    return [];
  }

  async getForegroundSessionId(): Promise<string | undefined> {
    return undefined;
  }

  async setForegroundSessionId(): Promise<void> {}

  on(): () => void {
    return () => {};
  }
}

// ---------------------------------------------------------------------------
// Factory export — used by main.ts to inject into SessionManager
// ---------------------------------------------------------------------------

export function createMockClientFactory(): RuntimeClientFactory {
  return async () => new MockCopilotClient();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_TOOL_RESULT: RuntimeToolResultObject = {
  textResultForLlm: "(mock result)",
  resultType: "success",
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPreHookDeny(result: unknown): result is { permissionDecision: "deny" } {
  return (
    typeof result === "object" &&
    result !== null &&
    "permissionDecision" in result &&
    (result as Record<string, unknown>).permissionDecision === "deny"
  );
}
