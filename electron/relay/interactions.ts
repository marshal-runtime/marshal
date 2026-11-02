import {
  parseRelayMessageId,
  type RelayInteractionPrompt,
  type RelayInteractionSelection,
  type RelayInteractionTerminalOutcome,
  type RelayMessageId,
} from "../../common/relay-contract";
import { createLogger } from "../../common/marshal-logger";
import type { RelayProviderRegistry } from "./registry";
import {
  RelayDatabase,
  type RelayDatabaseRow,
  relayNullableTextColumn,
  relayTextColumn,
  requireRelayRow,
  requireRelayText,
} from "./relay-database";

const log = createLogger("RelayInteractions");

type StoredInteractionState =
  | "pending"
  | "resolved"
  | "cancelled"
  | "expired"
  | "unsupported"
  | "failed";

interface StoredRelayInteraction {
  readonly interactionId: string;
  readonly idempotencyKey: string;
  readonly prompt: RelayInteractionPrompt;
  readonly state: StoredInteractionState;
  readonly providerPromptMessageId?: string;
  readonly outcome?: RelayInteractionTerminalOutcome;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PendingInteraction {
  readonly promise: Promise<RelayInteractionTerminalOutcome>;
  readonly resolve: (outcome: RelayInteractionTerminalOutcome) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

class RelayInteractionSelectionRejectedError extends Error {}

export class RelayInteractionStore {
  constructor(private readonly database: RelayDatabase) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS relay_interactions (
        interaction_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_turn_id TEXT,
        source_request_id TEXT,
        correlation_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('permission', 'choice')),
        prompt_json TEXT NOT NULL,
        provider_prompt_message_id TEXT,
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'resolved', 'cancelled', 'expired', 'unsupported', 'failed')
        ),
        outcome_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS relay_interactions_provider_message_idx
        ON relay_interactions (
          provider,
          account_id,
          conversation_id,
          provider_prompt_message_id
        )
        WHERE provider_prompt_message_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS relay_interactions_source_request_idx
        ON relay_interactions (source_request_id, state);

      CREATE INDEX IF NOT EXISTS relay_interactions_source_session_idx
        ON relay_interactions (source_session_id, kind, state);
    `);
  }

  create(prompt: RelayInteractionPrompt): StoredRelayInteraction {
    const existing = this.getByIdempotencyKey(prompt.idempotencyKey);
    if (existing) {
      if (promptFingerprint(existing.prompt) !== promptFingerprint(prompt)) {
        throw new Error(
          `Relay interaction idempotency key ${prompt.idempotencyKey} was reused with new content`,
        );
      }
      return existing;
    }

    this.database
      .prepare(
        `INSERT INTO relay_interactions (
           interaction_id,
           idempotency_key,
           provider,
           account_id,
           conversation_id,
           source_session_id,
           source_turn_id,
           source_request_id,
           correlation_id,
           kind,
           prompt_json,
           state,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        prompt.interactionId,
        prompt.idempotencyKey,
        prompt.address.providerId,
        prompt.address.accountId,
        prompt.address.conversationId,
        prompt.source.sessionId,
        prompt.source.turnId ?? null,
        prompt.source.requestId ?? null,
        prompt.source.correlationId,
        prompt.kind,
        JSON.stringify(prompt),
        prompt.createdAt,
        prompt.createdAt,
      );
    return this.requireByInteractionId(prompt.interactionId);
  }

  markPublished(
    interactionId: string,
    providerPromptMessageId: RelayMessageId,
    publishedAt: string,
  ): StoredRelayInteraction {
    const current = this.requirePending(interactionId);
    this.database
      .prepare(
        `UPDATE relay_interactions
         SET provider_prompt_message_id = ?, updated_at = ?
         WHERE interaction_id = ? AND state = 'pending'`,
      )
      .run(providerPromptMessageId, publishedAt, current.interactionId);
    return this.requireByInteractionId(interactionId);
  }

  resolve(
    selection: RelayInteractionSelection,
    receivedAtMs: number = Date.now(),
  ): StoredRelayInteraction | undefined {
    const current = this.getByInteractionId(selection.interactionId);
    if (!current || current.state !== "pending") return undefined;
    if (
      typeof selection.responder.primaryId !== "string" ||
      selection.responder.primaryId.trim() !== selection.responder.primaryId ||
      selection.responder.primaryId.length === 0
    ) {
      throw new RelayInteractionSelectionRejectedError(
        "Relay interaction responder is invalid",
      );
    }
    if (!Number.isFinite(Date.parse(selection.selectedAt))) {
      throw new RelayInteractionSelectionRejectedError(
        "Relay interaction selection timestamp is invalid",
      );
    }
    if (
      current.prompt.address.providerId !== selection.address.providerId ||
      current.prompt.address.accountId !== selection.address.accountId ||
      current.prompt.address.conversationId !== selection.address.conversationId ||
      (current.providerPromptMessageId !== undefined &&
        current.providerPromptMessageId !== selection.providerPromptMessageId)
    ) {
      throw new RelayInteractionSelectionRejectedError(
        "Relay interaction selection does not match its pending prompt",
      );
    }
    const selectedAtMs = Date.parse(selection.selectedAt);
    const createdAtMs = Date.parse(current.prompt.createdAt);
    const expiresAtMs = Date.parse(current.prompt.expiresAt);
    if (
      selectedAtMs < createdAtMs ||
      selectedAtMs >= expiresAtMs ||
      receivedAtMs >= expiresAtMs
    ) {
      const completedAt = new Date(receivedAtMs).toISOString();
      return this.completeInternal(
        current.interactionId,
        "expired",
        { state: "expired", completedAt },
        completedAt,
      );
    }
    const allowed = new Set(current.prompt.options.map((option) => option.optionId));
    const selected = [...new Set(selection.selectedOptionIds)];
    if (
      selected.length < current.prompt.minSelections ||
      selected.length > current.prompt.maxSelections ||
      selected.some((optionId) => !allowed.has(optionId))
    ) {
      throw new RelayInteractionSelectionRejectedError(
        "Relay interaction selection violates the prompt constraints",
      );
    }
    if (current.providerPromptMessageId === undefined) {
      this.database
        .prepare(
          `UPDATE relay_interactions
           SET provider_prompt_message_id = ?, updated_at = ?
           WHERE interaction_id = ? AND state = 'pending' AND provider_prompt_message_id IS NULL`,
        )
        .run(selection.providerPromptMessageId, selection.selectedAt, current.interactionId);
    }
    const outcome: RelayInteractionTerminalOutcome = { state: "resolved", selection };
    return this.completeInternal(
      current.interactionId,
      "resolved",
      outcome,
      selection.selectedAt,
    );
  }

  complete(
    interactionId: string,
    state: Exclude<StoredInteractionState, "pending" | "resolved">,
    outcome: RelayInteractionTerminalOutcome,
    completedAt: string,
  ): StoredRelayInteraction | undefined {
    const current = this.getByInteractionId(interactionId);
    if (!current || current.state !== "pending") return undefined;
    return this.completeInternal(interactionId, state, outcome, completedAt);
  }

  getByInteractionId(interactionId: string): StoredRelayInteraction | undefined {
    requireRelayText("interactionId", interactionId);
    const row = this.database
      .prepare("SELECT * FROM relay_interactions WHERE interaction_id = ?")
      .get(interactionId);
    return row === undefined ? undefined : parseInteraction(requireRelayRow(row, "interaction"));
  }

  getByIdempotencyKey(idempotencyKey: string): StoredRelayInteraction | undefined {
    requireRelayText("idempotencyKey", idempotencyKey);
    const row = this.database
      .prepare("SELECT * FROM relay_interactions WHERE idempotency_key = ?")
      .get(idempotencyKey);
    return row === undefined ? undefined : parseInteraction(requireRelayRow(row, "interaction"));
  }

  listPendingBySourceRequestId(sourceRequestId: string): StoredRelayInteraction[] {
    return this.queryPending("source_request_id = ?", sourceRequestId);
  }

  listPendingChoicesBySession(sessionId: string): StoredRelayInteraction[] {
    return this.queryPending("source_session_id = ? AND kind = 'choice'", sessionId);
  }

  listPending(): StoredRelayInteraction[] {
    return this.queryPending("1 = 1");
  }

  hasPendingPermissionAt(address: RelayInteractionPrompt["address"]): boolean {
    const row = this.database
      .prepare(
        `SELECT interaction_id
         FROM relay_interactions
         WHERE
           state = 'pending'
           AND kind = 'permission'
           AND provider = ?
           AND account_id = ?
           AND conversation_id = ?
         LIMIT 1`,
      )
      .get(address.providerId, address.accountId, address.conversationId);
    return row !== undefined;
  }

  private queryPending(where: string, ...args: string[]): StoredRelayInteraction[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM relay_interactions
         WHERE state = 'pending' AND ${where}
         ORDER BY created_at ASC`,
      )
      .all(...args);
    return rows.map((row) => parseInteraction(requireRelayRow(row, "pending interaction")));
  }

  private completeInternal(
    interactionId: string,
    state: Exclude<StoredInteractionState, "pending">,
    outcome: RelayInteractionTerminalOutcome,
    completedAt: string,
  ): StoredRelayInteraction {
    const result = this.database
      .prepare(
        `UPDATE relay_interactions
         SET state = ?, outcome_json = ?, updated_at = ?
         WHERE interaction_id = ? AND state = 'pending'`,
      )
      .run(state, JSON.stringify(outcome), completedAt, interactionId);
    if (Number(result.changes) !== 1) {
      throw new Error(`Relay interaction state changed before completion: ${interactionId}`);
    }
    return this.requireByInteractionId(interactionId);
  }

  private requirePending(interactionId: string): StoredRelayInteraction {
    const interaction = this.requireByInteractionId(interactionId);
    if (interaction.state !== "pending") {
      throw new Error(`Relay interaction ${interactionId} is already ${interaction.state}`);
    }
    return interaction;
  }

  private requireByInteractionId(interactionId: string): StoredRelayInteraction {
    const interaction = this.getByInteractionId(interactionId);
    if (!interaction) throw new Error(`Relay interaction was not found: ${interactionId}`);
    return interaction;
  }
}

export class RelayInteractionManager {
  private readonly store: RelayInteractionStore;
  private readonly waiters = new Map<string, PendingInteraction>();

  constructor(
    private readonly registry: RelayProviderRegistry,
    database: RelayDatabase,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new RelayInteractionStore(database);
  }

  recoverAfterRestart(): void {
    const completedAt = new Date(this.now()).toISOString();
    for (const interaction of this.store.listPending()) {
      const expired = Date.parse(interaction.prompt.expiresAt) <= this.now();
      this.store.complete(
        interaction.interactionId,
        expired ? "expired" : "cancelled",
        expired
          ? { state: "expired", completedAt }
          : { state: "cancelled", reason: "host-restarted", completedAt },
        completedAt,
      );
    }
  }

  async present(prompt: RelayInteractionPrompt): Promise<RelayInteractionTerminalOutcome> {
    validatePrompt(prompt);
    const stored = this.store.create(prompt);
    if (stored.outcome) return stored.outcome;
    const existingWaiter = this.waiters.get(prompt.interactionId);
    if (existingWaiter) return existingWaiter.promise;
    if (stored.providerPromptMessageId) {
      const waiter = this.createWaiter(prompt);
      this.waiters.set(prompt.interactionId, waiter);
      return await waiter.promise;
    }

    const provider = this.registry.getProvider(prompt.address.providerId, prompt.address.accountId);
    const support = provider.capabilities(prompt.address.accountId).interactiveChoices;
    if (support !== "native" || !provider.interactions) {
      const completedAt = new Date(this.now()).toISOString();
      const outcome: RelayInteractionTerminalOutcome = {
        state: "unsupported",
        reason:
          support === "text-fallback"
            ? "Provider requires the existing text or desktop fallback"
            : "Provider does not support native interactive choices",
        completedAt,
      };
      this.store.complete(prompt.interactionId, "unsupported", outcome, completedAt);
      return outcome;
    }

    const waiter = this.createWaiter(prompt);
    this.waiters.set(prompt.interactionId, waiter);
    try {
      const receipt = await provider.interactions.publish(prompt);
      if (
        receipt.interactionId !== prompt.interactionId ||
        receipt.mode !== "native"
      ) {
        throw new Error("Relay provider returned an invalid native interaction receipt");
      }
      const current = this.store.getByInteractionId(prompt.interactionId);
      if (current?.state !== "pending") {
        await provider.interactions.cancel?.(
          prompt.interactionId,
          prompt.address,
          receipt.providerPromptMessageId,
        );
        if (current?.outcome) return current.outcome;
        throw new Error("Relay interaction completed before provider publication");
      }
      this.store.markPublished(
        prompt.interactionId,
        receipt.providerPromptMessageId,
        receipt.publishedAt,
      );
      return await waiter.promise;
    } catch (error) {
      clearTimeout(waiter.timeout);
      this.waiters.delete(prompt.interactionId);
      const current = this.store.getByInteractionId(prompt.interactionId);
      if (current?.outcome) return current.outcome;
      const completedAt = new Date(this.now()).toISOString();
      const outcome: RelayInteractionTerminalOutcome = {
        state: "failed",
        code: "provider-failure",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        completedAt,
      };
      this.store.complete(prompt.interactionId, "failed", outcome, completedAt);
      return outcome;
    }
  }

  handleSelection(selection: RelayInteractionSelection): void {
    try {
      const resolved = this.store.resolve(selection, this.now());
      if (!resolved?.outcome) return;
      this.finishWaiter(selection.interactionId, resolved.outcome);
    } catch (error) {
      if (error instanceof RelayInteractionSelectionRejectedError) {
        log.warn("Rejected relay interaction selection:", error);
        return;
      }
      throw error;
    }
  }

  cancelBySourceRequestId(sourceRequestId: string, reason: string): void {
    for (const interaction of this.store.listPendingBySourceRequestId(sourceRequestId)) {
      this.cancel(interaction.interactionId, reason);
    }
  }

  cancelPendingChoicesForSession(sessionId: string, reason: string): void {
    for (const interaction of this.store.listPendingChoicesBySession(sessionId)) {
      this.cancel(interaction.interactionId, reason);
    }
  }

  cancel(interactionId: string, reason: string): void {
    const completedAt = new Date(this.now()).toISOString();
    const outcome: RelayInteractionTerminalOutcome = {
      state: "cancelled",
      reason,
      completedAt,
    };
    const completed = this.store.complete(interactionId, "cancelled", outcome, completedAt);
    if (!completed?.outcome) return;
    this.finishWaiter(interactionId, completed.outcome);
    if (completed.providerPromptMessageId) {
      const provider = this.registry.getProvider(
        completed.prompt.address.providerId,
        completed.prompt.address.accountId,
      );
      const cancellation = provider.interactions?.cancel?.(
        completed.interactionId,
        completed.prompt.address,
        parseRelayMessageId(completed.providerPromptMessageId),
      );
      void cancellation?.catch((error: unknown) => {
        log
          .with({ interactionId: completed.interactionId })
          .warn("Relay interaction cancellation failed:", error);
      });
    }
  }

  cancelAll(reason: string): void {
    for (const interaction of this.store.listPending()) {
      this.cancel(interaction.interactionId, reason);
    }
  }

  hasPendingPermissionAt(address: RelayInteractionPrompt["address"]): boolean {
    return this.store.hasPendingPermissionAt(address);
  }

  private createWaiter(prompt: RelayInteractionPrompt): PendingInteraction {
    let resolve!: (outcome: RelayInteractionTerminalOutcome) => void;
    const promise = new Promise<RelayInteractionTerminalOutcome>((resolvePromise) => {
      resolve = resolvePromise;
    });
    const delay = Math.max(0, Date.parse(prompt.expiresAt) - this.now());
    const timeout = setTimeout(() => {
      const completedAt = new Date(this.now()).toISOString();
      const outcome: RelayInteractionTerminalOutcome = {
        state: "expired",
        completedAt,
      };
      const completed = this.store.complete(
        prompt.interactionId,
        "expired",
        outcome,
        completedAt,
      );
      if (completed?.outcome) this.finishWaiter(prompt.interactionId, completed.outcome);
    }, delay);
    return { promise, resolve, timeout };
  }

  private finishWaiter(
    interactionId: string,
    outcome: RelayInteractionTerminalOutcome,
  ): void {
    const waiter = this.waiters.get(interactionId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.waiters.delete(interactionId);
    waiter.resolve(outcome);
  }
}

function parseInteraction(row: RelayDatabaseRow): StoredRelayInteraction {
  const promptJson = relayTextColumn(row, "prompt_json");
  const outcomeJson = relayNullableTextColumn(row, "outcome_json");
  const prompt = JSON.parse(promptJson) as unknown;
  const outcome = outcomeJson === undefined ? undefined : (JSON.parse(outcomeJson) as unknown);
  if (!isInteractionPrompt(prompt)) {
    throw new Error("Stored relay interaction prompt is invalid");
  }
  validatePrompt(prompt);
  if (outcome !== undefined && !isInteractionOutcome(outcome)) {
    throw new Error("Stored relay interaction outcome is invalid");
  }
  return {
    interactionId: relayTextColumn(row, "interaction_id"),
    idempotencyKey: relayTextColumn(row, "idempotency_key"),
    prompt,
    state: interactionState(row),
    ...(relayNullableTextColumn(row, "provider_prompt_message_id") === undefined
      ? {}
      : {
          providerPromptMessageId: relayNullableTextColumn(
            row,
            "provider_prompt_message_id",
          )!,
        }),
    ...(outcome === undefined ? {} : { outcome }),
    createdAt: relayTextColumn(row, "created_at"),
    updatedAt: relayTextColumn(row, "updated_at"),
  };
}

function interactionState(row: RelayDatabaseRow): StoredInteractionState {
  const state = relayTextColumn(row, "state");
  if (
    state !== "pending" &&
    state !== "resolved" &&
    state !== "cancelled" &&
    state !== "expired" &&
    state !== "unsupported" &&
    state !== "failed"
  ) {
    throw new Error(`Stored relay interaction has an invalid state: ${state}`);
  }
  return state;
}

function validatePrompt(prompt: RelayInteractionPrompt): void {
  requireRelayText("interactionId", prompt.interactionId);
  requireRelayText("idempotencyKey", prompt.idempotencyKey);
  requireRelayText("sessionId", prompt.source.sessionId);
  requireRelayText("correlationId", prompt.source.correlationId);
  requireRelayText("title", prompt.title);
  requireRelayText("question", prompt.question);
  if (
    prompt.title.length > 256 ||
    prompt.question.length > 1_024 ||
    (prompt.body !== undefined && prompt.body.length > 1_024)
  ) {
    throw new Error("Relay interaction prompt text exceeds the allowed size");
  }
  if (
    !Number.isInteger(prompt.minSelections) ||
    !Number.isInteger(prompt.maxSelections) ||
    prompt.minSelections < 1 ||
    prompt.maxSelections < prompt.minSelections ||
    prompt.maxSelections > prompt.options.length
  ) {
    throw new Error("Relay interaction selection bounds are invalid");
  }
  if (
    prompt.kind === "permission" &&
    (prompt.minSelections !== 1 || prompt.maxSelections !== 1)
  ) {
    throw new Error("Relay permission interactions must select exactly one option");
  }

  if (prompt.options.length < 2 || prompt.options.length > 12) {
    throw new Error("Relay interaction must contain between 2 and 12 options");
  }
  const optionIds = new Set<string>();
  for (const option of prompt.options) {
    requireRelayText("optionId", option.optionId);
    requireRelayText("option label", option.label);
    if (
      option.label.length > 256 ||
      (option.description !== undefined && option.description.length > 1_024)
    ) {
      throw new Error("Relay interaction option text exceeds the allowed size");
    }
    if (optionIds.has(option.optionId)) {
      throw new Error("Relay interaction option IDs must be unique");
    }
    optionIds.add(option.optionId);
  }
  if (
    !Number.isFinite(Date.parse(prompt.createdAt)) ||
    !Number.isFinite(Date.parse(prompt.expiresAt)) ||
    Date.parse(prompt.expiresAt) <= Date.parse(prompt.createdAt)
  ) {
    throw new Error("Relay interaction timestamps are invalid");
  }
}

function promptFingerprint(prompt: RelayInteractionPrompt): string {
  return JSON.stringify({
    interactionId: prompt.interactionId,
    idempotencyKey: prompt.idempotencyKey,
    address: prompt.address,
    source: prompt.source,
    kind: prompt.kind,
    title: prompt.title,
    question: prompt.question,
    body: prompt.body,
    options: prompt.options,
    minSelections: prompt.minSelections,
    maxSelections: prompt.maxSelections,
  });
}

function isInteractionPrompt(value: unknown): value is RelayInteractionPrompt {
  return (
    isRecord(value) &&
    typeof value.interactionId === "string" &&
    typeof value.idempotencyKey === "string" &&
    isRecord(value.address) &&
    isRecord(value.source) &&
    (value.kind === "permission" || value.kind === "choice") &&
    typeof value.title === "string" &&
    typeof value.question === "string" &&
    Array.isArray(value.options) &&
    typeof value.minSelections === "number" &&
    typeof value.maxSelections === "number" &&
    typeof value.createdAt === "string" &&
    typeof value.expiresAt === "string"
  );
}

function isInteractionOutcome(value: unknown): value is RelayInteractionTerminalOutcome {
  return (
    isRecord(value) &&
    (value.state === "resolved" ||
      value.state === "cancelled" ||
      value.state === "expired" ||
      value.state === "unsupported" ||
      value.state === "failed")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
