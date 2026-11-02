import { createHash } from "node:crypto";

import type { WhatsAppSidecarAuthStorePort } from "./auth-port";
import type {
  WhatsAppInteractionOption,
  WhatsAppInteractionSelection,
} from "./protocol";

const OUTBOUND_LEDGER_CATEGORY = "marshal-outbound-message-ledger-v1";
const OUTBOUND_LEDGER_ID = "ledger";
const SESSION_GROUP_CATEGORY = "marshal-managed-session-groups-v1";
const SESSION_GROUP_BY_CONVERSATION_CATEGORY =
  "marshal-managed-session-groups-by-conversation-v1";
const SESSION_GROUP_RETIREMENT_CATEGORY = "marshal-managed-session-group-retirements-v1";
const SESSION_GROUP_RETIREMENT_INDEX_ID = "index";
const INTERACTION_POLL_CATEGORY = "marshal-interaction-polls-v1";
const INTERACTION_POLL_IDEMPOTENCY_CATEGORY =
  "marshal-interaction-polls-by-idempotency-v1";
const INTERACTION_SELECTION_OUTBOX_CATEGORY =
  "marshal-interaction-selection-outbox-v1";
const INTERACTION_SELECTION_OUTBOX_ID = "outbox";
const STATE_SCHEMA_VERSION = 1;
const OUTBOUND_LEDGER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_OUTBOUND_LEDGER_ENTRIES = 4_096;
const INTERACTION_SELECTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_INTERACTION_SELECTIONS = 4_096;

interface OutboundLedgerEntry {
  readonly providerMessageId: string;
  readonly conversationId: string;
  readonly createdAt: string;
}

export interface SessionGroupRecord {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  readonly idempotencyDigest: string;
  readonly conversationId: string;
  readonly communityConversationId: string;
  readonly displayName: string;
  readonly createdAt: string;
}

export interface SessionGroupRetirementRecord extends SessionGroupRecord {
  readonly retirementStartedAt: string;
}

interface InteractionPollOption extends WhatsAppInteractionOption {
  readonly optionHash: string;
}

interface InteractionSelectionOutboxEntry extends WhatsAppInteractionSelection {
  readonly recordedAt: string;
}

export interface InteractionPollRecord {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  readonly interactionId: string;
  readonly idempotencyDigest: string;
  readonly requestFingerprint: string;
  readonly providerMessageId: string;
  readonly conversationId: string;
  readonly sourceSessionId: string;
  readonly sourceTurnId?: string;
  readonly sourceRequestId?: string;
  readonly correlationId: string;
  readonly kind: "permission" | "choice";
  readonly options: readonly InteractionPollOption[];
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly messageSecretBase64: string;
  readonly state: "pending" | "resolved" | "cancelled" | "expired";
  readonly selectedOptionIds?: readonly string[];
  readonly createdAt: string;
  readonly publishedAt: string;
  readonly expiresAt: string;
  readonly completedAt?: string;
}

export class EncryptedOutboundMessageLedger {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly authStore: WhatsAppSidecarAuthStorePort,
    private readonly now: () => number = Date.now,
  ) {}

  track(providerMessageId: string, conversationId: string): Promise<void> {
    return this.runExclusive(async () => {
      const entries = await this.readEntries();
      entries.set(providerMessageId, {
        providerMessageId,
        conversationId,
        createdAt: new Date(this.now()).toISOString(),
      });
      await this.writeEntries(entries);
    });
  }

  remove(providerMessageId: string): Promise<void> {
    return this.runExclusive(async () => {
      const entries = await this.readEntries();
      if (!entries.delete(providerMessageId)) return;
      await this.writeEntries(entries);
    });
  }

  isTracked(providerMessageId: string, conversationId: string): Promise<boolean> {
    let tracked = false;
    return this.runExclusive(async () => {
      const entries = await this.readEntries();
      const entry = entries.get(providerMessageId);
      tracked = entry?.conversationId === conversationId;
      await this.writeEntries(entries);
    }).then(() => tracked);
  }

  private async readEntries(): Promise<Map<string, OutboundLedgerEntry>> {
    const value = (
      await this.authStore.readSignalKeys(OUTBOUND_LEDGER_CATEGORY, [OUTBOUND_LEDGER_ID])
    )[OUTBOUND_LEDGER_ID];
    if (value === undefined) return new Map();
    if (
      !isRecord(value) ||
      value.schemaVersion !== STATE_SCHEMA_VERSION ||
      !Array.isArray(value.entries)
    ) {
      throw new Error("Stored WhatsApp outbound ledger is invalid");
    }
    const cutoff = this.now() - OUTBOUND_LEDGER_TTL_MS;
    const entries = value.entries
      .map(parseOutboundLedgerEntry)
      .filter((entry) => Date.parse(entry.createdAt) >= cutoff)
      .slice(-MAX_OUTBOUND_LEDGER_ENTRIES);
    return new Map(entries.map((entry) => [entry.providerMessageId, entry]));
  }

  private async writeEntries(entries: ReadonlyMap<string, OutboundLedgerEntry>): Promise<void> {
    const bounded = [...entries.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(-MAX_OUTBOUND_LEDGER_ENTRIES);
    await this.authStore.applyTransaction({
      signalKeys: {
        [OUTBOUND_LEDGER_CATEGORY]: {
          [OUTBOUND_LEDGER_ID]: {
            schemaVersion: STATE_SCHEMA_VERSION,
            entries: bounded,
          },
        },
      },
    });
  }

  private runExclusive(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class EncryptedSessionGroupStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly authStore: WhatsAppSidecarAuthStorePort) {}

  async get(idempotencyKey: string): Promise<SessionGroupRecord | undefined> {
    const idempotencyDigest = digestIdempotencyKey(idempotencyKey);
    const value = (
      await this.authStore.readSignalKeys(SESSION_GROUP_CATEGORY, [idempotencyDigest])
    )[idempotencyDigest];
    return value === undefined
      ? undefined
      : parseSessionGroupRecord(value, idempotencyDigest);
  }

  async getByConversationId(conversationId: string): Promise<SessionGroupRecord | undefined> {
    let result: SessionGroupRecord | undefined;
    await this.runExclusive(async () => {
      result = await this.getByConversationIdLocked(conversationId);
    });
    return result;
  }

  private async getByConversationIdLocked(
    conversationId: string,
  ): Promise<SessionGroupRecord | undefined> {
    const { category, id: conversationDigest } =
      getPersistedSessionGroupConversationLookup(conversationId);
    const value = (
      await this.authStore.readSignalKeys(category, [conversationDigest])
    )[conversationDigest];
    const reverse = parsePersistedSessionGroupConversation(value, conversationId);
    if (!reverse) return undefined;
    const forwardValue = (
      await this.authStore.readSignalKeys(SESSION_GROUP_CATEGORY, [reverse.idempotencyDigest])
    )[reverse.idempotencyDigest];
    const forward =
      forwardValue === undefined
        ? undefined
        : parseSessionGroupRecord(forwardValue, reverse.idempotencyDigest);
    if (!forward || forward.conversationId !== conversationId) {
      await this.authStore.applyTransaction({
        signalKeys: {
          [SESSION_GROUP_BY_CONVERSATION_CATEGORY]: {
            [conversationDigest]: null,
          },
        },
      });
      return undefined;
    }
    if (!sameSessionGroupRecord(reverse, forward)) {
      await this.authStore.applyTransaction({
        signalKeys: {
          [SESSION_GROUP_BY_CONVERSATION_CATEGORY]: {
            [conversationDigest]: forward,
          },
        },
      });
    }
    return forward;
  }

  async set(input: Omit<SessionGroupRecord, "schemaVersion" | "idempotencyDigest"> & {
    readonly idempotencyKey: string;
  }): Promise<SessionGroupRecord> {
    let result: SessionGroupRecord | undefined;
    await this.runExclusive(async () => {
      const idempotencyDigest = digestIdempotencyKey(input.idempotencyKey);
      const previousValue = (
        await this.authStore.readSignalKeys(SESSION_GROUP_CATEGORY, [idempotencyDigest])
      )[idempotencyDigest];
      const previous =
        previousValue === undefined
          ? undefined
          : parseSessionGroupRecord(previousValue, idempotencyDigest);
      const conversationDigest = digestConversationId(input.conversationId);
      const reverseValue = (
        await this.authStore.readSignalKeys(SESSION_GROUP_BY_CONVERSATION_CATEGORY, [
          conversationDigest,
        ])
      )[conversationDigest];
      const reverseOwner =
        reverseValue === undefined
          ? undefined
          : parsePersistedSessionGroupConversation(reverseValue, input.conversationId);
      const reverseOwnerForwardValue =
        reverseOwner === undefined
          ? undefined
          : (
              await this.authStore.readSignalKeys(SESSION_GROUP_CATEGORY, [
                reverseOwner.idempotencyDigest,
              ])
            )[reverseOwner.idempotencyDigest];
      const reverseOwnerForward =
        reverseOwner === undefined || reverseOwnerForwardValue === undefined
          ? undefined
          : parseSessionGroupRecord(reverseOwnerForwardValue, reverseOwner.idempotencyDigest);
      const previousConversationId =
        previous && previous.conversationId !== input.conversationId
          ? previous.conversationId
          : undefined;
      const previousConversationDigest =
        previousConversationId === undefined
          ? undefined
          : digestConversationId(previousConversationId);
      const previousReverseValue =
        previousConversationDigest === undefined
          ? undefined
          : (
              await this.authStore.readSignalKeys(SESSION_GROUP_BY_CONVERSATION_CATEGORY, [
                previousConversationDigest,
              ])
            )[previousConversationDigest];
      const previousReverseOwner =
        previousConversationId === undefined || previousReverseValue === undefined
          ? undefined
          : parsePersistedSessionGroupConversation(previousReverseValue, previousConversationId);
      const retirementIds = await this.readRetirementIndex();
      const retirementWasPending = retirementIds.includes(conversationDigest);
      const record: SessionGroupRecord = {
        schemaVersion: STATE_SCHEMA_VERSION,
        idempotencyDigest,
        conversationId: input.conversationId,
        communityConversationId: input.communityConversationId,
        displayName: input.displayName,
        createdAt: input.createdAt,
      };
      await this.authStore.applyTransaction({
        signalKeys: {
          [SESSION_GROUP_CATEGORY]: {
            ...(reverseOwnerForward?.conversationId === record.conversationId &&
            reverseOwnerForward.idempotencyDigest !== record.idempotencyDigest
              ? { [reverseOwnerForward.idempotencyDigest]: null }
              : {}),
            [record.idempotencyDigest]: record,
          },
          [SESSION_GROUP_BY_CONVERSATION_CATEGORY]: {
            ...(previousConversationDigest &&
            previousReverseOwner?.idempotencyDigest === record.idempotencyDigest
              ? { [previousConversationDigest]: null }
              : {}),
            [conversationDigest]: record,
          },
          ...(retirementWasPending
            ? {
                [SESSION_GROUP_RETIREMENT_CATEGORY]: {
                  [conversationDigest]: null,
                  [SESSION_GROUP_RETIREMENT_INDEX_ID]: retirementIds.filter(
                    (id) => id !== conversationDigest,
                  ),
                },
              }
            : {}),
        },
      });
      result = record;
    });
    if (!result) throw new Error("WhatsApp session-group state write did not produce a record");
    return result;
  }

  async getPendingRetirement(
    conversationId: string,
  ): Promise<SessionGroupRetirementRecord | undefined> {
    const retirementId = digestConversationId(conversationId);
    const value = (
      await this.authStore.readSignalKeys(SESSION_GROUP_RETIREMENT_CATEGORY, [retirementId])
    )[retirementId];
    return value === undefined
      ? undefined
      : parseSessionGroupRetirementRecord(value, conversationId, retirementId);
  }

  async listPendingRetirements(): Promise<readonly SessionGroupRetirementRecord[]> {
    const ids = await this.readRetirementIndex();
    if (ids.length === 0) return [];
    const stored = await this.authStore.readSignalKeys(SESSION_GROUP_RETIREMENT_CATEGORY, ids);
    return ids.flatMap((id) => {
      const value = stored[id];
      return value === undefined ? [] : [parseSessionGroupRetirementRecord(value, undefined, id)];
    });
  }

  async prepareRetirement(
    conversationId: string,
    retirementStartedAt: string,
  ): Promise<SessionGroupRetirementRecord | undefined> {
    let result: SessionGroupRetirementRecord | undefined;
    await this.runExclusive(async () => {
      const existing = await this.getPendingRetirement(conversationId);
      if (existing) {
        result = existing;
        return;
      }
      const record = await this.getByConversationIdLocked(conversationId);
      if (!record) return;
      const retirementId = digestConversationId(conversationId);
      const retirementIds = new Set(await this.readRetirementIndex());
      retirementIds.add(retirementId);
      const retirement: SessionGroupRetirementRecord = {
        ...record,
        retirementStartedAt,
      };
      await this.authStore.applyTransaction({
        signalKeys: {
          [SESSION_GROUP_CATEGORY]: {
            [record.idempotencyDigest]: null,
          },
          [SESSION_GROUP_BY_CONVERSATION_CATEGORY]: {
            [retirementId]: null,
          },
          [SESSION_GROUP_RETIREMENT_CATEGORY]: {
            [retirementId]: retirement,
            [SESSION_GROUP_RETIREMENT_INDEX_ID]: [...retirementIds],
          },
        },
      });
      result = retirement;
    });
    return result;
  }

  async completeRetirement(conversationId: string): Promise<void> {
    await this.runExclusive(async () => {
      const retirementId = digestConversationId(conversationId);
      const retirementIds = await this.readRetirementIndex();
      if (!retirementIds.includes(retirementId)) return;
      await this.authStore.applyTransaction({
        signalKeys: {
          [SESSION_GROUP_RETIREMENT_CATEGORY]: {
            [retirementId]: null,
            [SESSION_GROUP_RETIREMENT_INDEX_ID]: retirementIds.filter(
              (id) => id !== retirementId,
            ),
          },
        },
      });
    });
  }

  async removeByConversationId(conversationId: string): Promise<void> {
    await this.runExclusive(async () => {
      const conversationDigest = digestConversationId(conversationId);
      const reverseValue = (
        await this.authStore.readSignalKeys(SESSION_GROUP_BY_CONVERSATION_CATEGORY, [
          conversationDigest,
        ])
      )[conversationDigest];
      if (reverseValue === undefined) return;
      const reverse = parseSessionGroupRecord(reverseValue);
      const currentValue = (
        await this.authStore.readSignalKeys(SESSION_GROUP_CATEGORY, [reverse.idempotencyDigest])
      )[reverse.idempotencyDigest];
      const current =
        currentValue === undefined
          ? undefined
          : parseSessionGroupRecord(currentValue, reverse.idempotencyDigest);
      await this.authStore.applyTransaction({
        signalKeys: {
          ...(current?.conversationId === conversationId
            ? {
                [SESSION_GROUP_CATEGORY]: {
                  [reverse.idempotencyDigest]: null,
                },
              }
            : {}),
          [SESSION_GROUP_BY_CONVERSATION_CATEGORY]: {
            [conversationDigest]: null,
          },
        },
      });
    });
  }

  private runExclusive(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readRetirementIndex(): Promise<readonly string[]> {
    const value = (
      await this.authStore.readSignalKeys(SESSION_GROUP_RETIREMENT_CATEGORY, [
        SESSION_GROUP_RETIREMENT_INDEX_ID,
      ])
    )[SESSION_GROUP_RETIREMENT_INDEX_ID];
    return parseSessionGroupRetirementIndex(value);
  }
}

export function getPersistedSessionGroupConversationLookup(conversationId: string): {
  readonly category: string;
  readonly id: string;
} {
  return {
    category: SESSION_GROUP_BY_CONVERSATION_CATEGORY,
    id: digestConversationId(conversationId),
  };
}

export function getPersistedSessionGroupForwardLookup(idempotencyDigest: string): {
  readonly category: string;
  readonly id: string;
} {
  if (!idempotencyDigest.trim()) {
    throw new Error("WhatsApp session-group idempotency digest is required");
  }
  return { category: SESSION_GROUP_CATEGORY, id: idempotencyDigest };
}

export function parsePersistedSessionGroupForward(
  value: unknown,
  idempotencyDigest: string,
): SessionGroupRecord | undefined {
  return value === undefined
    ? undefined
    : parseSessionGroupRecord(value, idempotencyDigest);
}

export function parsePersistedSessionGroupConversation(
  value: unknown,
  conversationId: string,
): SessionGroupRecord | undefined {
  if (value === undefined) return undefined;
  const record = parseSessionGroupRecord(value);
  if (record.conversationId !== conversationId) {
    throw new Error("Stored WhatsApp session-group conversation mapping is invalid");
  }
  return record;
}

export class EncryptedInteractionPollStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly authStore: WhatsAppSidecarAuthStorePort,
    private readonly now: () => number = Date.now,
  ) {}

  set(input: {
    readonly interactionId: string;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
    readonly providerMessageId: string;
    readonly conversationId: string;
    readonly sourceSessionId: string;
    readonly sourceTurnId?: string;
    readonly sourceRequestId?: string;
    readonly correlationId: string;
    readonly kind: "permission" | "choice";
    readonly options: readonly WhatsAppInteractionOption[];
    readonly minSelections: number;
    readonly maxSelections: number;
    readonly messageSecret: Uint8Array;
    readonly createdAt: string;
    readonly publishedAt: string;
    readonly expiresAt: string;
  }): Promise<void> {
    return this.runExclusive(async () => {
      const record: InteractionPollRecord = {
        schemaVersion: STATE_SCHEMA_VERSION,
        interactionId: input.interactionId,
        idempotencyDigest: digestIdempotencyKey(input.idempotencyKey),
        requestFingerprint: input.requestFingerprint,
        providerMessageId: input.providerMessageId,
        conversationId: input.conversationId,
        sourceSessionId: input.sourceSessionId,
        ...(input.sourceTurnId ? { sourceTurnId: input.sourceTurnId } : {}),
        ...(input.sourceRequestId ? { sourceRequestId: input.sourceRequestId } : {}),
        correlationId: input.correlationId,
        kind: input.kind,
        options: input.options.map((option) => ({
          ...option,
          optionHash: digestPollOption(option.label),
        })),
        minSelections: input.minSelections,
        maxSelections: input.maxSelections,
        messageSecretBase64: Buffer.from(input.messageSecret).toString("base64"),
        state: "pending",
        createdAt: input.createdAt,
        publishedAt: input.publishedAt,
        expiresAt: input.expiresAt,
      };
      await this.write(record);
    });
  }

  getByProviderMessageId(
    providerMessageId: string,
  ): Promise<InteractionPollRecord | undefined> {
    let result: InteractionPollRecord | undefined;
    return this.runExclusive(async () => {
      result = await this.read(providerMessageId);
    }).then(() => result);
  }

  getByIdempotencyKey(idempotencyKey: string): Promise<InteractionPollRecord | undefined> {
    let result: InteractionPollRecord | undefined;
    return this.runExclusive(async () => {
      const idempotencyDigest = digestIdempotencyKey(idempotencyKey);
      const value = (
        await this.authStore.readSignalKeys(INTERACTION_POLL_IDEMPOTENCY_CATEGORY, [
          idempotencyDigest,
        ])
      )[idempotencyDigest];
      result =
        value === undefined
          ? undefined
          : parseInteractionPollRecord(value, undefined, idempotencyDigest);
    }).then(() => result);
  }

  claimSelection(
    providerMessageId: string,
    conversationId: string,
    selectedOptionHashes: readonly string[],
    senderId: string,
    selectedAt: string,
  ): Promise<InteractionPollRecord | undefined> {
    let claimed: InteractionPollRecord | undefined;
    return this.runExclusive(async () => {
      const record = await this.read(providerMessageId);
      if (!record || record.state !== "pending" || record.conversationId !== conversationId) return;
      if (Date.parse(record.expiresAt) <= this.now()) {
        await this.write({
          ...record,
          state: "expired",
          completedAt: new Date(this.now()).toISOString(),
        });
        return;
      }
      const optionsByHash = new Map(
        record.options.map((option) => [option.optionHash, option.optionId]),
      );
      const selectedOptionIds = [
        ...new Set(
          selectedOptionHashes
            .map((hash) => optionsByHash.get(hash))
            .filter((optionId): optionId is string => optionId !== undefined),
        ),
      ];
      if (
        selectedOptionIds.length !== new Set(selectedOptionHashes).size ||
        selectedOptionIds.length < record.minSelections ||
        selectedOptionIds.length > record.maxSelections
      ) {
        return;
      }
      const resolved: InteractionPollRecord = {
        ...record,
        state: "resolved",
        selectedOptionIds,
        completedAt: selectedAt,
      };
      const selections = await this.readSelectionOutbox();
      selections.set(providerMessageId, {
        interactionId: resolved.interactionId,
        providerPromptMessageId: providerMessageId,
        conversationId,
        senderId,
        selectedOptionIds,
        selectedAt,
        recordedAt: new Date(this.now()).toISOString(),
      });
      await this.write(resolved, selections);
      claimed = resolved;
    }).then(() => claimed);
  }

  listSelectionsForReplay(): Promise<readonly WhatsAppInteractionSelection[]> {
    let selections: readonly WhatsAppInteractionSelection[] = [];
    return this.runExclusive(async () => {
      const entries = await this.readSelectionOutbox();
      await this.writeSelectionOutbox(entries);
      selections = [...entries.values()].map((entry) => ({
        interactionId: entry.interactionId,
        providerPromptMessageId: entry.providerPromptMessageId,
        conversationId: entry.conversationId,
        senderId: entry.senderId,
        selectedOptionIds: entry.selectedOptionIds,
        selectedAt: entry.selectedAt,
      }));
    }).then(() => selections);
  }

  cancel(providerMessageId: string, completedAt: string): Promise<void> {
    return this.runExclusive(async () => {
      const record = await this.read(providerMessageId);
      if (!record || record.state !== "pending") return;
      await this.write({
        ...record,
        state: "cancelled",
        completedAt,
      });
    });
  }

  private async read(providerMessageId: string): Promise<InteractionPollRecord | undefined> {
    const key = digestProviderMessageId(providerMessageId);
    const value = (
      await this.authStore.readSignalKeys(INTERACTION_POLL_CATEGORY, [key])
    )[key];
    return value === undefined
      ? undefined
      : parseInteractionPollRecord(value, providerMessageId);
  }

  private async write(
    record: InteractionPollRecord,
    selections?: ReadonlyMap<string, InteractionSelectionOutboxEntry>,
  ): Promise<void> {
    await this.authStore.applyTransaction({
      signalKeys: {
        [INTERACTION_POLL_CATEGORY]: {
          [digestProviderMessageId(record.providerMessageId)]: record,
        },
        [INTERACTION_POLL_IDEMPOTENCY_CATEGORY]: {
          [record.idempotencyDigest]: record,
        },
        ...(selections === undefined
          ? {}
          : {
              [INTERACTION_SELECTION_OUTBOX_CATEGORY]: {
                [INTERACTION_SELECTION_OUTBOX_ID]: selectionOutboxValue(selections),
              },
            }),
      },
    });
  }

  private async readSelectionOutbox(): Promise<Map<string, InteractionSelectionOutboxEntry>> {
    const value = (
      await this.authStore.readSignalKeys(INTERACTION_SELECTION_OUTBOX_CATEGORY, [
        INTERACTION_SELECTION_OUTBOX_ID,
      ])
    )[INTERACTION_SELECTION_OUTBOX_ID];
    if (value === undefined) return new Map();
    if (
      !isRecord(value) ||
      value.schemaVersion !== STATE_SCHEMA_VERSION ||
      !Array.isArray(value.entries)
    ) {
      throw new Error("Stored WhatsApp interaction selection outbox is invalid");
    }
    const cutoff = this.now() - INTERACTION_SELECTION_TTL_MS;
    const entries = value.entries
      .map(parseInteractionSelectionOutboxEntry)
      .filter((entry) => Date.parse(entry.recordedAt) >= cutoff)
      .slice(-MAX_INTERACTION_SELECTIONS);
    return new Map(entries.map((entry) => [entry.providerPromptMessageId, entry]));
  }

  private async writeSelectionOutbox(
    selections: ReadonlyMap<string, InteractionSelectionOutboxEntry>,
  ): Promise<void> {
    await this.authStore.applyTransaction({
      signalKeys: {
        [INTERACTION_SELECTION_OUTBOX_CATEGORY]: {
          [INTERACTION_SELECTION_OUTBOX_ID]: selectionOutboxValue(selections),
        },
      },
    });
  }

  private runExclusive(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function parseOutboundLedgerEntry(value: unknown): OutboundLedgerEntry {
  if (
    !isRecord(value) ||
    typeof value.providerMessageId !== "string" ||
    typeof value.conversationId !== "string" ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error("Stored WhatsApp outbound ledger entry is invalid");
  }
  return {
    providerMessageId: value.providerMessageId,
    conversationId: value.conversationId,
    createdAt: value.createdAt,
  };
}

function parseSessionGroupRecord(
  value: unknown,
  expectedDigest?: string,
): SessionGroupRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== STATE_SCHEMA_VERSION ||
    typeof value.idempotencyDigest !== "string" ||
    (expectedDigest !== undefined && value.idempotencyDigest !== expectedDigest) ||
    typeof value.conversationId !== "string" ||
    typeof value.communityConversationId !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error("Stored WhatsApp session-group mapping is invalid");
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    idempotencyDigest: value.idempotencyDigest,
    conversationId: value.conversationId,
    communityConversationId: value.communityConversationId,
    displayName: value.displayName,
    createdAt: value.createdAt,
  };
}

function parseSessionGroupRetirementRecord(
  value: unknown,
  expectedConversationId?: string,
  expectedRetirementId?: string,
): SessionGroupRetirementRecord {
  const record = parseSessionGroupRecord(value);
  if (
    (expectedConversationId !== undefined &&
      record.conversationId !== expectedConversationId) ||
    (expectedRetirementId !== undefined &&
      digestConversationId(record.conversationId) !== expectedRetirementId) ||
    !isRecord(value) ||
    typeof value.retirementStartedAt !== "string" ||
    !Number.isFinite(Date.parse(value.retirementStartedAt))
  ) {
    throw new Error("Stored WhatsApp session-group retirement is invalid");
  }
  return {
    ...record,
    retirementStartedAt: value.retirementStartedAt,
  };
}

function parseSessionGroupRetirementIndex(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string" && /^[a-f0-9]{64}$/.test(entry))
  ) {
    throw new Error("Stored WhatsApp session-group retirement index is invalid");
  }
  return [...new Set(value)];
}

function sameSessionGroupRecord(left: SessionGroupRecord, right: SessionGroupRecord): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.idempotencyDigest === right.idempotencyDigest &&
    left.conversationId === right.conversationId &&
    left.communityConversationId === right.communityConversationId &&
    left.displayName === right.displayName &&
    left.createdAt === right.createdAt
  );
}

function parseInteractionPollRecord(
  value: unknown,
  expectedProviderMessageId?: string,
  expectedIdempotencyDigest?: string,
): InteractionPollRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== STATE_SCHEMA_VERSION ||
    typeof value.interactionId !== "string" ||
    typeof value.idempotencyDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.idempotencyDigest) ||
    (expectedIdempotencyDigest !== undefined &&
      value.idempotencyDigest !== expectedIdempotencyDigest) ||
    typeof value.requestFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.requestFingerprint) ||
    typeof value.providerMessageId !== "string" ||
    (expectedProviderMessageId !== undefined &&
      value.providerMessageId !== expectedProviderMessageId) ||
    typeof value.conversationId !== "string" ||
    typeof value.sourceSessionId !== "string" ||
    (value.sourceTurnId !== undefined && typeof value.sourceTurnId !== "string") ||
    (value.sourceRequestId !== undefined && typeof value.sourceRequestId !== "string") ||
    typeof value.correlationId !== "string" ||
    (value.kind !== "permission" && value.kind !== "choice") ||
    !Array.isArray(value.options) ||
    !value.options.every(isInteractionPollOption) ||
    typeof value.minSelections !== "number" ||
    !Number.isSafeInteger(value.minSelections) ||
    value.minSelections < 1 ||
    typeof value.maxSelections !== "number" ||
    !Number.isSafeInteger(value.maxSelections) ||
    value.maxSelections < value.minSelections ||
    value.maxSelections > value.options.length ||
    typeof value.messageSecretBase64 !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.messageSecretBase64,
    ) ||
    Buffer.byteLength(value.messageSecretBase64, "base64") !== 32 ||
    (value.state !== "pending" &&
      value.state !== "resolved" &&
      value.state !== "cancelled" &&
      value.state !== "expired") ||
    (value.selectedOptionIds !== undefined && !isStringArray(value.selectedOptionIds)) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.publishedAt !== "string" ||
    !Number.isFinite(Date.parse(value.publishedAt)) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= Date.parse(value.createdAt) ||
    (value.completedAt !== undefined &&
      (typeof value.completedAt !== "string" ||
        !Number.isFinite(Date.parse(value.completedAt))))
  ) {
    throw new Error("Stored WhatsApp interaction poll is invalid");
  }

  const optionIds = new Set(value.options.map((option) => option.optionId));
  const optionLabels = new Set(value.options.map((option) => option.label));
  const optionHashes = new Set(value.options.map((option) => option.optionHash));
  const selectedOptionIds =
    value.selectedOptionIds === undefined
      ? undefined
      : requireStringArray(value.selectedOptionIds);
  if (
    value.options.length < 2 ||
    value.options.length > 12 ||
    optionIds.size !== value.options.length ||
    optionLabels.size !== value.options.length ||
    optionHashes.size !== value.options.length ||
    (value.state === "resolved" &&
      (selectedOptionIds === undefined ||
        selectedOptionIds.length < value.minSelections ||
        selectedOptionIds.length > value.maxSelections ||
        new Set(selectedOptionIds).size !== selectedOptionIds.length ||
        selectedOptionIds.some((optionId) => !optionIds.has(optionId)) ||
        value.completedAt === undefined)) ||
    (value.state === "pending" &&
      (selectedOptionIds !== undefined || value.completedAt !== undefined)) ||
    ((value.state === "cancelled" || value.state === "expired") &&
      (selectedOptionIds !== undefined || value.completedAt === undefined))
  ) {
    throw new Error("Stored WhatsApp interaction poll state is invalid");
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    interactionId: value.interactionId,
    idempotencyDigest: value.idempotencyDigest,
    requestFingerprint: value.requestFingerprint,
    providerMessageId: value.providerMessageId,
    conversationId: value.conversationId,
    sourceSessionId: value.sourceSessionId,
    ...(value.sourceTurnId === undefined ? {} : { sourceTurnId: value.sourceTurnId }),
    ...(value.sourceRequestId === undefined
      ? {}
      : { sourceRequestId: value.sourceRequestId }),
    correlationId: value.correlationId,
    kind: value.kind,
    options: value.options,
    minSelections: value.minSelections,
    maxSelections: value.maxSelections,
    messageSecretBase64: value.messageSecretBase64,
    state: value.state,
    ...(selectedOptionIds === undefined ? {} : { selectedOptionIds }),
    createdAt: value.createdAt,
    publishedAt: value.publishedAt,
    expiresAt: value.expiresAt,
    ...(value.completedAt === undefined ? {} : { completedAt: value.completedAt }),
  };
}

function parseInteractionSelectionOutboxEntry(
  value: unknown,
): InteractionSelectionOutboxEntry {
  if (
    !isRecord(value) ||
    typeof value.interactionId !== "string" ||
    typeof value.providerPromptMessageId !== "string" ||
    typeof value.conversationId !== "string" ||
    typeof value.senderId !== "string" ||
    !isStringArray(value.selectedOptionIds) ||
    value.selectedOptionIds.length === 0 ||
    value.selectedOptionIds.length > 12 ||
    new Set(value.selectedOptionIds).size !== value.selectedOptionIds.length ||
    typeof value.selectedAt !== "string" ||
    !Number.isFinite(Date.parse(value.selectedAt)) ||
    typeof value.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(value.recordedAt))
  ) {
    throw new Error("Stored WhatsApp interaction selection is invalid");
  }
  const selectedOptionIds = requireStringArray(value.selectedOptionIds);
  return {
    interactionId: value.interactionId,
    providerPromptMessageId: value.providerPromptMessageId,
    conversationId: value.conversationId,
    senderId: value.senderId,
    selectedOptionIds,
    selectedAt: value.selectedAt,
    recordedAt: value.recordedAt,
  };
}

function selectionOutboxValue(
  selections: ReadonlyMap<string, InteractionSelectionOutboxEntry>,
): {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  readonly entries: readonly InteractionSelectionOutboxEntry[];
} {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    entries: [...selections.values()]
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
      .slice(-MAX_INTERACTION_SELECTIONS),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function requireStringArray(value: unknown): string[] {
  if (!isStringArray(value)) throw new Error("Stored WhatsApp string array is invalid");
  return value;
}

function isInteractionPollOption(value: unknown): value is InteractionPollOption {
  return (
    isRecord(value) &&
    typeof value.optionId === "string" &&
    value.optionId.trim() === value.optionId &&
    value.optionId.length > 0 &&
    typeof value.label === "string" &&
    value.label.trim() === value.label &&
    value.label.length > 0 &&
    (value.description === undefined ||
      (typeof value.description === "string" &&
        value.description.trim() === value.description)) &&
    typeof value.optionHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.optionHash)
  );
}

function digestIdempotencyKey(value: string): string {
  if (!value.trim()) throw new Error("WhatsApp session-group idempotency key is required");
  return createHash("sha256").update(value).digest("hex");
}

function digestConversationId(value: string): string {
  if (!value.trim()) throw new Error("WhatsApp session-group conversation ID is required");
  return createHash("sha256").update(value).digest("hex");
}

function digestProviderMessageId(value: string): string {
  if (!value.trim()) throw new Error("WhatsApp interaction provider message ID is required");
  return createHash("sha256").update(value).digest("hex");
}

function digestPollOption(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
