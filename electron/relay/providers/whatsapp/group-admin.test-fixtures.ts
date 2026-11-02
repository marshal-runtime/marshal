import {
  parseRelayAccountId,
  parseRelayProviderId,
  type RelayConversationId,
} from "../../../../common/relay-contract";
import {
  createWhatsAppCommunityRef,
  createWhatsAppGroupRef,
  type WhatsAppGroupCapability,
  type WhatsAppGroupMappingPort,
  type WhatsAppGroupScope,
  type WhatsAppGroupSocketMetadata,
  type WhatsAppGroupSocketPort,
  type WhatsAppGroupTombstone,
  type WhatsAppManagedConversationMapping,
  type WhatsAppManagedConversationRole,
  type WhatsAppParticipantAction,
  type WhatsAppParticipantId,
} from "./group-admin";

export const TEST_WHATSAPP_SCOPE: WhatsAppGroupScope = {
  providerId: parseRelayProviderId("whatsapp"),
  accountId: parseRelayAccountId("whatsapp-test-account"),
};

export interface WhatsAppGroupFixtureSeed {
  readonly id: string;
  readonly kind: "group" | "community";
  readonly title: string;
  readonly parentCommunityId?: string;
  readonly participantIds?: readonly string[];
  readonly includeInParentLinks?: boolean;
}

export interface WhatsAppGroupFixtureOptions {
  readonly disabledCapabilities?: readonly WhatsAppGroupCapability[];
  readonly directCommunityGroupCreation?: boolean;
  readonly operationLog?: string[];
}

interface MutableMetadata {
  readonly id: string;
  readonly kind: "group" | "community";
  title: string;
  parentCommunityId?: string;
  participantIds: string[];
}

interface DeferredSignal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface MappingSetPause {
  readonly entered: DeferredSignal;
  readonly release: DeferredSignal;
}

export class WhatsAppGroupSocketFixture {
  readonly operations: string[];
  readonly socket: WhatsAppGroupSocketPort;

  private readonly metadata = new Map<string, MutableMetadata>();
  private readonly links = new Map<string, Set<string>>();
  private nextCommunityId = 1;
  private nextGroupId = 1;
  private failingMetadataReads = 0;
  private failMetadataReadAfterRename = false;
  private failingLeaves = 0;

  constructor(options: WhatsAppGroupFixtureOptions = {}) {
    this.operations = options.operationLog ?? [];
    const disabled = new Set(options.disabledCapabilities ?? []);
    const directCommunityGroupCreation = options.directCommunityGroupCreation ?? true;

    this.socket = {
      listGroupMetadata: async () => this.listMetadata(),
      ...(!disabled.has("create-community") && {
        createCommunity: async (title: string) => this.createCommunity(title),
      }),
      ...(!disabled.has("create-group") && {
        createGroup: async (title: string, participantIds: readonly WhatsAppParticipantId[]) =>
          this.createGroup(title, participantIds),
      }),
      ...(!disabled.has("create-group") &&
        directCommunityGroupCreation && {
          createCommunityGroup: async (
            communityId: RelayConversationId,
            title: string,
            participantIds: readonly WhatsAppParticipantId[],
          ) => this.createCommunityGroup(communityId, title, participantIds),
        }),
      ...(!disabled.has("rename-conversation") && {
        renameConversation: async (conversationId: RelayConversationId, title: string) =>
          this.renameConversation(conversationId, title),
      }),
      ...(!disabled.has("manage-participants") && {
        updateParticipants: async (
          groupId: RelayConversationId,
          participantIds: readonly WhatsAppParticipantId[],
          action: WhatsAppParticipantAction,
        ) => this.updateParticipants(groupId, participantIds, action),
      }),
      ...(!disabled.has("list-community-groups") && {
        listLinkedGroupIds: async (communityId: RelayConversationId) => [
          ...(this.links.get(communityId) ?? []),
        ],
      }),
      ...(!disabled.has("link-group") && {
        linkGroup: async (communityId: RelayConversationId, groupId: RelayConversationId) =>
          this.linkGroup(communityId, groupId),
      }),
      ...(!disabled.has("unlink-group") && {
        unlinkGroup: async (communityId: RelayConversationId, groupId: RelayConversationId) =>
          this.unlinkGroup(communityId, groupId),
      }),
      ...(!disabled.has("revoke-invite") && {
        revokeInvite: async (groupId: RelayConversationId) => {
          this.requireMetadata(groupId, "group");
          this.operations.push(`revoke-invite:${groupId}`);
        },
      }),
      ...(!disabled.has("leave-conversation") && {
        leaveConversation: async (conversationId: RelayConversationId) =>
          this.leaveConversation(conversationId),
      }),
      ...(!disabled.has("send-notice") && {
        sendText: async (conversationId: RelayConversationId, text: string) => {
          this.requireMetadata(conversationId);
          this.operations.push(`send-notice:${conversationId}:${text}`);
        },
      }),
    };
  }

  seed(seed: WhatsAppGroupFixtureSeed): void {
    if (this.metadata.has(seed.id)) throw new Error(`Duplicate fixture conversation ${seed.id}`);
    const entry: MutableMetadata = {
      id: seed.id,
      kind: seed.kind,
      title: seed.title,
      parentCommunityId: seed.parentCommunityId,
      participantIds: [...(seed.participantIds ?? [])],
    };
    this.metadata.set(seed.id, entry);
    if (seed.kind === "group" && seed.parentCommunityId && seed.includeInParentLinks !== false) {
      this.requireMetadata(seed.parentCommunityId, "community");
      this.linkSet(seed.parentCommunityId).add(seed.id);
    }
  }

  setLinked(communityId: string, groupId: string, linked: boolean): void {
    this.requireMetadata(communityId, "community");
    this.requireMetadata(groupId, "group");
    if (linked) {
      this.linkSet(communityId).add(groupId);
    } else {
      this.links.get(communityId)?.delete(groupId);
    }
  }

  get(id: string): WhatsAppGroupSocketMetadata | undefined {
    const entry = this.metadata.get(id);
    return entry ? cloneMetadata(entry) : undefined;
  }

  countByTitle(title: string): number {
    return [...this.metadata.values()].filter((entry) => entry.title === title).length;
  }

  findByTitle(title: string): readonly WhatsAppGroupSocketMetadata[] {
    return [...this.metadata.values()].filter((entry) => entry.title === title).map(cloneMetadata);
  }

  linkedGroupIds(communityId: string): readonly string[] {
    return [...(this.links.get(communityId) ?? [])];
  }

  failNextMetadataReadAfterRename(): void {
    this.failMetadataReadAfterRename = true;
  }

  failNextLeave(count = 1): void {
    this.failingLeaves = count;
  }

  private listMetadata(): readonly WhatsAppGroupSocketMetadata[] {
    if (this.failingMetadataReads > 0) {
      this.failingMetadataReads -= 1;
      throw new Error("Forced metadata read failure");
    }
    return [...this.metadata.values()].map(cloneMetadata);
  }

  private createCommunity(title: string): { readonly id: string } {
    const id = `community-${this.nextCommunityId++}`;
    this.metadata.set(id, {
      id,
      kind: "community",
      title,
      participantIds: [],
    });
    this.operations.push(`create-community:${id}:${title}`);
    return { id };
  }

  private createGroup(
    title: string,
    participantIds: readonly WhatsAppParticipantId[],
  ): { readonly id: string } {
    const id = `group-${this.nextGroupId++}`;
    this.metadata.set(id, {
      id,
      kind: "group",
      title,
      participantIds: [...participantIds],
    });
    this.operations.push(`create-group:${id}:${title}`);
    return { id };
  }

  private createCommunityGroup(
    communityId: RelayConversationId,
    title: string,
    participantIds: readonly WhatsAppParticipantId[],
  ): { readonly id: string } {
    this.requireMetadata(communityId, "community");
    const created = this.createGroup(title, participantIds);
    const group = this.requireMetadata(created.id, "group");
    group.parentCommunityId = communityId;
    this.linkSet(communityId).add(created.id);
    this.operations[this.operations.length - 1] =
      `create-community-group:${communityId}:${created.id}:${title}`;
    return created;
  }

  private renameConversation(conversationId: RelayConversationId, title: string): void {
    const entry = this.requireMetadata(conversationId);
    entry.title = title;
    this.operations.push(`rename:${conversationId}:${title}`);
    if (this.failMetadataReadAfterRename) {
      this.failMetadataReadAfterRename = false;
      this.failingMetadataReads += 1;
    }
  }

  private updateParticipants(
    groupId: RelayConversationId,
    participantIds: readonly WhatsAppParticipantId[],
    action: WhatsAppParticipantAction,
  ): void {
    const group = this.requireMetadata(groupId, "group");
    const participants = new Set(group.participantIds);
    for (const participantId of participantIds) {
      if (action === "add") {
        participants.add(participantId);
      } else {
        participants.delete(participantId);
      }
    }
    group.participantIds = [...participants];
    this.operations.push(`${action}-participants:${groupId}:${participantIds.join(",")}`);
  }

  private linkGroup(communityId: RelayConversationId, groupId: RelayConversationId): void {
    this.requireMetadata(communityId, "community");
    const group = this.requireMetadata(groupId, "group");
    if (group.parentCommunityId && group.parentCommunityId !== communityId) {
      throw new Error("Fixture group is already linked to another community");
    }
    group.parentCommunityId = communityId;
    this.linkSet(communityId).add(groupId);
    this.operations.push(`link:${communityId}:${groupId}`);
  }

  private unlinkGroup(communityId: RelayConversationId, groupId: RelayConversationId): void {
    const group = this.requireMetadata(groupId, "group");
    if (group.parentCommunityId === communityId) delete group.parentCommunityId;
    this.links.get(communityId)?.delete(groupId);
    this.operations.push(`unlink:${communityId}:${groupId}`);
  }

  private leaveConversation(conversationId: RelayConversationId): void {
    if (this.failingLeaves > 0) {
      this.failingLeaves -= 1;
      throw new Error("Forced leave failure");
    }
    const entry = this.requireMetadata(conversationId);
    this.metadata.delete(conversationId);
    this.links.delete(conversationId);
    for (const linkedGroups of this.links.values()) linkedGroups.delete(conversationId);
    if (entry.kind === "community") {
      for (const candidate of this.metadata.values()) {
        if (candidate.parentCommunityId === conversationId) delete candidate.parentCommunityId;
      }
    }
    this.operations.push(`leave:${conversationId}`);
  }

  private requireMetadata(id: string, expectedKind?: "group" | "community"): MutableMetadata {
    const entry = this.metadata.get(id);
    if (!entry) throw new Error(`Missing fixture conversation ${id}`);
    if (expectedKind && entry.kind !== expectedKind) {
      throw new Error(`Expected fixture ${id} to be a ${expectedKind}`);
    }
    return entry;
  }

  private linkSet(communityId: string): Set<string> {
    const existing = this.links.get(communityId);
    if (existing) return existing;
    const created = new Set<string>();
    this.links.set(communityId, created);
    return created;
  }
}

export class InMemoryWhatsAppGroupMappingPort implements WhatsAppGroupMappingPort {
  readonly tombstones: WhatsAppGroupTombstone[] = [];

  private readonly records = new Map<string, WhatsAppManagedConversationMapping>();
  private readonly pendingRetirements = new Map<string, WhatsAppGroupTombstone>();
  private readonly failingSets = new Map<WhatsAppManagedConversationRole, number>();
  private readonly exclusiveRuns = new Map<string, Promise<void>>();
  private readonly setPauses = new Map<WhatsAppManagedConversationRole, MappingSetPause>();
  private failingTombstones = 0;

  constructor(private readonly operationLog: string[] = []) {}

  async get(
    scope: WhatsAppGroupScope,
    role: WhatsAppManagedConversationRole,
  ): Promise<WhatsAppManagedConversationMapping | undefined> {
    return this.records.get(mappingKey(scope, role));
  }

  async findByConversation(
    scope: WhatsAppGroupScope,
    conversationId: RelayConversationId,
  ): Promise<WhatsAppManagedConversationMapping | undefined> {
    const matches = [...this.records.values()].filter(
      (mapping) =>
        mapping.ref.providerId === scope.providerId &&
        mapping.ref.accountId === scope.accountId &&
        mapping.ref.conversationId === conversationId,
    );
    if (matches.length > 1) {
      throw new Error(`Multiple mappings own fixture conversation ${conversationId}`);
    }
    return matches[0];
  }

  async getPendingRetirement(
    scope: WhatsAppGroupScope,
    conversationId: RelayConversationId,
  ): Promise<WhatsAppGroupTombstone | undefined> {
    return this.pendingRetirements.get(retirementKey(scope, conversationId));
  }

  async prepareRetirement(tombstone: WhatsAppGroupTombstone): Promise<void> {
    const key = retirementKey(tombstone.ref, tombstone.ref.conversationId);
    const existing = this.pendingRetirements.get(key);
    if (existing && existing.ref.kind !== tombstone.ref.kind) {
      throw new Error("Conflicting fixture retirement intent");
    }
    this.pendingRetirements.set(key, tombstone);
  }

  async set(mapping: WhatsAppManagedConversationMapping): Promise<void> {
    const pause = this.setPauses.get(mapping.role);
    if (pause) {
      this.setPauses.delete(mapping.role);
      pause.entered.resolve();
      await pause.release.promise;
    }
    const failuresRemaining = this.failingSets.get(mapping.role) ?? 0;
    if (failuresRemaining > 0) {
      this.failingSets.set(mapping.role, failuresRemaining - 1);
      throw new Error(`Forced mapping failure for ${mapping.role}`);
    }
    this.records.set(mappingKey(mapping.ref, mapping.role), mapping);
    this.operationLog.push(`mapping-set:${mapping.role}:${mapping.ref.conversationId}`);
  }

  async tombstone(tombstone: WhatsAppGroupTombstone): Promise<void> {
    if (this.failingTombstones > 0) {
      this.failingTombstones -= 1;
      throw new Error("Forced tombstone failure");
    }
    for (const [key, mapping] of this.records) {
      if (
        mapping.ref.providerId === tombstone.ref.providerId &&
        mapping.ref.accountId === tombstone.ref.accountId &&
        mapping.ref.conversationId === tombstone.ref.conversationId
      ) {
        this.records.delete(key);
      }
    }
    this.tombstones.push(tombstone);
    this.pendingRetirements.delete(retirementKey(tombstone.ref, tombstone.ref.conversationId));
    this.operationLog.push(`tombstone:${tombstone.ref.conversationId}`);
  }

  async runExclusive<T>(scope: WhatsAppGroupScope, operation: () => Promise<T>): Promise<T> {
    const key = scopeKey(scope);
    const previous = this.exclusiveRuns.get(key) ?? Promise.resolve();
    const run = previous.then(operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.exclusiveRuns.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.exclusiveRuns.get(key) === settled) this.exclusiveRuns.delete(key);
    }
  }

  seed(mapping: WhatsAppManagedConversationMapping): void {
    this.records.set(mappingKey(mapping.ref, mapping.role), mapping);
  }

  failNextSet(role: WhatsAppManagedConversationRole, count = 1): void {
    this.failingSets.set(role, count);
  }

  pauseNextSet(role: WhatsAppManagedConversationRole): {
    readonly entered: Promise<void>;
    readonly release: () => void;
  } {
    const pause = {
      entered: createDeferredSignal(),
      release: createDeferredSignal(),
    };
    this.setPauses.set(role, pause);
    return {
      entered: pause.entered.promise,
      release: pause.release.resolve,
    };
  }

  failNextTombstone(count = 1): void {
    this.failingTombstones = count;
  }

  list(scope: WhatsAppGroupScope): readonly WhatsAppManagedConversationMapping[] {
    return [...this.records.values()].filter(
      (mapping) =>
        mapping.ref.providerId === scope.providerId && mapping.ref.accountId === scope.accountId,
    );
  }

  async listPendingRetirements(
    scope: WhatsAppGroupScope,
  ): Promise<readonly WhatsAppGroupTombstone[]> {
    return [...this.pendingRetirements.values()].filter(
      (tombstone) =>
        tombstone.ref.providerId === scope.providerId &&
        tombstone.ref.accountId === scope.accountId,
    );
  }
}

export function communityMapping(
  id: string,
  title: string,
  scope: WhatsAppGroupScope = TEST_WHATSAPP_SCOPE,
): WhatsAppManagedConversationMapping {
  return {
    role: "community",
    title,
    ref: createWhatsAppCommunityRef(scope, id),
  };
}

export function groupMapping(
  role: Exclude<WhatsAppManagedConversationRole, "community">,
  id: string,
  title: string,
  parentCommunityId: string,
  scope: WhatsAppGroupScope = TEST_WHATSAPP_SCOPE,
): WhatsAppManagedConversationMapping {
  return {
    role,
    title,
    ref: createWhatsAppGroupRef(scope, id),
    parentCommunityRef: createWhatsAppCommunityRef(scope, parentCommunityId),
  };
}

function cloneMetadata(metadata: MutableMetadata): WhatsAppGroupSocketMetadata {
  return {
    id: metadata.id,
    kind: metadata.kind,
    title: metadata.title,
    parentCommunityId: metadata.parentCommunityId,
    participantIds: [...metadata.participantIds],
  };
}

function mappingKey(scope: WhatsAppGroupScope, role: WhatsAppManagedConversationRole): string {
  return JSON.stringify([scope.providerId, scope.accountId, role]);
}

function scopeKey(scope: WhatsAppGroupScope): string {
  return JSON.stringify([scope.providerId, scope.accountId]);
}

function retirementKey(scope: WhatsAppGroupScope, conversationId: RelayConversationId): string {
  return JSON.stringify([scope.providerId, scope.accountId, conversationId]);
}

function createDeferredSignal(): DeferredSignal {
  let resolvePromise = (): void => {
    throw new Error("Deferred signal was not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
