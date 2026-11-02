import {
  parseRelayConversationId,
  type RelayAccountId,
  type RelayAddress,
  type RelayConversationId,
  type RelayProviderId,
} from "../../../../common/relay-contract";
import type {
  RelayConversation,
  RelayConversationAdministration,
  RelayConversationCreateRequest,
} from "../../contracts";

declare const whatsAppParticipantIdBrand: unique symbol;

export type WhatsAppParticipantId = string & {
  readonly [whatsAppParticipantIdBrand]: "participant";
};

export interface WhatsAppGroupScope {
  readonly providerId: RelayProviderId;
  readonly accountId: RelayAccountId;
}

export interface WhatsAppGroupRef extends RelayAddress {
  readonly kind: "group";
}

export interface WhatsAppCommunityRef extends RelayAddress {
  readonly kind: "community";
}

export type WhatsAppConversationRef = WhatsAppGroupRef | WhatsAppCommunityRef;

export interface WhatsAppParticipantRef {
  readonly providerId: RelayProviderId;
  readonly accountId: RelayAccountId;
  readonly participantId: WhatsAppParticipantId;
}

export interface WhatsAppGroupSocketMetadata {
  readonly id: string;
  readonly kind: "group" | "community";
  readonly title: string;
  readonly parentCommunityId?: string;
  readonly participantIds?: readonly string[];
}

export interface WhatsAppGroupSocketCreateResult {
  readonly id: string;
}

export type WhatsAppParticipantAction = "add" | "remove";

export interface WhatsAppGroupSocketPort {
  listGroupMetadata(): Promise<readonly WhatsAppGroupSocketMetadata[]>;
  getConversationMetadata?(
    conversationId: RelayConversationId,
    kind: WhatsAppConversationRef["kind"],
  ): Promise<WhatsAppGroupSocketMetadata | undefined>;
  createCommunity?(title: string): Promise<WhatsAppGroupSocketCreateResult>;
  createGroup?(
    title: string,
    participantIds: readonly WhatsAppParticipantId[],
  ): Promise<WhatsAppGroupSocketCreateResult>;
  createCommunityGroup?(
    communityId: RelayConversationId,
    title: string,
    participantIds: readonly WhatsAppParticipantId[],
  ): Promise<WhatsAppGroupSocketCreateResult>;
  renameConversation?(conversationId: RelayConversationId, title: string): Promise<void>;
  updateParticipants?(
    groupId: RelayConversationId,
    participantIds: readonly WhatsAppParticipantId[],
    action: WhatsAppParticipantAction,
  ): Promise<void>;
  listLinkedGroupIds?(communityId: RelayConversationId): Promise<readonly string[]>;
  linkGroup?(communityId: RelayConversationId, groupId: RelayConversationId): Promise<void>;
  unlinkGroup?(communityId: RelayConversationId, groupId: RelayConversationId): Promise<void>;
  revokeInvite?(groupId: RelayConversationId): Promise<void>;
  leaveConversation?(conversationId: RelayConversationId): Promise<void>;
  sendText?(conversationId: RelayConversationId, text: string): Promise<void>;
}

export type WhatsAppManagedConversationRole =
  | "community"
  | "new-chats"
  | "progress"
  | "information-control";

export interface WhatsAppManagedConversationMapping {
  readonly role: WhatsAppManagedConversationRole;
  readonly title: string;
  readonly ref: WhatsAppConversationRef;
  readonly parentCommunityRef?: WhatsAppCommunityRef;
}

export interface WhatsAppGroupTombstone {
  readonly ref: WhatsAppConversationRef;
  readonly retiredAt: string;
  readonly reason: string;
}

export interface WhatsAppGroupMappingPort {
  get(
    scope: WhatsAppGroupScope,
    role: WhatsAppManagedConversationRole,
  ): Promise<WhatsAppManagedConversationMapping | undefined>;
  findByConversation(
    scope: WhatsAppGroupScope,
    conversationId: RelayConversationId,
  ): Promise<WhatsAppManagedConversationMapping | undefined>;
  getPendingRetirement(
    scope: WhatsAppGroupScope,
    conversationId: RelayConversationId,
  ): Promise<WhatsAppGroupTombstone | undefined>;
  listPendingRetirements(scope: WhatsAppGroupScope): Promise<readonly WhatsAppGroupTombstone[]>;
  prepareRetirement(tombstone: WhatsAppGroupTombstone): Promise<void>;
  set(mapping: WhatsAppManagedConversationMapping): Promise<void>;
  tombstone(tombstone: WhatsAppGroupTombstone): Promise<void>;
  runExclusive<T>(scope: WhatsAppGroupScope, operation: () => Promise<T>): Promise<T>;
}

export interface WhatsAppManagedConversation {
  readonly ref: WhatsAppConversationRef;
  readonly title: string;
  readonly parentCommunityRef?: WhatsAppCommunityRef;
  readonly participants: readonly WhatsAppParticipantRef[];
}

export type WhatsAppGroupCapability =
  | "create-community"
  | "create-group"
  | "rename-conversation"
  | "manage-participants"
  | "list-community-groups"
  | "link-group"
  | "unlink-group"
  | "revoke-invite"
  | "leave-conversation"
  | "send-notice";

export class WhatsAppGroupCapabilityError extends Error {
  readonly name = "WhatsAppGroupCapabilityError";
  readonly code = "WHATSAPP_GROUP_CAPABILITY_UNAVAILABLE";

  constructor(
    readonly capability: WhatsAppGroupCapability,
    readonly operation: string,
  ) {
    super(`WhatsApp capability "${capability}" is unavailable for ${operation}`);
  }
}

export class WhatsAppGroupUnsupportedError extends Error {
  readonly name = "WhatsAppGroupUnsupportedError";
  readonly code = "WHATSAPP_GROUP_OPERATION_UNSUPPORTED";

  constructor(
    readonly operation: string,
    readonly detail: string,
  ) {
    super(`WhatsApp does not support ${operation}: ${detail}`);
  }
}

export class WhatsAppGroupScopeError extends Error {
  readonly name = "WhatsAppGroupScopeError";
  readonly code = "WHATSAPP_GROUP_SCOPE_MISMATCH";

  constructor(readonly operation: string) {
    super(`WhatsApp ${operation} reference belongs to a different provider or account`);
  }
}

export class WhatsAppGroupRelationshipError extends Error {
  readonly name = "WhatsAppGroupRelationshipError";
  readonly code = "WHATSAPP_GROUP_RELATIONSHIP_INVALID";

  constructor(readonly detail: string) {
    super(`WhatsApp group relationship is invalid: ${detail}`);
  }
}

export class WhatsAppGroupNotFoundError extends Error {
  readonly name = "WhatsAppGroupNotFoundError";
  readonly code = "WHATSAPP_GROUP_NOT_FOUND";

  constructor(readonly conversationId: RelayConversationId) {
    super(`WhatsApp conversation "${conversationId}" is not available to this account`);
  }
}

export interface WhatsAppGroupAdministrationOptions {
  readonly scope: WhatsAppGroupScope;
  readonly socket: WhatsAppGroupSocketPort;
  readonly mappings: WhatsAppGroupMappingPort;
  readonly now?: () => string;
}

export interface WhatsAppGroupRetirementOptions {
  readonly noticeText?: string;
  readonly managedParticipants?: readonly WhatsAppParticipantRef[];
  readonly reason?: string;
}

interface NormalizedSocketMetadata {
  readonly id: RelayConversationId;
  readonly kind: "group" | "community";
  readonly title: string;
  readonly declaredParentCommunityId?: RelayConversationId;
  parentCommunityId?: RelayConversationId;
  readonly participantIds: readonly WhatsAppParticipantId[];
}

export class WhatsAppGroupAdministration implements RelayConversationAdministration {
  readonly scope: WhatsAppGroupScope;

  private readonly socket: WhatsAppGroupSocketPort;
  private readonly mappings: WhatsAppGroupMappingPort;
  private readonly now: () => string;

  constructor(options: WhatsAppGroupAdministrationOptions) {
    this.scope = options.scope;
    this.socket = options.socket;
    this.mappings = options.mappings;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async list(accountId: RelayAccountId): Promise<readonly RelayConversation[]> {
    this.assertAccount(accountId, "list");
    const conversations = await this.listWhatsAppConversations();
    return conversations.map(toRelayConversation);
  }

  async listWhatsAppConversations(): Promise<readonly WhatsAppManagedConversation[]> {
    const metadata = await this.readAllSocketMetadata();
    if (this.socket.listLinkedGroupIds !== undefined) {
      await this.reconcileLinkedParents(metadata);
    }
    return metadata.map((entry) => this.toManagedConversation(entry));
  }

  async getConversation(
    ref: WhatsAppConversationRef,
  ): Promise<WhatsAppManagedConversation | undefined> {
    this.assertRefScope(ref, "read");
    const conversations = await this.listWhatsAppConversations();
    const conversation = conversations.find(
      (candidate) => candidate.ref.conversationId === ref.conversationId,
    );
    if (!conversation && this.socket.getConversationMetadata) {
      const metadata = await this.socket.getConversationMetadata(ref.conversationId, ref.kind);
      if (!metadata) return undefined;
      return this.toManagedConversation(normalizeSocketMetadata(metadata));
    }
    if (conversation && conversation.ref.kind !== ref.kind) {
      throw new WhatsAppGroupRelationshipError(
        `mapped ${ref.kind} reference resolves to a ${conversation.ref.kind}`,
      );
    }
    return conversation;
  }

  async create(
    accountId: RelayAccountId,
    request: RelayConversationCreateRequest,
  ): Promise<RelayConversation> {
    this.assertAccount(accountId, "create");
    if (request.kind === "community") {
      if (request.parentConversationId) {
        throw new WhatsAppGroupUnsupportedError(
          "nested community creation",
          "communities cannot have parent conversations",
        );
      }
      return toRelayConversation(await this.createCommunity(request.displayName));
    }
    if (request.kind === "group") {
      const parentCommunityRef = request.parentConversationId
        ? createWhatsAppCommunityRef(this.scope, request.parentConversationId)
        : undefined;
      return toRelayConversation(await this.createGroup(request.displayName, parentCommunityRef));
    }
    throw new WhatsAppGroupUnsupportedError(
      "conversation creation",
      `conversation kind "${request.kind}" cannot be provisioned as a WhatsApp group`,
    );
  }

  async createCommunity(title: string): Promise<WhatsAppManagedConversation> {
    const normalizedTitle = requireWhatsAppTitle("community title", title);
    if (!this.socket.createCommunity) {
      throw new WhatsAppGroupCapabilityError("create-community", "community creation");
    }
    const created = await this.socket.createCommunity(normalizedTitle);
    const ref = createWhatsAppCommunityRef(this.scope, created.id);
    return this.requireConversation(ref);
  }

  async createGroup(
    title: string,
    parentCommunityRef?: WhatsAppCommunityRef,
    participants: readonly WhatsAppParticipantRef[] = [],
  ): Promise<WhatsAppManagedConversation> {
    const normalizedTitle = requireWhatsAppTitle("group title", title);
    if (parentCommunityRef) this.assertRefScope(parentCommunityRef, "create group");
    const participantIds = this.participantIds(participants, "create group");
    if (parentCommunityRef) {
      await this.requireConversation(parentCommunityRef);
      await this.linkedGroupIds(parentCommunityRef);
      if (!this.socket.createCommunityGroup && !this.socket.linkGroup) {
        throw new WhatsAppGroupCapabilityError("link-group", "community group creation");
      }
    }

    let created: WhatsAppGroupSocketCreateResult;
    if (parentCommunityRef && this.socket.createCommunityGroup) {
      created = await this.socket.createCommunityGroup(
        parentCommunityRef.conversationId,
        normalizedTitle,
        participantIds,
      );
    } else {
      if (!this.socket.createGroup) {
        throw new WhatsAppGroupCapabilityError("create-group", "group creation");
      }
      created = await this.socket.createGroup(normalizedTitle, participantIds);
    }

    const ref = createWhatsAppGroupRef(this.scope, created.id);
    if (parentCommunityRef) {
      const current = await this.requireConversation(ref);
      if (!current.parentCommunityRef) {
        await this.linkGroup(parentCommunityRef, ref);
      } else {
        await this.validateLinkedParent(parentCommunityRef, ref);
      }
    }
    return this.requireConversation(ref);
  }

  async rename(address: RelayAddress, displayName: string): Promise<RelayConversation> {
    const ref = await this.refFromAddress(address, "rename");
    return toRelayConversation(await this.renameConversation(ref, displayName));
  }

  async renameConversation(
    ref: WhatsAppConversationRef,
    title: string,
  ): Promise<WhatsAppManagedConversation> {
    this.assertRefScope(ref, "rename");
    const normalizedTitle = requireWhatsAppTitle("conversation title", title);
    const current = await this.requireConversation(ref);
    if (current.title === normalizedTitle) return current;
    if (!this.socket.renameConversation) {
      throw new WhatsAppGroupCapabilityError("rename-conversation", "conversation rename");
    }
    await this.forceRenameConversation(ref, normalizedTitle);
    const renamed = await this.requireConversation(ref);
    if (renamed.title !== normalizedTitle) {
      throw new WhatsAppGroupRelationshipError("renamed conversation did not expose its new title");
    }
    return renamed;
  }

  async forceRenameConversation(ref: WhatsAppConversationRef, title: string): Promise<void> {
    this.assertRefScope(ref, "force rename");
    const normalizedTitle = requireWhatsAppTitle("conversation title", title);
    if (!this.socket.renameConversation) {
      throw new WhatsAppGroupCapabilityError("rename-conversation", "conversation rename");
    }
    await this.socket.renameConversation(ref.conversationId, normalizedTitle);
  }

  assertCapabilities(capabilities: readonly WhatsAppGroupCapability[], operation: string): void {
    for (const capability of capabilities) {
      if (!this.supportsCapability(capability)) {
        throw new WhatsAppGroupCapabilityError(capability, operation);
      }
    }
  }

  async addParticipants(
    groupRef: WhatsAppGroupRef,
    participants: readonly WhatsAppParticipantRef[],
  ): Promise<void> {
    await this.updateParticipants(groupRef, participants, "add");
  }

  async removeParticipants(
    groupRef: WhatsAppGroupRef,
    participants: readonly WhatsAppParticipantRef[],
  ): Promise<void> {
    await this.updateParticipants(groupRef, participants, "remove");
  }

  async linkGroup(communityRef: WhatsAppCommunityRef, groupRef: WhatsAppGroupRef): Promise<void> {
    this.assertRefScope(communityRef, "link");
    this.assertRefScope(groupRef, "link");
    const group = await this.requireConversation(groupRef);
    await this.requireConversation(communityRef);
    const linkedGroupIds = await this.linkedGroupIds(communityRef);
    if (
      group.parentCommunityRef &&
      group.parentCommunityRef.conversationId !== communityRef.conversationId
    ) {
      throw new WhatsAppGroupRelationshipError("group is already linked to a different community");
    }
    if (group.parentCommunityRef) {
      await this.validateLinkedParent(communityRef, groupRef);
      return;
    }
    if (linkedGroupIds.has(groupRef.conversationId)) {
      await this.validateLinkedParent(communityRef, groupRef);
      return;
    }
    if (!this.socket.linkGroup) {
      throw new WhatsAppGroupCapabilityError("link-group", "community group linking");
    }
    await this.socket.linkGroup(communityRef.conversationId, groupRef.conversationId);
    await this.validateLinkedParent(communityRef, groupRef);
  }

  async unlinkGroup(communityRef: WhatsAppCommunityRef, groupRef: WhatsAppGroupRef): Promise<void> {
    this.assertRefScope(communityRef, "unlink");
    this.assertRefScope(groupRef, "unlink");
    const groupMetadata = await this.requireRawMetadata(groupRef.conversationId, "group");
    await this.requireRawMetadata(communityRef.conversationId, "community");
    if (
      groupMetadata.declaredParentCommunityId &&
      groupMetadata.declaredParentCommunityId !== communityRef.conversationId
    ) {
      throw new WhatsAppGroupRelationshipError(
        "cannot unlink a group from a community that is not its parent",
      );
    }
    const linkedGroupIds = await this.linkedGroupIds(communityRef);
    const linked = linkedGroupIds.has(groupRef.conversationId);
    if (!linked) {
      if (groupMetadata.declaredParentCommunityId === communityRef.conversationId) {
        throw new WhatsAppGroupRelationshipError(
          "group metadata names the community as parent but the community does not list the group",
        );
      }
      return;
    }
    if (!this.socket.unlinkGroup) {
      throw new WhatsAppGroupCapabilityError("unlink-group", "community group unlinking");
    }
    await this.socket.unlinkGroup(communityRef.conversationId, groupRef.conversationId);
    await this.validateUnlinkedParent(communityRef, groupRef);
  }

  async validateLinkedParent(
    communityRef: WhatsAppCommunityRef,
    groupRef: WhatsAppGroupRef,
  ): Promise<void> {
    this.assertRefScope(communityRef, "validate parent");
    this.assertRefScope(groupRef, "validate parent");
    if (!this.socket.listLinkedGroupIds) {
      throw new WhatsAppGroupCapabilityError("list-community-groups", "linked-parent validation");
    }
    const conversations = await this.listWhatsAppConversations();
    const community = this.requireListedConversation(communityRef, conversations);
    const group = this.requireListedConversation(groupRef, conversations);
    if (group.parentCommunityRef?.conversationId !== community.ref.conversationId) {
      throw new WhatsAppGroupRelationshipError(
        "group is not linked exclusively to the requested community",
      );
    }
  }

  async revokeInvite(groupRef: WhatsAppGroupRef): Promise<void> {
    this.assertRefScope(groupRef, "revoke invite");
    await this.requireConversation(groupRef);
    if (!this.socket.revokeInvite) {
      throw new WhatsAppGroupCapabilityError("revoke-invite", "invite revocation");
    }
    await this.socket.revokeInvite(groupRef.conversationId);
  }

  async leaveConversation(ref: WhatsAppConversationRef): Promise<void> {
    this.assertRefScope(ref, "leave");
    await this.requireConversation(ref);
    if (!this.socket.leaveConversation) {
      throw new WhatsAppGroupCapabilityError("leave-conversation", "conversation leave");
    }
    await this.socket.leaveConversation(ref.conversationId);
  }

  async retire(address: RelayAddress): Promise<void> {
    this.assertAddressScope(address, "retire");
    await this.mappings.runExclusive(this.scope, async () => {
      const mapping = await this.mappings.findByConversation(this.scope, address.conversationId);
      const pending = await this.mappings.getPendingRetirement(this.scope, address.conversationId);
      const ref = mapping?.ref ?? pending?.ref ?? (await this.refFromAddress(address, "retire"));
      await this.retireConversationUnlocked(ref);
    });
  }

  async retireConversation(
    ref: WhatsAppConversationRef,
    options: WhatsAppGroupRetirementOptions = {},
  ): Promise<void> {
    await this.mappings.runExclusive(this.scope, () =>
      this.retireConversationUnlocked(ref, options),
    );
  }

  private async retireConversationUnlocked(
    ref: WhatsAppConversationRef,
    options: WhatsAppGroupRetirementOptions = {},
  ): Promise<void> {
    this.assertRefScope(ref, "retire");
    const pending = await this.mappings.getPendingRetirement(this.scope, ref.conversationId);
    if (
      pending &&
      (pending.ref.providerId !== ref.providerId ||
        pending.ref.accountId !== ref.accountId ||
        pending.ref.conversationId !== ref.conversationId ||
        pending.ref.kind !== ref.kind)
    ) {
      throw new WhatsAppGroupRelationshipError(
        "pending retirement reference does not match the requested conversation",
      );
    }
    const conversation = await this.getConversation(ref);
    if (pending && !conversation) {
      await this.mappings.tombstone(pending);
      return;
    }
    const noticeText =
      pending || options.noticeText === undefined
        ? undefined
        : requireWhatsAppText("retirement notice", options.noticeText);
    const participants = options.managedParticipants ?? [];
    const participantIds = this.participantIds(participants, "retire");
    const tombstone: WhatsAppGroupTombstone = pending ?? {
      ref,
      retiredAt: this.now(),
      reason: requireWhatsAppText("retirement reason", options.reason ?? "retired"),
    };
    const sendText = this.socket.sendText;
    let sendNotice: (() => Promise<void>) | undefined;

    if (noticeText !== undefined) {
      if (!sendText) {
        throw new WhatsAppGroupCapabilityError("send-notice", "retirement notice");
      }
      sendNotice = () => sendText.call(this.socket, ref.conversationId, noticeText);
    }
    if (ref.kind === "group" && conversation?.parentCommunityRef) {
      await this.linkedGroupIds(conversation.parentCommunityRef);
      if (!this.socket.unlinkGroup) {
        throw new WhatsAppGroupCapabilityError("unlink-group", "conversation retirement");
      }
    }
    if (conversation && !this.socket.leaveConversation) {
      throw new WhatsAppGroupCapabilityError("leave-conversation", "conversation retirement");
    }
    if (!pending) await this.mappings.prepareRetirement(tombstone);
    if (!conversation) {
      await this.mappings.tombstone(tombstone);
      return;
    }

    if (sendNotice) await sendNotice();

    if (ref.kind === "group" && conversation.parentCommunityRef) {
      await this.unlinkGroup(conversation.parentCommunityRef, ref);
    }

    if (participantIds.length > 0 && this.socket.updateParticipants && ref.kind === "group") {
      await this.socket.updateParticipants(ref.conversationId, participantIds, "remove");
    }

    await this.leaveConversation(ref);
    await this.mappings.tombstone(tombstone);
  }

  deleteGlobally(ref: WhatsAppConversationRef): never {
    this.assertRefScope(ref, "delete");
    throw new WhatsAppGroupUnsupportedError(
      "global group deletion",
      "WhatsApp only supports operational retirement followed by leaving",
    );
  }

  private async updateParticipants(
    groupRef: WhatsAppGroupRef,
    participants: readonly WhatsAppParticipantRef[],
    action: WhatsAppParticipantAction,
  ): Promise<void> {
    this.assertRefScope(groupRef, `${action} participants`);
    await this.requireConversation(groupRef);
    const participantIds = this.participantIds(participants, `${action} participants`);
    if (participantIds.length === 0) return;
    if (!this.socket.updateParticipants) {
      throw new WhatsAppGroupCapabilityError("manage-participants", `${action} group participants`);
    }
    await this.socket.updateParticipants(groupRef.conversationId, participantIds, action);
  }

  private async validateUnlinkedParent(
    communityRef: WhatsAppCommunityRef,
    groupRef: WhatsAppGroupRef,
  ): Promise<void> {
    const groupMetadata = await this.requireRawMetadata(groupRef.conversationId, "group");
    if (groupMetadata.declaredParentCommunityId === communityRef.conversationId) {
      throw new WhatsAppGroupRelationshipError(
        "group metadata still names the community after unlinking",
      );
    }
    const linkedGroupIds = await this.linkedGroupIds(communityRef);
    if (linkedGroupIds.has(groupRef.conversationId)) {
      throw new WhatsAppGroupRelationshipError("community still lists the group after unlinking");
    }
  }

  private async linkedGroupIds(
    communityRef: WhatsAppCommunityRef,
  ): Promise<ReadonlySet<RelayConversationId>> {
    if (!this.socket.listLinkedGroupIds) {
      throw new WhatsAppGroupCapabilityError("list-community-groups", "linked-parent validation");
    }
    const rawIds = await this.socket.listLinkedGroupIds(communityRef.conversationId);
    return new Set(rawIds.map((id) => parseRelayConversationId(id)));
  }

  private async refFromAddress(
    address: RelayAddress,
    operation: string,
  ): Promise<WhatsAppConversationRef> {
    this.assertAddressScope(address, operation);
    const metadata = await this.requireRawMetadata(address.conversationId);
    return metadata.kind === "community"
      ? createWhatsAppCommunityRef(this.scope, metadata.id)
      : createWhatsAppGroupRef(this.scope, metadata.id);
  }

  private async requireConversation(
    ref: WhatsAppConversationRef,
  ): Promise<WhatsAppManagedConversation> {
    const conversation = await this.getConversation(ref);
    if (!conversation) throw new WhatsAppGroupNotFoundError(ref.conversationId);
    return conversation;
  }

  private requireListedConversation(
    ref: WhatsAppConversationRef,
    conversations: readonly WhatsAppManagedConversation[],
  ): WhatsAppManagedConversation {
    const conversation = conversations.find(
      (candidate) => candidate.ref.conversationId === ref.conversationId,
    );
    if (!conversation) throw new WhatsAppGroupNotFoundError(ref.conversationId);
    if (conversation.ref.kind !== ref.kind) {
      throw new WhatsAppGroupRelationshipError(
        `mapped ${ref.kind} reference resolves to a ${conversation.ref.kind}`,
      );
    }
    return conversation;
  }

  private async readAllSocketMetadata(): Promise<NormalizedSocketMetadata[]> {
    const rawMetadata = await this.socket.listGroupMetadata();
    const metadata = rawMetadata.map(normalizeSocketMetadata);
    const seen = new Set<RelayConversationId>();
    for (const entry of metadata) {
      if (seen.has(entry.id)) {
        throw new WhatsAppGroupRelationshipError(
          "provider returned the same conversation more than once",
        );
      }
      seen.add(entry.id);
    }
    return metadata;
  }

  private async requireRawMetadata(
    conversationId: RelayConversationId,
    expectedKind?: "group" | "community",
  ): Promise<NormalizedSocketMetadata> {
    const metadata = await this.readAllSocketMetadata();
    const entry = metadata.find((candidate) => candidate.id === conversationId);
    if (!entry) throw new WhatsAppGroupNotFoundError(conversationId);
    if (expectedKind && entry.kind !== expectedKind) {
      throw new WhatsAppGroupRelationshipError(
        `expected a ${expectedKind} but the provider returned a ${entry.kind}`,
      );
    }
    return entry;
  }

  private async reconcileLinkedParents(metadata: NormalizedSocketMetadata[]): Promise<void> {
    const listLinkedGroupIds = this.socket.listLinkedGroupIds;
    if (!listLinkedGroupIds) return;
    const byId = new Map(metadata.map((entry) => [entry.id, entry] as const));
    const discoveredParents = new Map<RelayConversationId, RelayConversationId>();
    const linkedByCommunity = await Promise.all(
      metadata
        .filter((entry) => entry.kind === "community")
        .map(async (community) => ({
          community,
          linkedIds: await listLinkedGroupIds.call(this.socket, community.id),
        })),
    );

    for (const { community, linkedIds } of linkedByCommunity) {
      for (const rawLinkedId of linkedIds) {
        const linkedId = parseRelayConversationId(rawLinkedId);
        const group = byId.get(linkedId);
        if (!group) continue;
        if (group.kind !== "group") {
          throw new WhatsAppGroupRelationshipError(
            "community linked-group metadata references another community",
          );
        }
        const discoveredParent = discoveredParents.get(linkedId);
        if (discoveredParent && discoveredParent !== community.id) {
          throw new WhatsAppGroupRelationshipError("group is listed under more than one community");
        }
        if (group.declaredParentCommunityId && group.declaredParentCommunityId !== community.id) {
          throw new WhatsAppGroupRelationshipError(
            "group metadata and community linked-group metadata disagree",
          );
        }
        discoveredParents.set(linkedId, community.id);
        group.parentCommunityId = community.id;
      }
    }

    for (const entry of metadata) {
      if (entry.kind !== "group" || !entry.declaredParentCommunityId) continue;
      if (discoveredParents.get(entry.id) !== entry.declaredParentCommunityId) {
        throw new WhatsAppGroupRelationshipError(
          "group metadata names a parent that does not list the group",
        );
      }
    }
  }

  private toManagedConversation(metadata: NormalizedSocketMetadata): WhatsAppManagedConversation {
    const ref =
      metadata.kind === "community"
        ? createWhatsAppCommunityRef(this.scope, metadata.id)
        : createWhatsAppGroupRef(this.scope, metadata.id);
    const parentCommunityRef = metadata.parentCommunityId
      ? createWhatsAppCommunityRef(this.scope, metadata.parentCommunityId)
      : undefined;
    return {
      ref,
      title: metadata.title,
      parentCommunityRef,
      participants: metadata.participantIds.map((participantId) =>
        createWhatsAppParticipantRef(this.scope, participantId),
      ),
    };
  }

  private participantIds(
    participants: readonly WhatsAppParticipantRef[],
    operation: string,
  ): readonly WhatsAppParticipantId[] {
    const unique = new Set<WhatsAppParticipantId>();
    for (const participant of participants) {
      this.assertParticipantScope(participant, operation);
      unique.add(participant.participantId);
    }
    return [...unique];
  }

  private supportsCapability(capability: WhatsAppGroupCapability): boolean {
    switch (capability) {
      case "create-community":
        return this.socket.createCommunity !== undefined;
      case "create-group":
        return (
          this.socket.createGroup !== undefined || this.socket.createCommunityGroup !== undefined
        );
      case "rename-conversation":
        return this.socket.renameConversation !== undefined;
      case "manage-participants":
        return this.socket.updateParticipants !== undefined;
      case "list-community-groups":
        return this.socket.listLinkedGroupIds !== undefined;
      case "link-group":
        return this.socket.linkGroup !== undefined;
      case "unlink-group":
        return this.socket.unlinkGroup !== undefined;
      case "revoke-invite":
        return this.socket.revokeInvite !== undefined;
      case "leave-conversation":
        return this.socket.leaveConversation !== undefined;
      case "send-notice":
        return this.socket.sendText !== undefined;
    }
    throw new Error("Unknown WhatsApp group capability");
  }

  private assertAccount(accountId: RelayAccountId, operation: string): void {
    if (accountId !== this.scope.accountId) throw new WhatsAppGroupScopeError(operation);
  }

  private assertAddressScope(address: RelayAddress, operation: string): void {
    if (
      address.providerId !== this.scope.providerId ||
      address.accountId !== this.scope.accountId
    ) {
      throw new WhatsAppGroupScopeError(operation);
    }
  }

  private assertRefScope(ref: WhatsAppConversationRef, operation: string): void {
    this.assertAddressScope(ref, operation);
  }

  private assertParticipantScope(participant: WhatsAppParticipantRef, operation: string): void {
    if (
      participant.providerId !== this.scope.providerId ||
      participant.accountId !== this.scope.accountId
    ) {
      throw new WhatsAppGroupScopeError(operation);
    }
  }
}

export function createWhatsAppGroupRef(
  scope: WhatsAppGroupScope,
  conversationId: unknown,
): WhatsAppGroupRef {
  return {
    ...scope,
    conversationId: parseRelayConversationId(conversationId),
    kind: "group",
  };
}

export function createWhatsAppCommunityRef(
  scope: WhatsAppGroupScope,
  conversationId: unknown,
): WhatsAppCommunityRef {
  return {
    ...scope,
    conversationId: parseRelayConversationId(conversationId),
    kind: "community",
  };
}

export function parseWhatsAppParticipantId(value: unknown): WhatsAppParticipantId {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("WhatsApp participant ID must be a non-empty, trimmed string");
  }
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime validation establishes the branded identifier invariant
  return value as WhatsAppParticipantId;
}

export function createWhatsAppParticipantRef(
  scope: WhatsAppGroupScope,
  participantId: unknown,
): WhatsAppParticipantRef {
  return {
    ...scope,
    participantId: parseWhatsAppParticipantId(participantId),
  };
}

function normalizeSocketMetadata(metadata: WhatsAppGroupSocketMetadata): NormalizedSocketMetadata {
  const parentCommunityId =
    metadata.parentCommunityId === undefined
      ? undefined
      : parseRelayConversationId(metadata.parentCommunityId);
  return {
    id: parseRelayConversationId(metadata.id),
    kind: metadata.kind,
    title: requireWhatsAppTitle("provider conversation title", metadata.title),
    declaredParentCommunityId: parentCommunityId,
    parentCommunityId,
    participantIds: (metadata.participantIds ?? []).map(parseWhatsAppParticipantId),
  };
}

function toRelayConversation(conversation: WhatsAppManagedConversation): RelayConversation {
  return {
    address: {
      providerId: conversation.ref.providerId,
      accountId: conversation.ref.accountId,
      conversationId: conversation.ref.conversationId,
    },
    kind: conversation.ref.kind,
    displayName: conversation.title,
    parentConversationId: conversation.parentCommunityRef?.conversationId,
  };
}

function requireWhatsAppTitle(label: string, value: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty, trimmed string`);
  }
  return value;
}

function requireWhatsAppText(label: string, value: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${label} must contain non-whitespace text`);
  }
  return value;
}
