import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  Browsers,
  decryptPollVote,
  downloadMediaMessage,
  DisconnectReason,
  generateMessageID,
  generateMessageIDV2,
  getKeyAuthor,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  initAuthCreds,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  makeWASocket,
  normalizeMessageContent,
} from "baileys";
import type {
  AuthenticationCreds,
  BaileysEventMap,
  CacheStore,
  SignalDataSet,
  SignalDataTypeMap,
  SignalKeyStore,
  UserFacingSocketConfig,
  WASocket,
} from "baileys";

import type { WhatsAppSidecarAuthStorePort } from "./auth-port";
import {
  describeWhatsAppGroupProvisioningError,
  inspectMarshalWhatsAppTopology,
  provisionMarshalWhatsAppGroups,
  readManagedFixedGroupIds,
  type ManagedGroupMetadata,
  type ManagedGroupSocket,
} from "./group-provisioning";
import {
  EncryptedOutboundMessageLedger,
  EncryptedInteractionPollStore,
  EncryptedSessionGroupStore,
  type SessionGroupRetirementRecord,
} from "./managed-message-state";
import type {
  WhatsAppAuthStoreValue,
  WhatsAppInboundManagedAttachment,
  WhatsAppManagedFixedGroupRole,
  WhatsAppSidecarRequest,
  WhatsAppSidecarRequestResponse,
} from "./protocol";
import type { WhatsAppSocketAdapter, WhatsAppSocketAdapterEvent } from "./socket-controller";

type BaileysLogger = NonNullable<UserFacingSocketConfig["logger"]>;

const SILENT_LOGGER: BaileysLogger = {
  level: "silent",
  child: () => SILENT_LOGGER,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_VOICE_BYTES = 25 * 1024 * 1024;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 40_000;
const IMAGE_MIME_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);
const VOICE_MIME_EXTENSIONS = new Map([
  ["audio/ogg", ".ogg"],
  ["audio/mpeg", ".mp3"],
  ["audio/mp4", ".m4a"],
  ["audio/wav", ".wav"],
  ["audio/x-wav", ".wav"],
]);

type BaileysInboundMessage = BaileysEventMap["messages.upsert"]["messages"][number];

interface ManagedMediaSource {
  readonly message: BaileysInboundMessage;
  readonly providerMessageId: string;
  readonly attachment: WhatsAppInboundManagedAttachment;
  readonly maxBytes: number;
  readonly materialized?: {
    readonly directory: string;
    readonly localPath: string;
    readonly sizeBytes: number;
    readonly sha256: string;
  };
}

export async function createBaileysSocketAdapter(
  authStore: WhatsAppSidecarAuthStorePort,
  onEvent: (event: WhatsAppSocketAdapterEvent) => void,
  options: { provisionOnOpen?: boolean } = {},
): Promise<WhatsAppSocketAdapter> {
  const storedCredentials = await authStore.readCredentials();
  const credentials =
    storedCredentials === null ? initAuthCreds() : requireAuthenticationCreds(storedCredentials);
  if (storedCredentials === null) {
    await authStore.applyTransaction({ credentials });
  }

  let authFailureReported = false;
  const reportAuthFailure = (): void => {
    if (authFailureReported) return;
    authFailureReported = true;
    onEvent({ type: "auth-error" });
  };
  const persistence = new AuthPersistenceBarrier(reportAuthFailure);
  const signalCache = createSignalCache();
  const keys = makeCacheableSignalKeyStore(
    createSignalKeyStore(authStore, persistence),
    SILENT_LOGGER,
    signalCache,
  );
  const socket = makeWASocket({
    auth: { creds: credentials, keys },
    browser: Browsers.appropriate("Marshal"),
    emitOwnEvents: false,
    getMessage: async () => undefined,
    logger: SILENT_LOGGER,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
    shouldSyncHistoryMessage: () => false,
    syncFullHistory: false,
  });
  const managedGroupsSupported = supportsManagedGroupProvisioning(socket);
  const managedGroupSocket = createManagedGroupSocket(socket);

  return new BaileysSocketAdapter(
    socket,
    managedGroupSocket,
    managedGroupsSupported,
    options.provisionOnOpen !== false,
    credentials,
    authStore,
    persistence,
    signalCache,
    () => authFailureReported,
    reportAuthFailure,
    onEvent,
  );
}

async function fetchCommunities(
  socket: WASocket,
): Promise<Record<string, ManagedGroupMetadata>> {
  const result = await socket.query(
    {
      tag: "iq",
      attrs: { to: "@g.us", xmlns: "w:g2", type: "get" },
      content: [
        {
          tag: "participating",
          attrs: {},
          content: [
            { tag: "participants", attrs: {} },
            { tag: "description", attrs: {} },
          ],
        },
      ],
    },
    45_000,
  );
  if (!result) throw new Error("WhatsApp community topology query timed out");
  const communities = getBinaryNodeChildren(
    getBinaryNodeChild(result, "communities"),
    "community",
  );
  return Object.fromEntries(
    communities.flatMap((community) => {
      const rawId = community.attrs.id;
      const subject = community.attrs.subject;
      if (typeof rawId !== "string" || typeof subject !== "string") return [];
      const id = rawId.endsWith("@g.us") ? rawId : `${rawId}@g.us`;
      return [
        [
          id,
          {
            id,
            subject,
            participants: getBinaryNodeChildren(community, "participant").flatMap(
              (participant) =>
                typeof participant.attrs.jid === "string"
                  ? [{ id: participant.attrs.jid }]
                  : [],
            ),
            isCommunity: true,
          },
        ],
      ];
    }),
  );
}

function createManagedGroupSocket(socket: WASocket): ManagedGroupSocket {
  return {
    groupFetchAllParticipating: () => socket.groupFetchAllParticipating(),
    communityFetchAllParticipating: () => fetchCommunities(socket),
    groupMetadata: (jid) => socket.groupMetadata(jid),
    communityMetadata: async (jid) => ({
      ...(await socket.groupMetadata(jid)),
      isCommunity: true,
    }),
    communityCreate: (subject, body) => createCommunity(socket, subject, body),
    communityCreateGroup: (subject, participants, parentCommunityJid) =>
      createCommunityGroup(socket, subject, participants, parentCommunityJid),
    groupCreate: (subject, participants) => socket.groupCreate(subject, participants),
    communityFetchLinkedGroups: (communityJid) =>
      socket.communityFetchLinkedGroups(communityJid),
    communityLinkGroup: (groupJid, parentCommunityJid) =>
      socket.communityLinkGroup(groupJid, parentCommunityJid),
    communityUnlinkGroup: (groupJid, parentCommunityJid) =>
      socket.communityUnlinkGroup(groupJid, parentCommunityJid),
    communityUpdateSubject: (jid, subject) => socket.groupUpdateSubject(jid, subject),
    groupUpdateSubject: (jid, subject) => socket.groupUpdateSubject(jid, subject),
    groupParticipantsUpdate: (jid, participants, action) =>
      socket.groupParticipantsUpdate(jid, participants, action),
    groupRevokeInvite: (jid) => socket.groupRevokeInvite(jid),
    communityLeave: (jid) => socket.communityLeave(jid),
    groupLeave: (jid) => socket.groupLeave(jid),
    sendMessage: (jid, content) => socket.sendMessage(jid, content),
  };
}

function supportsManagedGroupProvisioning(socket: WASocket): boolean {
  const candidate: Partial<WASocket> = socket;
  return (
    typeof candidate.groupFetchAllParticipating === "function" &&
    typeof candidate.communityFetchAllParticipating === "function" &&
    typeof candidate.communityCreate === "function" &&
    typeof candidate.communityCreateGroup === "function"
  );
}

async function createCommunity(
  socket: WASocket,
  subject: string,
  body: string,
): Promise<ManagedGroupMetadata> {
  const beforeIds = new Set(Object.keys(await socket.communityFetchAllParticipating()));
  const observer = observeCreatedConversation(socket, "community", subject, beforeIds);
  const descriptionId = generateMessageID().substring(0, 12);
  let result: Awaited<ReturnType<WASocket["query"]>>;
  let observed: ManagedGroupMetadata | undefined;
  try {
    result = await socket.query({
      tag: "iq",
      attrs: { type: "set", xmlns: "w:g2", to: "@g.us" },
      content: [
        {
          tag: "create",
          attrs: { subject },
          content: [
            {
              tag: "description",
              attrs: { id: descriptionId },
              content: [
                {
                  tag: "body",
                  attrs: {},
                  content: Buffer.from(body || "", "utf8"),
                },
              ],
            },
            {
              tag: "parent",
              attrs: { default_membership_approval_mode: "request_required" },
            },
            { tag: "allow_non_admin_sub_group_creation", attrs: {} },
            { tag: "create_general_chat", attrs: {} },
          ],
        },
      ],
    });
    observed =
      readCreatedGroupId(result) === undefined
        ? ((await waitForObservedCreate(observer.promise)) ??
          (await pollCreatedConversation(
            () => socket.communityFetchAllParticipating(),
            subject,
            beforeIds,
          )))
        : undefined;
  } finally {
    observer.dispose();
  }
  const id = readCreatedGroupId(result) ?? observed?.id;
  if (!id) {
    throw new Error(
      `WhatsApp community create response did not include an ID and the community did not materialize remotely (${typeof result}:${summarizeNodeShape(
        result,
      )})`,
    );
  }
  try {
    return await socket.communityMetadata(id);
  } catch {
    return { id, subject, participants: [], isCommunity: true };
  }
}

async function createCommunityGroup(
  socket: WASocket,
  subject: string,
  participants: string[],
  parentCommunityJid: string,
): Promise<ManagedGroupMetadata> {
  const beforeIds = new Set(Object.keys(await socket.groupFetchAllParticipating()));
  const observer = observeCreatedConversation(
    socket,
    "group",
    subject,
    beforeIds,
    parentCommunityJid,
  );
  let result: Awaited<ReturnType<WASocket["query"]>>;
  let observed: ManagedGroupMetadata | undefined;
  try {
    result = await socket.query({
      tag: "iq",
      attrs: { type: "set", xmlns: "w:g2", to: "@g.us" },
      content: [
        {
          tag: "create",
          attrs: { subject, key: generateMessageIDV2() },
          content: [
            ...participants.map((jid) => ({
              tag: "participant",
              attrs: { jid },
            })),
            { tag: "linked_parent", attrs: { jid: parentCommunityJid } },
          ],
        },
      ],
    });
    observed =
      readCreatedGroupId(result) === undefined
        ? ((await waitForObservedCreate(observer.promise)) ??
          (await pollCreatedConversation(
            () => socket.groupFetchAllParticipating(),
            subject,
            beforeIds,
            parentCommunityJid,
          )))
        : undefined;
  } finally {
    observer.dispose();
  }
  const id = readCreatedGroupId(result) ?? observed?.id;
  if (!id) {
    throw new Error(
      `WhatsApp community group create response did not include an ID and the group did not materialize remotely (${typeof result}:${summarizeNodeShape(
        result,
      )})`,
    );
  }

  try {
    return await socket.groupMetadata(id);
  } catch {
    return { id, subject, participants: [], linkedParent: parentCommunityJid };
  }
}

function observeCreatedConversation(
  socket: WASocket,
  kind: "community" | "group",
  subject: string,
  beforeIds: ReadonlySet<string>,
  parentCommunityId?: string,
): { promise: Promise<ManagedGroupMetadata>; dispose: () => void } {
  let resolve!: (metadata: ManagedGroupMetadata) => void;
  const promise = new Promise<ManagedGroupMetadata>((resolver) => {
    resolve = resolver;
  });
  const handler = (updates: BaileysEventMap["groups.upsert"]): void => {
    const candidate = updates.find(
      (metadata) =>
        !beforeIds.has(metadata.id) &&
        metadata.subject === subject &&
        (kind === "community" ? metadata.isCommunity === true : metadata.isCommunity !== true) &&
        (parentCommunityId === undefined || metadata.linkedParent === parentCommunityId),
    );
    if (candidate) resolve(candidate);
  };
  socket.ev.on("groups.upsert", handler);
  return {
    promise,
    dispose: () => socket.ev.off("groups.upsert", handler),
  };
}

function waitForObservedCreate(
  observed: Promise<ManagedGroupMetadata>,
): Promise<ManagedGroupMetadata | undefined> {
  return Promise.race([
    observed,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 10_000)),
  ]);
}

function readCreatedGroupId(
  result: Awaited<ReturnType<WASocket["query"]>>,
): string | undefined {
  const group = getBinaryNodeChild(result, "group");
  const rawId = group?.attrs.id ?? findCreatedGroupId(result);
  if (typeof rawId !== "string" || rawId.length === 0) return undefined;
  return rawId.endsWith("@g.us") ? rawId : `${rawId}@g.us`;
}

async function pollCreatedConversation(
  list: () => Promise<Record<string, ManagedGroupMetadata>>,
  subject: string,
  beforeIds: ReadonlySet<string>,
  parentCommunityId?: string,
): Promise<ManagedGroupMetadata | undefined> {
  for (const delayMs of [500, 1_000, 2_000, 4_000, 8_000, 15_000, 20_000]) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const candidates = Object.values(await list()).filter(
      (metadata) =>
        !beforeIds.has(metadata.id) &&
        metadata.subject === subject &&
        (parentCommunityId === undefined || metadata.linkedParent === parentCommunityId),
    );
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      throw new Error("WhatsApp create operation produced multiple matching conversations");
    }
  }
  return undefined;
}

function summarizeNodeShape(node: unknown, depth = 0): string {
  if (Array.isArray(node)) {
    return `[${node.map((child) => summarizeNodeShape(child, depth + 1)).join("|")}]`;
  }
  if (
    depth > 3 ||
    typeof node !== "object" ||
    node === null ||
    Buffer.isBuffer(node)
  ) {
    return "leaf";
  }
  const candidate = node as { tag?: unknown; attrs?: unknown; content?: unknown };
  const tag = typeof candidate.tag === "string" ? candidate.tag : "unknown";
  const attrKeys =
    typeof candidate.attrs === "object" && candidate.attrs !== null
      ? Object.keys(candidate.attrs as Record<string, unknown>).sort().join(",")
      : "";
  const children = Array.isArray(candidate.content)
    ? candidate.content.map((child) => summarizeNodeShape(child, depth + 1)).join("|")
    : "";
  return `${tag}[${attrKeys}]${children ? `{${children}}` : ""}`;
}

function findCreatedGroupId(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findCreatedGroupId(child);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof node !== "object" || node === null || Buffer.isBuffer(node)) {
    return undefined;
  }
  const candidate = node as {
    tag?: unknown;
    attrs?: unknown;
    content?: unknown;
  };
  if (typeof candidate.attrs === "object" && candidate.attrs !== null) {
    const attrs = candidate.attrs as Record<string, unknown>;
    const jid = attrs.jid;
    if (typeof jid === "string" && jid.endsWith("@g.us")) return jid;
    if (
      (candidate.tag === "group" || candidate.tag === "community" || candidate.tag === "create") &&
      typeof attrs.id === "string" &&
      attrs.id.length > 0
    ) {
      return attrs.id;
    }
  }
  if (!Array.isArray(candidate.content)) return undefined;
  for (const child of candidate.content) {
    const found = findCreatedGroupId(child);
    if (found) return found;
  }
  return undefined;
}

class BaileysSocketAdapter implements WhatsAppSocketAdapter {
  private closed = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private inboundQueue: Promise<void> = Promise.resolve();
  private readonly outboundLedger: EncryptedOutboundMessageLedger;
  private readonly interactionStore: EncryptedInteractionPollStore;
  private readonly sessionGroupStore: EncryptedSessionGroupStore;
  private readonly sessionGroupConversationIds = new Set<string>();
  private readonly mediaSources = new Map<string, ManagedMediaSource>();
  private readonly interactionPublishes = new Map<
    string,
    Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-interaction" }>>
  >();

  private readonly connectionHandler = (update: BaileysEventMap["connection.update"]): void => {
    if (this.closed || this.closing || this.hasAuthFailure()) return;
    if (update.qr) {
      this.onEvent({ type: "connection", state: "qr", qr: update.qr });
    }
    if (update.connection === "connecting") {
      this.onEvent({ type: "connection", state: "connecting" });
      return;
    }
    if (update.connection === "open") {
      const identity = toConnectedIdentity(this.socket);
      void this.persistence
        .drainUntilIdle()
        .then(async () => {
          if (this.closed || this.hasAuthFailure()) return;
          let provisioning;
          let provisioningError: string | undefined;
          try {
            await this.reconcilePendingSessionGroupRetirements();
          } catch (error) {
            provisioningError = `Session-group retirement recovery failed: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
          if (this.managedGroupsSupported && this.provisionOnOpen) {
            try {
              await provisionMarshalWhatsAppGroups(this.managedGroupSocket, this.authStore);
              provisioning = {
                community: true,
                newChats: true,
                progress: true,
                informationControl: true,
              };
            } catch (error) {
              const message = describeWhatsAppGroupProvisioningError(error);
              provisioningError = provisioningError
                ? `${provisioningError}; ${message}`
                : message;
            }
          }

          if (this.closed || this.hasAuthFailure()) return;
          this.onEvent({
            type: "connection",
            state: "open",
            identity,
            ...(provisioning ? { provisioning } : {}),
            ...(provisioningError ? { provisioningError } : {}),
          });
          for (const selection of await this.interactionStore.listSelectionsForReplay()) {
            if (this.closed || this.hasAuthFailure()) return;
            this.onEvent({ type: "interaction-selection", selection });
          }
        })
        .catch(() => {
          this.reportAuthFailure();
        });
      return;
    }
    if (update.connection === "close") {
      const statusCode = extractStatusCode(update.lastDisconnect?.error);
      const disconnect = classifyDisconnect(statusCode);
      this.onEvent({
        type: "connection",
        state: "close",
        ...disconnect,
        ...(statusCode === undefined ? {} : { statusCode }),
      });
    }
  };

  private readonly credentialsHandler = (update: BaileysEventMap["creds.update"]): void => {
    if (this.closed) return;
    Object.assign(this.credentials, update);
    void this.persistence.runWrite(() =>
      this.authStore.applyTransaction({ credentials: this.credentials }),
    );
  };

  private readonly messagesHandler = (update: BaileysEventMap["messages.upsert"]): void => {
    if (this.closed || this.closing) return;
    for (const message of update.messages) {
      const processing = this.inboundQueue.then(() => this.handleManagedMessage(message));
      this.inboundQueue = processing.catch(() => undefined);
      void processing.catch(() => {
        this.onEvent({
          type: "message-error",
          message: "WhatsApp managed message processing failed.",
        });
      });
    }
  };

  constructor(
    private readonly socket: WASocket,
    private readonly managedGroupSocket: ManagedGroupSocket,
    private readonly managedGroupsSupported: boolean,
    private readonly provisionOnOpen: boolean,
    private readonly credentials: AuthenticationCreds,
    private readonly authStore: WhatsAppSidecarAuthStorePort,
    private readonly persistence: AuthPersistenceBarrier,
    private readonly signalCache: CacheStore,
    private readonly hasAuthFailure: () => boolean,
    private readonly reportAuthFailure: () => void,
    private readonly onEvent: (event: WhatsAppSocketAdapterEvent) => void,
  ) {
    this.outboundLedger = new EncryptedOutboundMessageLedger(authStore);
    this.interactionStore = new EncryptedInteractionPollStore(authStore);
    this.sessionGroupStore = new EncryptedSessionGroupStore(authStore);
    socket.ev.on("connection.update", this.connectionHandler);
    socket.ev.on("creds.update", this.credentialsHandler);
    socket.ev.on("messages.upsert", this.messagesHandler);
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  inspectManagedTopology() {
    return inspectMarshalWhatsAppTopology(this.managedGroupSocket, this.authStore);
  }

  async provisionManagedGroups(): Promise<void> {
    await provisionMarshalWhatsAppGroups(this.managedGroupSocket, this.authStore);
  }

  async sendText(
    request: Extract<WhatsAppSidecarRequest, { type: "send-text" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-text" }>> {
    const providerMessageId = generateMessageID();
    await this.outboundLedger.track(providerMessageId, request.conversationId);
    try {
      const sent = await this.socket.sendMessage(
        request.conversationId,
        { text: request.text },
        { messageId: providerMessageId },
      );
      const actualId = sent?.key.id ?? providerMessageId;
      if (actualId !== providerMessageId) {
        await this.outboundLedger.track(actualId, request.conversationId);
      }
      return {
        type: "send-text",
        providerMessageId: actualId,
        sentAt: timestampFromMessage(sent?.messageTimestamp) ?? new Date().toISOString(),
      };
    } catch (error) {
      await this.outboundLedger.remove(providerMessageId);
      throw error;
    }
  }

  sendInteraction(
    request: Extract<WhatsAppSidecarRequest, { type: "send-interaction" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-interaction" }>> {
    const pending = this.interactionPublishes.get(request.idempotencyKey);
    if (pending) return pending;
    const operation = this.sendInteractionOnce(request);
    this.interactionPublishes.set(request.idempotencyKey, operation);
    const cleanup = () => {
      if (this.interactionPublishes.get(request.idempotencyKey) === operation) {
        this.interactionPublishes.delete(request.idempotencyKey);
      }
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  private async sendInteractionOnce(
    request: Extract<WhatsAppSidecarRequest, { type: "send-interaction" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-interaction" }>> {
    const requestFingerprint = interactionRequestFingerprint(request);
    const existing = await this.interactionStore.getByIdempotencyKey(
      request.idempotencyKey,
    );
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new Error("WhatsApp interaction idempotency key was reused with new content");
      }
      return {
        type: "send-interaction",
        interactionId: existing.interactionId,
        providerMessageId: existing.providerMessageId,
        sentAt: existing.publishedAt,
      };
    }

    const providerMessageId = generateMessageID();
    const messageSecret = randomBytes(32);
    let actualId = providerMessageId;
    await this.outboundLedger.track(providerMessageId, request.conversationId);
    try {
      const sent = await this.socket.sendMessage(
        request.conversationId,
        {
          poll: {
            name: formatInteractionPollName(request),
            values: request.options.map((option) => option.label),
            selectableCount: request.maxSelections,
            messageSecret,
          },
        },
        { messageId: providerMessageId },
      );
      actualId = sent?.key.id ?? providerMessageId;
      if (actualId !== providerMessageId) {
        await this.outboundLedger.track(actualId, request.conversationId);
      }
      const sentAt = timestampFromMessage(sent?.messageTimestamp) ?? new Date().toISOString();
      await this.interactionStore.set({
        interactionId: request.interactionId,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint,
        providerMessageId: actualId,
        conversationId: request.conversationId,
        sourceSessionId: request.sourceSessionId,
        ...(request.sourceTurnId ? { sourceTurnId: request.sourceTurnId } : {}),
        ...(request.sourceRequestId ? { sourceRequestId: request.sourceRequestId } : {}),
        correlationId: request.correlationId,
        kind: request.kind,
        options: request.options,
        minSelections: request.minSelections,
        maxSelections: request.maxSelections,
        messageSecret,
        createdAt: request.createdAt,
        publishedAt: sentAt,
        expiresAt: request.expiresAt,
      });
      return {
        type: "send-interaction",
        interactionId: request.interactionId,
        providerMessageId: actualId,
        sentAt,
      };
    } catch (error) {
      await this.outboundLedger.remove(providerMessageId);
      if (actualId !== providerMessageId) await this.outboundLedger.remove(actualId);
      throw error;
    } finally {
      messageSecret.fill(0);
    }
  }

  async releaseMedia(
    request: Extract<WhatsAppSidecarRequest, { type: "release-media" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "release-media" }>> {
    const source = this.mediaSources.get(request.sourceId);
    if (source) {
      this.mediaSources.delete(request.sourceId);
      if (source.materialized) {
        await rm(source.materialized.directory, { recursive: true, force: true });
      }
    }
    return { type: "release-media", sourceId: request.sourceId, released: true };
  }

  async downloadMedia(
    request: Extract<WhatsAppSidecarRequest, { type: "download-media" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "download-media" }>> {
    if (!request.authorizationToken.trim()) {
      throw new Error("WhatsApp media download requires an authorization capability");
    }
    const source = this.mediaSources.get(request.sourceId);
    if (!source) throw new Error("WhatsApp media source is no longer available");
    if (!request.authorizationToken.startsWith(`${source.providerMessageId}:`)) {
      throw new Error("WhatsApp media authorization does not match its message");
    }
    if (source.materialized) {
      return {
        type: "download-media",
        attachment: {
          ...source.attachment,
          localPath: source.materialized.localPath,
          sizeBytes: source.materialized.sizeBytes,
          sha256: source.materialized.sha256,
        },
      };
    }

    const downloadAbort = new AbortController();
    const bytes = await withTimeout(
      downloadMediaMessage(
        source.message,
        "buffer",
        { options: { signal: downloadAbort.signal } },
        {
          reuploadRequest: (candidate) => this.socket.updateMediaMessage(candidate),
          logger: SILENT_LOGGER,
        },
      ),
      MEDIA_DOWNLOAD_TIMEOUT_MS,
      "WhatsApp media download",
      () => downloadAbort.abort(),
    );
    if (bytes.byteLength === 0 || bytes.byteLength > source.maxBytes) {
      bytes.fill(0);
      throw new Error("WhatsApp media exceeds the allowed size");
    }
    const directory = await mkdtemp(path.join(tmpdir(), "marshal-whatsapp-media-"));
    const localPath = path.join(directory, source.attachment.fileName ?? "media");
    try {
      await writeFile(localPath, bytes, { flag: "wx", mode: 0o600 });
      const materialized = {
        directory,
        localPath,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      this.mediaSources.set(request.sourceId, { ...source, materialized });
      return {
        type: "download-media",
        attachment: {
          ...source.attachment,
          localPath,
          sizeBytes: materialized.sizeBytes,
          sha256: materialized.sha256,
        },
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      bytes.fill(0);
    }
  }

  async cancelInteraction(
    request: Extract<WhatsAppSidecarRequest, { type: "cancel-interaction" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "cancel-interaction" }>> {
    const record = await this.interactionStore.getByProviderMessageId(
      request.providerMessageId,
    );
    if (
      record?.interactionId === request.interactionId &&
      record.conversationId === request.conversationId
    ) {
      await this.interactionStore.cancel(
        request.providerMessageId,
        new Date().toISOString(),
      );
    }
    return {
      type: "cancel-interaction",
      interactionId: request.interactionId,
      providerMessageId: request.providerMessageId,
      cancelled: true,
    };
  }

  async ensureSessionGroup(
    request: Extract<WhatsAppSidecarRequest, { type: "ensure-session-group" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "ensure-session-group" }>> {
    const stored = await this.sessionGroupStore.get(request.idempotencyKey);
    if (stored) this.sessionGroupConversationIds.add(stored.conversationId);
    const existingConversationId = request.existingConversationId ?? stored?.conversationId;
    let replacingMissingGroup = false;
    if (existingConversationId) {
      const participating = await this.socket.groupFetchAllParticipating();
      if (participating[existingConversationId]) {
        try {
          const metadata = await this.socket.groupMetadata(existingConversationId);
          if (metadata.linkedParent !== request.communityConversationId) {
            throw new Error("Stored WhatsApp task group is linked to another community");
          }
          if (metadata.subject !== request.displayName) {
            await this.socket.groupUpdateSubject(metadata.id, request.displayName);
          }
          await this.sessionGroupStore.set({
            idempotencyKey: request.idempotencyKey,
            conversationId: metadata.id,
            communityConversationId: request.communityConversationId,
            displayName: request.displayName,
            createdAt: stored?.createdAt ?? new Date().toISOString(),
          });
          this.sessionGroupConversationIds.add(metadata.id);
          return {
            type: "ensure-session-group",
            conversationId: metadata.id,
            displayName: request.displayName,
            communityConversationId: request.communityConversationId,
            disposition: "existing",
          };
        } catch (error) {
          if (extractStatusCode(error) !== 404) throw error;
        }
      }
      replacingMissingGroup = true;
    }

    const created = await createCommunityGroup(
      this.socket,
      request.displayName,
      [],
      request.communityConversationId,
    );
    if (created.linkedParent !== request.communityConversationId) {
      await this.socket.communityLinkGroup(created.id, request.communityConversationId);
    }
    const metadata = await this.socket.groupMetadata(created.id);
    if (metadata.linkedParent !== request.communityConversationId) {
      throw new Error("WhatsApp task group did not converge under Marshal Community");
    }
    await this.sessionGroupStore.set({
      idempotencyKey: request.idempotencyKey,
      conversationId: metadata.id,
      communityConversationId: request.communityConversationId,
      displayName: request.displayName,
      createdAt: new Date().toISOString(),
    });
    this.sessionGroupConversationIds.add(metadata.id);
    return {
      type: "ensure-session-group",
      conversationId: metadata.id,
      displayName: request.displayName,
      communityConversationId: request.communityConversationId,
      disposition: replacingMissingGroup ? "reopened" : "created",
    };
  }

  async retireSessionGroup(
    request: Extract<WhatsAppSidecarRequest, { type: "retire-session-group" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "retire-session-group" }>> {
    const fixedGroups = await readManagedFixedGroupIds(this.authStore);
    if ([...fixedGroups.values()].includes(request.conversationId)) {
      throw new Error("Fixed WhatsApp managed groups cannot be retired as session access points");
    }
    const pendingRetirement = await this.sessionGroupStore.getPendingRetirement(
      request.conversationId,
    );
    const existing =
      pendingRetirement ??
      (await this.sessionGroupStore.getByConversationId(request.conversationId));
    if (!existing) {
      this.sessionGroupConversationIds.delete(request.conversationId);
      return {
        type: "retire-session-group",
        conversationId: request.conversationId,
        unlinked: false,
        left: false,
      };
    }
    if (existing.communityConversationId !== request.communityConversationId) {
      throw new Error("WhatsApp task group belongs to another community");
    }
    const stored =
      pendingRetirement ??
      (await this.sessionGroupStore.prepareRetirement(
        request.conversationId,
        new Date().toISOString(),
      ));
    if (!stored) {
      throw new Error("WhatsApp task group changed before retirement could be checkpointed");
    }
    this.sessionGroupConversationIds.delete(request.conversationId);
    return this.performSessionGroupRetirement(stored);
  }

  private async performSessionGroupRetirement(
    stored: SessionGroupRetirementRecord,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "retire-session-group" }>> {
    const conversationId = stored.conversationId;
    let metadata;
    try {
      metadata = await this.socket.groupMetadata(conversationId);
    } catch (error) {
      if (extractStatusCode(error) !== 404) throw error;
      await this.sessionGroupStore.completeRetirement(conversationId);
      this.sessionGroupConversationIds.delete(conversationId);
      return {
        type: "retire-session-group",
        conversationId,
        unlinked: false,
        left: false,
      };
    }
    if (
      metadata.linkedParent &&
      metadata.linkedParent !== stored.communityConversationId
    ) {
      throw new Error("WhatsApp task group is linked to another community");
    }

    let unlinked = false;
    if (metadata.linkedParent === stored.communityConversationId) {
      await this.socket.communityUnlinkGroup(conversationId, stored.communityConversationId);
      unlinked = true;
    }
    try {
      await this.socket.groupLeave(conversationId);
    } catch (error) {
      if (extractStatusCode(error) !== 404) throw error;
    }
    await this.sessionGroupStore.completeRetirement(conversationId);
    this.sessionGroupConversationIds.delete(conversationId);
    return {
      type: "retire-session-group",
      conversationId,
      unlinked,
      left: true,
    };
  }

  private async reconcilePendingSessionGroupRetirements(): Promise<void> {
    for (const retirement of await this.sessionGroupStore.listPendingRetirements()) {
      this.sessionGroupConversationIds.delete(retirement.conversationId);
      // eslint-disable-next-line no-await-in-loop -- retirement checkpoints are reconciled serially
      await this.performSessionGroupRetirement(retirement);
    }
  }

  private async handleManagedMessage(
    message: BaileysEventMap["messages.upsert"]["messages"][number],
  ): Promise<void> {
    const conversationId = message.key.remoteJid;
    const providerMessageId = message.key.id;
    if (
      typeof conversationId !== "string" ||
      !conversationId.endsWith("@g.us") ||
      typeof providerMessageId !== "string" ||
      providerMessageId.length === 0
    ) {
      return;
    }

    const managedGroups = await readManagedFixedGroupIds(this.authStore);
    const fixedRole = findManagedFixedGroupRole(managedGroups, conversationId);
    let isSessionGroup = this.sessionGroupConversationIds.has(conversationId);
    if (!isSessionGroup) {
      isSessionGroup = (await this.sessionGroupStore.getByConversationId(conversationId)) !== undefined;
      if (isSessionGroup) this.sessionGroupConversationIds.add(conversationId);
    }
    const role = fixedRole ?? (isSessionGroup ? "session" : undefined);
    if (!role) return;

    const fromMe = message.key.fromMe === true;
    if (fromMe && (await this.outboundLedger.isTracked(providerMessageId, conversationId))) return;
    if (!fromMe) return;

    const senderId = this.socket.user?.id;
    if (!senderId) throw new Error("WhatsApp managed message has no connected owner identity");
    if (await this.handleInteractionSelection(message, conversationId, senderId)) return;

    const text = readMessageText(message.message);
    const attachment = this.registerManagedMedia(message, providerMessageId);
    if (!text && !attachment) return;
    const sentAt = timestampFromMessage(message.messageTimestamp) ?? new Date().toISOString();

    this.onEvent({
      type: "message",
      message: {
        eventVersion: 1,
        providerMessageId,
        conversationId,
        role,
        senderId,
        origin: "same-account-human",
        sentAt,
        receivedAt: new Date().toISOString(),
        ...(text ? { text } : {}),
        attachments: attachment ? [attachment] : [],
        ...(readQuotedProviderMessageId(message.message)
          ? { replyToProviderMessageId: readQuotedProviderMessageId(message.message) }
          : {}),
      },
    });
  }

  private registerManagedMedia(
    message: BaileysInboundMessage,
    providerMessageId: string,
  ): WhatsAppInboundManagedAttachment | undefined {
    const media = readManagedMedia(message.message);
    if (!media) return undefined;
    if (media.sizeBytes !== undefined && media.sizeBytes > media.maxBytes) {
      throw new Error("WhatsApp media exceeds the allowed size");
    }
    const sourceId = randomUUID();
    const attachment: WhatsAppInboundManagedAttachment = {
      attachmentId: `${providerMessageId}:${media.kind}`,
      sourceId,
      kind: media.kind,
      mimeType: media.mimeType,
      fileName: media.fileName,
      ...(media.sizeBytes === undefined ? {} : { sizeBytes: media.sizeBytes }),
      ...(media.voiceMemo ? { voiceMemo: true } : {}),
      ...(media.durationMs === undefined ? {} : { durationMs: media.durationMs }),
    };
    this.mediaSources.set(sourceId, {
      message,
      providerMessageId,
      attachment,
      maxBytes: media.maxBytes,
    });
    return attachment;
  }

  private async handleInteractionSelection(
    message: BaileysEventMap["messages.upsert"]["messages"][number],
    conversationId: string,
    senderId: string,
  ): Promise<boolean> {
    const content = normalizeMessageContent(message.message);
    const pollUpdate = content?.pollUpdateMessage;
    const pollCreationMessageKey = pollUpdate?.pollCreationMessageKey;
    const providerPromptMessageId = pollCreationMessageKey?.id;
    if (
      !pollUpdate?.vote?.encPayload ||
      !pollUpdate.vote.encIv ||
      !pollCreationMessageKey ||
      typeof providerPromptMessageId !== "string"
    ) {
      return false;
    }
    const record = await this.interactionStore.getByProviderMessageId(
      providerPromptMessageId,
    );
    if (!record || record.conversationId !== conversationId || record.state !== "pending") {
      return true;
    }
    const ownerJid = jidNormalizedUser(senderId);
    const pollCreatorJid = getKeyAuthor(pollCreationMessageKey, ownerJid);
    const voterJid = getKeyAuthor(message.key, ownerJid);
    if (jidNormalizedUser(voterJid) !== ownerJid) return true;
    const secret = Buffer.from(record.messageSecretBase64, "base64");
    try {
      const vote = decryptPollVote(pollUpdate.vote, {
        pollCreatorJid,
        pollMsgId: providerPromptMessageId,
        pollEncKey: secret,
        voterJid,
      });
      const selectedHashes = (vote.selectedOptions ?? []).map((option) =>
        Buffer.from(option).toString("hex"),
      );
      if (selectedHashes.length === 0) return true;
      const selectedAt = new Date().toISOString();
      const claimed = await this.interactionStore.claimSelection(
        providerPromptMessageId,
        conversationId,
        selectedHashes,
        senderId,
        selectedAt,
      );
      if (!claimed?.selectedOptionIds) return true;
      this.onEvent({
        type: "interaction-selection",
        selection: {
          interactionId: claimed.interactionId,
          providerPromptMessageId,
          conversationId,
          senderId,
          selectedOptionIds: claimed.selectedOptionIds,
          selectedAt,
        },
      });
      return true;
    } finally {
      secret.fill(0);
    }
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    this.socket.ev.off("connection.update", this.connectionHandler);
    this.socket.ev.off("messages.upsert", this.messagesHandler);
    await this.inboundQueue;
    await Promise.all(
      [...this.mediaSources.values()].flatMap((source) =>
        source.materialized
          ? [rm(source.materialized.directory, { recursive: true, force: true })]
          : [],
      ),
    );
    this.mediaSources.clear();
    let socketError: unknown;
    try {
      await this.socket.end(undefined);
    } catch (error) {
      socketError = error;
    } finally {
      this.socket.ev.off("creds.update", this.credentialsHandler);
      this.closed = true;
    }

    let persistenceError: unknown;
    try {
      await this.persistence.drainUntilIdle();
    } catch (error) {
      persistenceError = error;
      this.reportAuthFailure();
    } finally {
      await this.signalCache.flushAll();
    }
    if (persistenceError && socketError) {
      throw new AggregateError(
        [persistenceError, socketError],
        "WhatsApp authentication persistence and socket shutdown failed.",
      );
    }
    if (persistenceError !== undefined) {
      throw new Error("WhatsApp authentication persistence failed.", {
        cause: persistenceError,
      });
    }
    if (socketError !== undefined) {
      throw new Error("WhatsApp socket shutdown failed.", { cause: socketError });
    }
  }
}

function findManagedFixedGroupRole(
  groups: ReadonlyMap<WhatsAppManagedFixedGroupRole, string>,
  conversationId: string,
): WhatsAppManagedFixedGroupRole | undefined {
  for (const [role, id] of groups) {
    if (id === conversationId) return role;
  }
  return undefined;
}

function readManagedMedia(
  message: BaileysEventMap["messages.upsert"]["messages"][number]["message"],
):
  | {
      readonly kind: "image" | "audio";
      readonly mimeType: string;
      readonly fileName: string;
      readonly sizeBytes?: number;
      readonly maxBytes: number;
      readonly voiceMemo?: true;
      readonly durationMs?: number;
    }
  | undefined {
  const content = normalizeMessageContent(message);
  const image = content?.imageMessage;
  if (image) {
    const mimeType = normalizeMimeType(image.mimetype, "image/jpeg");
    const extension = IMAGE_MIME_EXTENSIONS.get(mimeType);
    if (!extension) throw new Error("WhatsApp image MIME type is unsupported");
    return {
      kind: "image",
      mimeType,
      fileName: `image${extension}`,
      ...(numericValue(image.fileLength) === undefined
        ? {}
        : { sizeBytes: numericValue(image.fileLength) }),
      maxBytes: MAX_IMAGE_BYTES,
    };
  }
  const audio = content?.audioMessage;
  if (!audio?.ptt) return undefined;
  const mimeType = normalizeMimeType(audio.mimetype, "audio/ogg");
  const extension = VOICE_MIME_EXTENSIONS.get(mimeType);
  if (!extension) throw new Error("WhatsApp voice MIME type is unsupported");
  const durationSeconds = numericValue(audio.seconds);
  return {
    kind: "audio",
    mimeType,
    fileName: `voice${extension}`,
    ...(numericValue(audio.fileLength) === undefined
      ? {}
      : { sizeBytes: numericValue(audio.fileLength) }),
    maxBytes: MAX_VOICE_BYTES,
    voiceMemo: true,
    ...(durationSeconds === undefined
      ? {}
      : { durationMs: Math.round(durationSeconds * 1000) }),
  };
}

function normalizeMimeType(value: string | null | undefined, fallback: string): string {
  return (value ?? fallback).split(";")[0]!.trim().toLowerCase();
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof value.toNumber === "function"
  ) {
    const numberValue = value.toNumber();
    return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : undefined;
  }
  return undefined;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} timed out`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatInteractionPollName(
  request: Extract<WhatsAppSidecarRequest, { type: "send-interaction" }>,
): string {
  return [request.title, request.question, request.body]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n\n")
    .slice(0, 2_048);
}

function interactionRequestFingerprint(
  request: Extract<WhatsAppSidecarRequest, { type: "send-interaction" }>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        interactionId: request.interactionId,
        idempotencyKey: request.idempotencyKey,
        conversationId: request.conversationId,
        sourceSessionId: request.sourceSessionId,
        sourceTurnId: request.sourceTurnId,
        sourceRequestId: request.sourceRequestId,
        correlationId: request.correlationId,
        kind: request.kind,
        title: request.title,
        question: request.question,
        body: request.body,
        options: request.options,
        minSelections: request.minSelections,
        maxSelections: request.maxSelections,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
      }),
    )
    .digest("hex");
}

function readMessageText(message: unknown): string | undefined {
  const content = unwrapMessageContent(message);
  if (!content) return undefined;
  const conversation = readOptionalString(content.conversation);
  if (conversation) return boundedText(conversation);
  for (const key of [
    "extendedTextMessage",
    "imageMessage",
    "videoMessage",
    "documentMessage",
  ]) {
    const candidate = content[key];
    if (!isRecord(candidate)) continue;
    const text =
      readOptionalString(candidate.text) ??
      readOptionalString(candidate.caption) ??
      readOptionalString(candidate.fileName);
    if (text) return boundedText(text);
  }
  return undefined;
}

function readQuotedProviderMessageId(message: unknown): string | undefined {
  const content = unwrapMessageContent(message);
  if (!content) return undefined;
  for (const key of [
    "extendedTextMessage",
    "imageMessage",
    "videoMessage",
    "documentMessage",
    "audioMessage",
  ]) {
    const candidate = content[key];
    if (!isRecord(candidate) || !isRecord(candidate.contextInfo)) continue;
    const stanzaId = readOptionalString(candidate.contextInfo.stanzaId);
    if (stanzaId) return stanzaId;
  }
  return undefined;
}

function unwrapMessageContent(message: unknown): Record<string, unknown> | undefined {
  if (!isRecord(message)) return undefined;
  for (const wrapper of ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2"]) {
    const candidate = message[wrapper];
    if (isRecord(candidate) && isRecord(candidate.message)) {
      return unwrapMessageContent(candidate.message);
    }
  }
  return message;
}

function timestampFromMessage(value: unknown): string | undefined {
  let seconds: number | undefined;
  if (typeof value === "number") seconds = value;
  else if (typeof value === "bigint") seconds = Number(value);
  else if (isRecord(value) && typeof value.toNumber === "function") {
    seconds = value.toNumber();
  }
  if (!Number.isFinite(seconds)) return undefined;
  return new Date(Number(seconds) * 1000).toISOString();
}

function boundedText(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > 64 * 1024) return undefined;
  return trimmed;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function createSignalKeyStore(
  authStore: WhatsAppSidecarAuthStorePort,
  persistence: AuthPersistenceBarrier,
): SignalKeyStore {
  return {
    get: async <T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[],
    ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
      return persistence.runRead(async () => {
        const stored = await authStore.readSignalKeys(type, ids);
        const result: Record<string, SignalDataTypeMap[T]> = {};
        for (const [id, value] of Object.entries(stored)) {
          result[id] = value as SignalDataTypeMap[T];
        }
        return result;
      });
    },
    set: async (data: SignalDataSet): Promise<void> => {
      await persistence.runWrite(() =>
        authStore.applyTransaction({ signalKeys: toSignalKeyUpdates(data) }),
      );
    },
  };
}

class AuthPersistenceBarrier {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly active = new Set<Promise<unknown>>();
  private generation = 0;
  private failure: unknown;

  constructor(private readonly reportFailure: () => void) {}

  runRead<T>(operation: () => Promise<T>): Promise<T> {
    return this.track(Promise.resolve().then(operation));
  }

  runWrite(operation: () => Promise<void>): Promise<void> {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result;
    return this.track(result);
  }

  async drainUntilIdle(): Promise<void> {
    let idleTurns = 0;
    while (true) {
      const observedGeneration = this.generation;
      await Promise.allSettled([...this.active]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.failure !== undefined) throw this.failure;
      if (observedGeneration !== this.generation || this.active.size !== 0) {
        idleTurns = 0;
        continue;
      }
      idleTurns += 1;
      if (idleTurns >= 2) return;
    }
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.generation += 1;
    let tracked: Promise<T>;
    tracked = operation.finally(() => {
      this.active.delete(tracked);
    });
    this.active.add(tracked);
    void tracked.catch((error: unknown) => {
      this.failure ??= error;
      this.reportFailure();
    });
    return tracked;
  }
}

function createSignalCache(): CacheStore {
  const entries = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => entries.get(key) as T | undefined,
    set: <T>(key: string, value: T): void => {
      entries.set(key, value);
    },
    del: (key: string): boolean => entries.delete(key),
    flushAll: (): void => entries.clear(),
  };
}

function toSignalKeyUpdates(
  data: SignalDataSet,
): Record<string, Record<string, WhatsAppAuthStoreValue | null>> {
  const updates: Record<string, Record<string, WhatsAppAuthStoreValue | null>> = {};
  for (const [category, entries] of Object.entries(data)) {
    if (!entries) continue;
    const categoryUpdates: Record<string, WhatsAppAuthStoreValue | null> = {};
    for (const [id, value] of Object.entries(entries)) {
      if (value !== null && !isAuthStoreValue(value)) {
        throw new Error("Baileys produced an unsupported Signal-key value");
      }
      categoryUpdates[id] = value;
    }
    updates[category] = categoryUpdates;
  }
  return updates;
}

function requireAuthenticationCreds(value: WhatsAppAuthStoreValue): AuthenticationCreds {
  if (
    !isRecord(value) ||
    !isRecord(value.noiseKey) ||
    !isRecord(value.signedIdentityKey) ||
    !isRecord(value.signedPreKey) ||
    typeof value.registrationId !== "number" ||
    typeof value.advSecretKey !== "string" ||
    typeof value.registered !== "boolean"
  ) {
    throw new Error("Stored WhatsApp credentials are incompatible with Baileys");
  }
  return value as AuthenticationCreds;
}

function toConnectedIdentity(socket: WASocket) {
  const user = socket.user;
  if (!user?.id) {
    throw new Error("Baileys opened without a connected identity");
  }
  const displayName = user.name ?? user.notify ?? user.verifiedName;
  return {
    id: user.id,
    ...(user.phoneNumber ? { phoneNumber: user.phoneNumber } : {}),
    ...(displayName ? { displayName } : {}),
    ...(user.username ? { username: user.username } : {}),
  };
}

function classifyDisconnect(statusCode: number | undefined): {
  classification: "retryable" | "terminal";
  reason:
    | "bad-session"
    | "connection-closed"
    | "connection-lost"
    | "connection-replaced"
    | "forbidden"
    | "logged-out"
    | "multidevice-mismatch"
    | "restart-required"
    | "unavailable-service"
    | "unknown";
} {
  switch (statusCode) {
    case DisconnectReason.loggedOut:
      return { classification: "terminal", reason: "logged-out" };
    case DisconnectReason.badSession:
      return { classification: "terminal", reason: "bad-session" };
    case DisconnectReason.connectionReplaced:
      return { classification: "terminal", reason: "connection-replaced" };
    case DisconnectReason.multideviceMismatch:
      return { classification: "terminal", reason: "multidevice-mismatch" };
    case DisconnectReason.forbidden:
      return { classification: "terminal", reason: "forbidden" };
    case DisconnectReason.connectionClosed:
      return { classification: "retryable", reason: "connection-closed" };
    case DisconnectReason.connectionLost:
      return { classification: "retryable", reason: "connection-lost" };
    case DisconnectReason.restartRequired:
      return { classification: "retryable", reason: "restart-required" };
    case DisconnectReason.unavailableService:
      return { classification: "retryable", reason: "unavailable-service" };
    default:
      return { classification: "retryable", reason: "unknown" };
  }
}

function extractStatusCode(error: unknown, depth = 0): number | undefined {
  if (depth > 2 || !isRecord(error)) return undefined;
  if (typeof error.statusCode === "number" && Number.isSafeInteger(error.statusCode)) {
    return error.statusCode;
  }
  if (
    isRecord(error.output) &&
    typeof error.output.statusCode === "number" &&
    Number.isSafeInteger(error.output.statusCode)
  ) {
    return error.output.statusCode;
  }
  return extractStatusCode(error.cause, depth + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthStoreValue(value: unknown): value is WhatsAppAuthStoreValue {
  return (
    value !== null &&
    (typeof value === "object" ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint")
  );
}
