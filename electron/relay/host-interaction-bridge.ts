import type { PermissionAction } from "../../common/marshal-constants";
import type { MessageQuestion } from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import type {
  RelayAddress,
  RelayInteractionOption,
  RelayInteractionPrompt,
  RelayInteractionTerminalOutcome,
} from "../../common/relay-contract";
import { OPEN_IN_APP_BUTTON } from "../permission-external-redaction";
import type { SessionManager } from "../sessions";
import type { RelayExperienceCoordinator } from "./experience-coordinator";

const log = createLogger("RelayHostInteractionBridge");
const INTERACTION_TTL_MS = 48 * 60 * 60 * 1000;

export interface RelayPermissionPromptInput {
  readonly requestId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly string[];
  readonly resolve: (action: PermissionAction) => void;
}

export class RelayHostInteractionBridge {
  constructor(
    private readonly coordinator: RelayExperienceCoordinator,
    private readonly sessions: SessionManager,
  ) {}

  start(): void {
    this.sessions.setRelayUserMessageCallback((sessionId) => {
      this.coordinator.interactions.cancelPendingChoicesForSession(
        sessionId,
        "superseded-by-user-message",
      );
    });
    this.sessions.setRelayQuestionCallback((sessionId, question, requestId) => {
      this.presentChoice(sessionId, question, requestId);
    });
  }

  stop(): void {
    this.sessions.setRelayUserMessageCallback(null);
    this.sessions.setRelayQuestionCallback(null);
  }

  presentPermission(input: RelayPermissionPromptInput): void {
    const address = this.resolveTarget(input.sessionId);
    if (!address) return;
    const options = permissionOptions(input.buttons);
    if (options.length < 2) return;
    const prompt = createPrompt({
      interactionId: `permission:${input.requestId}`,
      idempotencyKey: `permission:${input.requestId}`,
      address,
      sessionId: input.sessionId,
      requestId: input.requestId,
      correlationId: `permission:${input.requestId}`,
      kind: "permission",
      title: input.title,
      question: input.message,
      ...(input.detail ? { body: input.detail } : {}),
      options,
      minSelections: 1,
      maxSelections: 1,
    });
    void this.coordinator.interactions
      .present(prompt)
      .then((outcome) => {
        if (outcome.state !== "resolved") return;
        const selected = outcome.selection.selectedOptionIds[0];
        // Only an option this prompt offered may resolve the card: forget
        // completely offers no Allow, so a relay can never approve it.
        const offered = options.some((option) => option.optionId === selected);
        const action = selected && offered ? permissionActionForOption(selected) : undefined;
        if (action) input.resolve(action);
      })
      .catch((error: unknown) => {
        log
          .with({ sessionId: input.sessionId, requestId: input.requestId })
          .warn("Relay permission presentation failed:", error);
      });
  }

  permissionResolved(requestId: string): void {
    this.coordinator.interactions.cancelBySourceRequestId(requestId, "resolved-by-another-surface");
  }

  presentChoice(sessionId: string, question: MessageQuestion, requestId: string): void {
    if (question.selectedAnswer) return;
    const address = this.resolveTarget(sessionId);
    if (!address) return;
    const interactionId = `choice:${sessionId}:${requestId}`;
    const options = question.answers.map((answer, index) => ({
      optionId: `option-${index + 1}`,
      label: answer.title,
      ...(answer.description ? { description: answer.description } : {}),
    }));
    const prompt = createPrompt({
      interactionId,
      idempotencyKey: interactionId,
      address,
      sessionId,
      turnId: requestId,
      requestId,
      correlationId: interactionId,
      kind: "choice",
      title: "Choose an option",
      question: question.question,
      options,
      minSelections: 1,
      maxSelections: 1,
    });
    void this.coordinator.interactions
      .present(prompt)
      .then((outcome) => this.deliverChoice(sessionId, question, prompt, outcome))
      .catch((error: unknown) => {
        log.with({ sessionId }).warn("Relay choice presentation failed:", error);
      });
  }

  private async deliverChoice(
    sessionId: string,
    question: MessageQuestion,
    prompt: RelayInteractionPrompt,
    outcome: RelayInteractionTerminalOutcome,
  ): Promise<void> {
    if (outcome.state !== "resolved") return;
    const selected = outcome.selection.selectedOptionIds.flatMap((optionId) => {
      const index = prompt.options.findIndex((option) => option.optionId === optionId);
      const answer = question.answers[index];
      return answer ? [`${String.fromCharCode(65 + index)}. ${answer.title}`] : [];
    });
    if (selected.length === 0) return;
    try {
      const result = await this.sessions.sendRelayMessageToSession({
        sessionId,
        source: {
          providerId: prompt.address.providerId,
          accountId: prompt.address.accountId,
          conversationId: prompt.address.conversationId,
          providerMessageId: outcome.selection.providerPromptMessageId,
        },
        message: [
          '<marshal-relay-turn kind="choice-selection">',
          "The authorized relay owner selected this answer for the pending choice:",
          selected.join("\n"),
          "Continue the existing session with that selection.",
          "Use publishRelayMessage for any deliberate reply; do not rely on transcript mirroring.",
          "</marshal-relay-turn>",
        ].join("\n"),
        idempotencyKey: `relay-interaction:${prompt.interactionId}`,
        deliveryMode: "interrupt",
        sourceLabel: "Relay choice response",
      });
      if (!result.accepted) {
        throw new Error(result.error ?? "Relay choice response was not accepted");
      }
    } catch (error) {
      log.with({ sessionId }).warn("Relay choice delivery failed:", error);
    }
  }

  private resolveTarget(sessionId: string): RelayAddress | undefined {
    const activeTurnOrigin = this.sessions.getActiveRelayPublicationOrigin(sessionId);
    if (activeTurnOrigin) return activeTurnOrigin;
    const origin = this.coordinator.getSessionOrigin(sessionId);
    if (origin) return origin;
    const accessPoints = this.coordinator.listSessionAccessPoints(sessionId);
    return accessPoints.length === 1 ? accessPoints[0] : undefined;
  }
}

function createPrompt(input: {
  readonly interactionId: string;
  readonly idempotencyKey: string;
  readonly address: RelayAddress;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly requestId?: string;
  readonly correlationId: string;
  readonly kind: RelayInteractionPrompt["kind"];
  readonly title: string;
  readonly question: string;
  readonly body?: string;
  readonly options: readonly RelayInteractionOption[];
  readonly minSelections: number;
  readonly maxSelections: number;
}): RelayInteractionPrompt {
  const createdAtMs = Date.now();
  return {
    interactionId: input.interactionId,
    idempotencyKey: input.idempotencyKey,
    address: input.address,
    source: {
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
    },
    kind: input.kind,
    title: input.title.trim().slice(0, 256),
    question: input.question.trim().slice(0, 1_024),
    ...(input.body?.trim() ? { body: input.body.trim().slice(0, 1_024) } : {}),
    options: input.options.map((option) => ({
      optionId: option.optionId,
      label: option.label.trim().slice(0, 256),
      ...(option.description?.trim()
        ? { description: option.description.trim().slice(0, 1_024) }
        : {}),
    })),
    minSelections: input.minSelections,
    maxSelections: input.maxSelections,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(createdAtMs + INTERACTION_TTL_MS).toISOString(),
  };
}

function permissionOptions(buttons: readonly string[]): RelayInteractionOption[] {
  return buttons.flatMap((label) => {
    const optionId = permissionOptionForLabel(label);
    return optionId ? [{ optionId, label }] : [];
  });
}

function permissionOptionForLabel(label: string): string | undefined {
  switch (label) {
    case "Allow":
    case "Accept and continue":
      return "allow";
    case "Allow for session":
      return "allow-session";
    case "Always allow":
      return "always-allow";
    case "Deny":
    case "Cancel":
      return "deny";
    case OPEN_IN_APP_BUTTON:
      return "open-in-app";
    default:
      return undefined;
  }
}

function permissionActionForOption(optionId: string): PermissionAction | undefined {
  switch (optionId) {
    case "allow":
    case "allow-session":
    case "always-allow":
    case "deny":
      return optionId;
    default:
      return undefined;
  }
}
