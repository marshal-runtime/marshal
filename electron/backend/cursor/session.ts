import { randomUUID } from "node:crypto";

import type { ConversationStep, ModelSelection, Run, SDKAgent, SendOptions } from "@cursor/sdk";

import type { ReasoningEffort } from "../../../common/marshal-ipc-contract";
import type {
  RuntimeContextMessage,
  RuntimeConversationState,
} from "../../../common/runtime-conversation-state";
import type {
  RuntimeAssistantMessageEvent,
  RuntimeSessionEvent,
} from "../../../common/runtime-events";
import { cleanContextUserText, validateConversationState } from "../conversation-state";
import type {
  RuntimeClientSession,
  RuntimeSendOptions,
  RuntimeSessionConfig,
  RuntimeSessionRpc,
} from "../runtime-contract";
import { buildCursorUserMessage } from "./attachments";
import { CursorEventTranslator } from "./events";

type CursorModelSelectionResolver = (
  modelId: string,
  reasoningEffort?: ReasoningEffort,
) => ModelSelection;

interface CursorTurn {
  requests: RuntimeContextMessage[];
  cancelled: boolean;
  ready: Promise<Run | undefined>;
  completion: Promise<void>;
}

export class CursorRuntimeSession implements RuntimeClientSession {
  readonly sessionId: string;
  readonly rpc: RuntimeSessionRpc = {
    history: {
      compact: () => this.compact(),
    },
  };
  private readonly handlers = new Set<(event: RuntimeSessionEvent) => void>();
  private readonly emittedEvents: RuntimeSessionEvent[] = [];
  private readonly translator = new CursorEventTranslator();
  private closed = false;
  private activeRun: Awaited<ReturnType<SDKAgent["send"]>> | undefined;
  private activeTurn: CursorTurn | undefined;
  private conversationState: RuntimeConversationState;
  private contextUnavailable?: Error;
  private historyLoaded: boolean;
  private modelId: string;
  private reasoningEffort: ReasoningEffort | undefined;
  private modelSelection: ModelSelection;
  private shouldInjectSystemMessage = true;

  constructor(
    private readonly agent: SDKAgent,
    private readonly config: RuntimeSessionConfig,
    private readonly resolveModelSelection: CursorModelSelectionResolver = (modelId) => ({
      id: modelId,
    }),
    private readonly loadConversationState?: () => Promise<RuntimeConversationState>,
    private readonly onClosed?: () => void,
  ) {
    this.conversationState = structuredClone(
      config.conversationState ?? { version: 1, sourceRuntimeId: "cursor", messages: [] },
    );
    this.conversationState.sourceRuntimeId = "cursor";
    this.historyLoaded = !!config.conversationState || !loadConversationState;
    this.sessionId = agent.agentId;
    this.modelId = config.model ?? agent.model?.id ?? "";
    this.reasoningEffort = config.reasoningEffort;
    this.modelSelection = this.resolveModelSelection(this.modelId, this.reasoningEffort);
  }

  on(handler: (event: RuntimeSessionEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async send(options: RuntimeSendOptions): Promise<string> {
    this.assertOpen();
    const current = this.activeTurn;
    if (current && !current.cancelled) {
      if (options.attachments?.length) {
        throw new Error("Cursor cannot steer attachments into a running turn");
      }
      const run = await current.ready;
      if (run?.status === "running") {
        const outcome = await run.steer?.(options.prompt);
        if (outcome === "complete_delivered") {
          const request: RuntimeContextMessage = {
            role: "user",
            content: cleanContextUserText(options.prompt),
          };
          current.requests.push(request);
          this.conversationState.messages.push(request);
          return run.id;
        }
        // The SDK did not take ownership. Deliver once as a follow-up.
        await current.completion;
      } else {
        await current.completion;
      }
    }
    const turn = this.startTurn(options);
    const run = await turn.ready;
    if (!run || turn.cancelled) throw new Error("Cursor turn cancelled during startup");
    return run.id;
  }

  async sendAndWait(
    options: RuntimeSendOptions,
    timeout?: number,
  ): Promise<RuntimeAssistantMessageEvent | undefined> {
    const turn = this.startTurn(options).completion;
    if (timeout !== undefined && timeout > 0) {
      const timedOut = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Cursor turn timed out after ${timeout}ms`)), timeout);
      });
      await Promise.race([turn, timedOut]);
    } else {
      await turn;
    }
    return this.emittedEvents.reduce<RuntimeAssistantMessageEvent | undefined>(
      (found, runtimeEvent) => (runtimeEvent.type === "assistant.message" ? runtimeEvent : found),
      undefined,
    );
  }

  async destroy(): Promise<void> {
    await this.close();
  }

  async disconnect(): Promise<void> {
    await this.close();
  }

  async abort(): Promise<void> {
    this.assertOpen();
    const turn = this.activeTurn;
    if (turn) {
      turn.cancelled = true;
      const run = await turn.ready;
      if (run) await run.cancel();
      await turn.completion;
    } else if (this.activeRun) {
      await this.activeRun.cancel();
    }
    this.emit({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      parentId: null,
      type: "abort",
      data: {},
    });
    await this.config.hooks?.onSessionEnd?.({ reason: "abort" }, { sessionId: this.sessionId });
  }

  async setModel(model: string, options?: { reasoningEffort?: ReasoningEffort }): Promise<void> {
    this.assertOpen();
    this.modelId = model;
    if (options && "reasoningEffort" in options) {
      this.reasoningEffort = options.reasoningEffort;
    }
    this.modelSelection = this.resolveModelSelection(this.modelId, this.reasoningEffort);
    this.emit({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      parentId: null,
      type: "session.model_change",
      data: { newModel: model },
    });
  }

  async getMessages(): Promise<RuntimeSessionEvent[]> {
    return [...this.emittedEvents];
  }

  async exportConversationState(options?: {
    allowCompaction?: boolean;
  }): Promise<RuntimeConversationState> {
    this.assertOpen();
    if (options?.allowCompaction && (this.activeTurn || this.activeRun))
      throw new Error(
        "Wait for the current Cursor response to finish before transferring this chat",
      );
    await this.ensureConversationState();
    if (this.contextUnavailable && options?.allowCompaction) await this.compact();
    if (this.contextUnavailable) throw this.contextUnavailable;
    return validateConversationState(structuredClone(this.conversationState));
  }

  private async ensureConversationState(): Promise<void> {
    if (!this.historyLoaded && this.loadConversationState) {
      try {
        this.conversationState = await this.loadConversationState();
      } catch (error) {
        this.contextUnavailable = error instanceof Error ? error : new Error(String(error));
      }
      this.historyLoaded = true;
    }
  }

  private captureStep(step: ConversationStep): void {
    if (step.type === "assistantMessage") {
      this.conversationState.messages.push({ role: "assistant", content: step.message.text });
    } else if (step.type === "toolCall") {
      this.conversationState.messages.push({ role: "tool", content: JSON.stringify(step.message) });
    }
  }

  private emitContextCheckpoint(): void {
    if (this.contextUnavailable || !this.historyLoaded) return;
    this.emit({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      parentId: null,
      type: "session.context_checkpoint",
      data: { state: validateConversationState(this.conversationState) },
    });
  }

  private startTurn(options: RuntimeSendOptions): CursorTurn {
    this.assertOpen();
    if (this.activeTurn) throw new Error("Cursor already has an active turn");
    let resolveReady!: (run: Run | undefined) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<Run | undefined>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // sendAndWait observes completion rather than the startup acknowledgement.
    void ready.catch(() => undefined);
    const turn: CursorTurn = {
      requests: [],
      cancelled: false,
      ready,
      completion: Promise.resolve(),
    };
    this.activeTurn = turn;
    turn.completion = this.runTurn(options, turn, resolveReady)
      .catch(async (error: unknown) => {
        rejectReady(error);
        if (this.activeRun?.status === "running") {
          try {
            await this.activeRun.cancel();
          } catch (cancelError) {
            throw new Error(
              `Cursor run failed (${String(error)}) and could not be cancelled`,
              { cause: cancelError },
            );
          }
        }
        throw error;
      })
      .finally(() => {
        resolveReady(undefined);
        if (this.activeTurn === turn) {
          this.activeTurn = undefined;
          this.activeRun = undefined;
        }
      });
    // send() acknowledges startup; completion is reported through session events.
    void turn.completion.catch((error: unknown) => {
      if (turn.cancelled) return;
      this.emit({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        parentId: null,
        type: "session.error",
        data: { message: error instanceof Error ? error.message : String(error) },
      });
    });
    return turn;
  }

  private async runTurn(
    options: RuntimeSendOptions,
    turn: CursorTurn,
    resolveReady: (run: Run | undefined) => void,
  ): Promise<void> {
    this.assertOpen();
    await this.ensureConversationState();
    await this.config.hooks?.onUserPromptSubmitted?.(
      { prompt: options.prompt },
      { sessionId: this.sessionId },
    );
    const chunks: string[] = [];
    const systemMessage = this.shouldInjectSystemMessage
      ? this.config.systemMessage?.content
      : null;
    const prompt = systemMessage
      ? `<marshal-instructions>\n${systemMessage}\n</marshal-instructions>\n\n<user-request>\n${options.prompt}\n</user-request>`
      : options.prompt;
    const userMessage = await buildCursorUserMessage(
      prompt,
      options.attachments,
      this.config.cwd ?? this.config.workingDirectory ?? process.cwd(),
    );
    if (turn.cancelled) return;
    const currentRequest: RuntimeContextMessage = {
      role: "user",
      content:
        cleanContextUserText(options.prompt) +
        (options.attachments?.length
          ? `\n\nOriginal attachment references: ${JSON.stringify(options.attachments)}`
          : ""),
    };
    const messageCount = this.conversationState.messages.length;
    turn.requests.push(currentRequest);
    this.conversationState.messages.push(currentRequest);
    let receivedUpdate = false;
    const run = await this.sendToAgent(userMessage, {
      ...(this.modelSelection.id ? { model: this.modelSelection } : {}),
      onDelta: ({ update }) => {
        receivedUpdate = true;
        if (update.type === "summary") {
          this.contextUnavailable = undefined;
          this.historyLoaded = true;
          this.conversationState.summary = update.summary;
          // Compaction may precede dispatch of this turn's request.
          this.conversationState.messages = [...turn.requests];
          this.emitContextCheckpoint();
        }
        if (!turn.cancelled) this.emitTranslated(this.translator.translateDelta(update), chunks);
      },
      onStep: ({ step }) => {
        receivedUpdate = true;
        this.captureStep(step);
      },
    }).catch((error: unknown) => {
      if (!receivedUpdate) this.conversationState.messages.splice(messageCount);
      throw error;
    });
    this.shouldInjectSystemMessage = false;
    this.activeRun = run;
    resolveReady(run);
    if (turn.cancelled) return;
    for await (const message of run.stream()) {
      if (turn.cancelled) break;
      this.emitTranslated(this.translator.translate(message, this.modelId), chunks);
    }
    const result = await run.wait();
    this.emitContextCheckpoint();
    if (turn.cancelled || result.status === "cancelled") return;
    if (result.status === "error") {
      const message = result.error?.message ?? "Cursor run failed";
      throw new Error(message);
    }
    if (chunks.length > 0) {
      this.emit({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        parentId: null,
        type: "assistant.message",
        data: { content: chunks.join("") },
      });
    }
    this.emit({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      parentId: null,
      type: "session.idle",
      data: {},
    });
  }

  private async sendToAgent(
    prompt: Parameters<SDKAgent["send"]>[0],
    options: SendOptions,
  ): Promise<Run> {
    try {
      return await this.agent.send(prompt, options);
    } catch (error) {
      // Cursor can leave a queued run in its store after a CLI crash or failed send.
      // Its documented force-send recovery expires that run before creating a follow-up.
      if (
        !this.loadConversationState ||
        !(error instanceof Error) ||
        !error.message.includes("already has active run")
      )
        throw error;
      return this.agent.send(prompt, { ...options, local: { ...options.local, force: true } });
    }
  }

  private async compact(): Promise<void> {
    this.assertOpen();
    await this.ensureConversationState();
    if (this.activeTurn || this.activeRun)
      throw new Error("Wait for the current Cursor response to finish before compacting this chat");
    let capturedSummary: string | undefined;
    const run = await this.sendToAgent("/summarize", {
      ...(this.modelSelection.id ? { model: this.modelSelection } : {}),
      onDelta: ({ update }) => {
        if (update.type === "summary") {
          capturedSummary = update.summary;
        }
      },
    });
    this.activeRun = run;
    try {
      for await (const _message of run.stream()) {
        // Cursor handles the slash command internally; its output is not a chat turn.
      }
      const result = await run.wait();
      if (result.status !== "finished")
        throw new Error(result.error?.message ?? "Cursor session compaction failed");
      if (!capturedSummary?.trim())
        throw new Error(
          "Cursor did not expose a readable compaction checkpoint. The chat cannot be transferred yet.",
        );
      this.contextUnavailable = undefined;
      this.historyLoaded = true;
      this.conversationState.summary = capturedSummary;
      this.conversationState.messages = [];
      this.emitContextCheckpoint();
    } finally {
      try {
        if (run.status === "running") await run.cancel();
      } finally {
        if (this.activeRun === run) this.activeRun = undefined;
      }
    }
  }

  private emitTranslated(events: RuntimeSessionEvent[], chunks: string[]): void {
    events.forEach((runtimeEvent) => {
      if (runtimeEvent.type === "assistant.message_delta") {
        chunks.push(runtimeEvent.data.deltaContent);
      }
      this.emit(runtimeEvent);
    });
  }

  private emit(runtimeEvent: RuntimeSessionEvent): void {
    this.emittedEvents.push(runtimeEvent);
    this.handlers.forEach((handler) => handler(runtimeEvent));
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`Cursor session ${this.sessionId} is closed`);
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      const turn = this.activeTurn;
      if (turn) turn.cancelled = true;
      try {
        const run = turn ? await turn.ready : this.activeRun;
        if (run?.status === "running") await run.cancel();
        await turn?.completion;
      } finally {
        await this.agent[Symbol.asyncDispose]();
      }
    } finally {
      this.handlers.clear();
      this.onClosed?.();
    }
  }
}
