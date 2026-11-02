import {
  parseRelayAccountId,
  parseRelayProviderId,
  type RelayConversationId,
} from "../../../../../common/relay-contract";
import {
  MARSHAL_WHATSAPP_FIXED_GROUPS,
  WhatsAppCommunityProvisioner,
  WhatsAppProvisioningAmbiguityError,
  type MarshalWhatsAppCommunityProvisioning,
} from "../community-provisioner";
import {
  createWhatsAppCommunityRef,
  createWhatsAppGroupRef,
  WhatsAppGroupAdministration,
  WhatsAppGroupNotFoundError,
  WhatsAppGroupRelationshipError,
  type WhatsAppConversationRef,
  type WhatsAppGroupMappingPort,
  type WhatsAppGroupScope,
  type WhatsAppGroupSocketMetadata,
  type WhatsAppGroupSocketPort,
  type WhatsAppGroupTombstone,
  type WhatsAppManagedConversationMapping,
  type WhatsAppManagedConversationRole,
} from "../group-admin";
import type { WhatsAppSidecarAuthStorePort } from "./auth-port";
import type { WhatsAppManagedFixedGroupRole } from "./protocol";

export const WHATSAPP_MANAGED_GROUP_MAPPING_CATEGORY = "marshal-managed-groups-v1";
const MAPPING_CATEGORY = WHATSAPP_MANAGED_GROUP_MAPPING_CATEGORY;
const TOMBSTONE_CATEGORY = "marshal-managed-group-retirements-v1";
const TOMBSTONE_INDEX_ID = "index";
const MANAGED_ROLES = [
  "community",
  ...MARSHAL_WHATSAPP_FIXED_GROUPS.map((group) => group.role),
] as const satisfies readonly WhatsAppManagedConversationRole[];
const MANAGED_FIXED_ROLES = [
  "new-chats",
  "progress",
  "information-control",
] as const satisfies readonly WhatsAppManagedFixedGroupRole[];

const SCOPE: WhatsAppGroupScope = {
  providerId: parseRelayProviderId("whatsapp-baileys"),
  accountId: parseRelayAccountId("primary"),
};

export interface ManagedGroupMetadata {
  id: string;
  subject: string;
  participants: readonly { id: string }[];
  owner?: string;
  creation?: number;
  size?: number;
  linkedParent?: string;
  isCommunity?: boolean;
  isCommunityAnnounce?: boolean;
}

export interface ManagedGroupSocket {
  groupFetchAllParticipating(): Promise<Record<string, ManagedGroupMetadata>>;
  communityFetchAllParticipating?(): Promise<Record<string, ManagedGroupMetadata>>;
  groupMetadata(jid: string): Promise<ManagedGroupMetadata>;
  communityMetadata(jid: string): Promise<ManagedGroupMetadata>;
  communityCreate(subject: string, body: string): Promise<ManagedGroupMetadata | null>;
  communityCreateGroup(
    subject: string,
    participants: string[],
    parentCommunityJid: string,
  ): Promise<ManagedGroupMetadata | null>;
  groupCreate(subject: string, participants: string[]): Promise<ManagedGroupMetadata>;
  communityFetchLinkedGroups(communityJid: string): Promise<{
    communityJid: string;
    isCommunity: boolean;
    linkedGroups: readonly {
      id?: string;
      subject: string;
      creation?: number;
      owner?: string;
      size?: number;
    }[];
  }>;
  communityLinkGroup(groupJid: string, parentCommunityJid: string): Promise<void>;
  communityUnlinkGroup(groupJid: string, parentCommunityJid: string): Promise<void>;
  communityUpdateSubject(jid: string, subject: string): Promise<void>;
  groupUpdateSubject(jid: string, subject: string): Promise<void>;
  groupParticipantsUpdate(
    jid: string,
    participants: string[],
    action: "add" | "remove",
  ): Promise<unknown>;
  groupRevokeInvite(jid: string): Promise<unknown>;
  communityLeave(jid: string): Promise<void>;
  groupLeave(jid: string): Promise<void>;
  sendMessage(jid: string, content: { text: string }): Promise<unknown>;
}

export interface WhatsAppRemoteTopologyEntry {
  readonly id: string;
  readonly subject: string;
  readonly kind: "community" | "group";
  readonly parentCommunityId?: string;
}

export interface WhatsAppRemoteTopologySnapshot {
  readonly community: {
    readonly mappedId?: string;
    readonly remote?: WhatsAppRemoteTopologyEntry;
  };
  readonly groups: Readonly<
    Record<
      (typeof MARSHAL_WHATSAPP_FIXED_GROUPS)[number]["role"],
      {
        readonly mappedId?: string;
        readonly remote?: WhatsAppRemoteTopologyEntry;
        readonly linkedFromCommunity: boolean;
      }
    >
  >;
  readonly linkedGroupIds: readonly string[];
  readonly exactTitleCandidates: readonly WhatsAppRemoteTopologyEntry[];
  readonly remoteCommunities: readonly WhatsAppRemoteTopologyEntry[];
  readonly remoteGroups: readonly WhatsAppRemoteTopologyEntry[];
  readonly communityQueryError?: string;
}

class WhatsAppGroupProvisioningOperationError extends Error {
  constructor(
    readonly operation: string,
    readonly statusCode: number | undefined,
    options: ErrorOptions,
  ) {
    super("WhatsApp managed-group operation failed", options);
    this.name = "WhatsAppGroupProvisioningOperationError";
  }
}

export function describeWhatsAppGroupProvisioningError(error: unknown): string {
  if (error instanceof WhatsAppGroupProvisioningOperationError) {
    return `WhatsApp managed-group provisioning failed during ${error.operation}${
      error.statusCode === undefined ? "" : ` (status ${error.statusCode})`
    }${
      error.cause instanceof Error
        ? `: ${sanitizeDiagnostic(error.cause.message)}`
        : ""
    }.`;
  }
  if (error instanceof WhatsAppProvisioningAmbiguityError) {
    return `WhatsApp managed-group provisioning found ${error.candidateCount} ambiguous ${error.role} candidates.`;
  }
  if (error instanceof WhatsAppGroupNotFoundError) {
    return "WhatsApp managed-group provisioning could not observe a newly created conversation.";
  }
  if (error instanceof WhatsAppGroupRelationshipError) {
    return `WhatsApp managed-group provisioning rejected the topology: ${sanitizeDiagnostic(
      error.detail,
    )}.`;
  }
  return error instanceof Error
    ? `WhatsApp managed-group provisioning failed during topology validation (${error.name}: ${sanitizeDiagnostic(
        error.message,
      )}).`
    : "WhatsApp managed-group provisioning failed during topology validation (unknown error).";
}

export async function provisionMarshalWhatsAppGroups(
  socket: ManagedGroupSocket,
  authStore: WhatsAppSidecarAuthStorePort,
): Promise<MarshalWhatsAppCommunityProvisioning> {
  const mappings = new EncryptedAuthGroupMappingStore(authStore);
  const before = await inspectMarshalWhatsAppTopology(socket, authStore);
  const invalidRoles = findInvalidMappingRoles(before);
  await mappings.deleteRoles(
    invalidRoles.includes("community") ? MANAGED_ROLES : invalidRoles,
  );
  const stagedMappings = new DeferredWhatsAppGroupMappingPort(mappings);
  if (!(await mappings.get(SCOPE, "community"))) {
    const recoverable = findRecoverableCommunity(before.remoteCommunities);
    if (recoverable) {
      await stagedMappings.set({
        role: "community",
        title: "Marshal Community",
        ref: createWhatsAppCommunityRef(SCOPE, recoverable.id),
      });
    }
  }
  const administration = new WhatsAppGroupAdministration({
    scope: SCOPE,
    socket: createBaileysGroupSocketPort(socket),
    mappings: stagedMappings,
  });
  const result = await new WhatsAppCommunityProvisioner({
    administration,
    mappings: stagedMappings,
  }).provision();
  await waitForRemoteConvergence(socket, result);
  await stagedMappings.commit();
  return result;
}

export async function inspectMarshalWhatsAppTopology(
  socket: ManagedGroupSocket,
  authStore: WhatsAppSidecarAuthStorePort,
): Promise<WhatsAppRemoteTopologySnapshot> {
  const mappings = new EncryptedAuthGroupMappingStore(authStore);
  const mapped = new Map(
    await Promise.all(
      MANAGED_ROLES.map(async (role) => [role, await mappings.get(SCOPE, role)] as const),
    ),
  );
  const communityMapping = mapped.get("community");
  const needsDiscovery =
    communityMapping?.ref.kind !== "community" ||
    MARSHAL_WHATSAPP_FIXED_GROUPS.some(({ role }) => mapped.get(role)?.ref.kind !== "group");
  const remote: Awaited<ReturnType<typeof readRemoteTopology>> = needsDiscovery
    ? await readRemoteTopology(socket)
    : { communities: [], groups: [] };
  const communityId =
    communityMapping?.ref.kind === "community"
      ? communityMapping.ref.conversationId
      : findExactTitle(remote.communities, "Marshal Community")?.id;
  const communityRemote = communityId
    ? await readRemoteEntry(socket, "community", communityId, remote.communities)
    : undefined;
  const linkedGroupIds = communityRemote
    ? await readLinkedGroupIds(socket, communityRemote.id)
    : [];
  const groups = Object.fromEntries(
    await Promise.all(
      MARSHAL_WHATSAPP_FIXED_GROUPS.map(async ({ role, title }) => {
        const mapping = mapped.get(role);
        const mappedId = mapping?.ref.kind === "group" ? mapping.ref.conversationId : undefined;
        const remoteEntry = mappedId
          ? await readRemoteEntry(socket, "group", mappedId, remote.groups)
          : findExactTitle(remote.groups, title);
        return [
          role,
          {
            ...(mappedId ? { mappedId } : {}),
            ...(remoteEntry ? { remote: remoteEntry } : {}),
            linkedFromCommunity: remoteEntry ? linkedGroupIds.includes(remoteEntry.id) : false,
          },
        ] as const;
      }),
    ),
  ) as WhatsAppRemoteTopologySnapshot["groups"];
  const fixedTitles = new Set([
    "Marshal Community",
    ...MARSHAL_WHATSAPP_FIXED_GROUPS.map(({ title }) => title),
  ]);
  return {
    community: {
      ...(communityMapping?.ref.kind === "community"
        ? { mappedId: communityMapping.ref.conversationId }
        : {}),
      ...(communityRemote ? { remote: communityRemote } : {}),
    },
    groups,
    linkedGroupIds,
    exactTitleCandidates: [...remote.communities, ...remote.groups].filter((entry) =>
      fixedTitles.has(entry.subject),
    ),
    remoteCommunities: remote.communities,
    remoteGroups: remote.groups,
    ...(remote.communityQueryError
      ? { communityQueryError: remote.communityQueryError }
      : {}),
  };
}

export async function readManagedFixedGroupIds(
  authStore: WhatsAppSidecarAuthStorePort,
): Promise<ReadonlyMap<WhatsAppManagedFixedGroupRole, string>> {
  const stored = await authStore.readSignalKeys(MAPPING_CATEGORY, MANAGED_FIXED_ROLES);
  const result = new Map<WhatsAppManagedFixedGroupRole, string>();
  for (const role of MANAGED_FIXED_ROLES) {
    const value = stored[role];
    if (value === undefined) continue;
    const mapping = parseMapping(value, SCOPE, role);
    if (mapping.ref.kind !== "group") {
      throw new Error(`Stored WhatsApp mapping for ${role} is not a group`);
    }
    result.set(role, mapping.ref.conversationId);
  }
  return result;
}

export class EncryptedAuthGroupMappingStore implements WhatsAppGroupMappingPort {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly authStore: WhatsAppSidecarAuthStorePort) {}

  async get(
    scope: WhatsAppGroupScope,
    role: WhatsAppManagedConversationRole,
  ): Promise<WhatsAppManagedConversationMapping | undefined> {
    assertScope(scope);
    const stored = (await this.authStore.readSignalKeys(MAPPING_CATEGORY, [role]))[role];
    return stored === undefined ? undefined : parseMapping(stored, scope, role);
  }

  async findByConversation(
    scope: WhatsAppGroupScope,
    conversationId: RelayConversationId,
  ): Promise<WhatsAppManagedConversationMapping | undefined> {
    assertScope(scope);
    const stored = await this.authStore.readSignalKeys(MAPPING_CATEGORY, MANAGED_ROLES);
    for (const role of MANAGED_ROLES) {
      const candidate = stored[role];
      if (candidate === undefined) continue;
      const mapping = parseMapping(candidate, scope, role);
      if (mapping.ref.conversationId === conversationId) return mapping;
    }
    return undefined;
  }

  async getPendingRetirement(
    scope: WhatsAppGroupScope,
    conversationId: RelayConversationId,
  ): Promise<WhatsAppGroupTombstone | undefined> {
    assertScope(scope);
    const stored = (await this.authStore.readSignalKeys(TOMBSTONE_CATEGORY, [conversationId]))[
      conversationId
    ];
    return stored === undefined ? undefined : parseTombstone(stored, scope, conversationId);
  }

  async listPendingRetirements(
    scope: WhatsAppGroupScope,
  ): Promise<readonly WhatsAppGroupTombstone[]> {
    assertScope(scope);
    const indexValue = (
      await this.authStore.readSignalKeys(TOMBSTONE_CATEGORY, [TOMBSTONE_INDEX_ID])
    )[TOMBSTONE_INDEX_ID];
    const ids = parseTombstoneIndex(indexValue);
    if (ids.length === 0) return [];
    const stored = await this.authStore.readSignalKeys(TOMBSTONE_CATEGORY, ids);
    return ids.flatMap((id) => {
      const value = stored[id];
      return value === undefined ? [] : [parseTombstone(value, scope, id)];
    });
  }

  async prepareRetirement(tombstone: WhatsAppGroupTombstone): Promise<void> {
    await this.tombstone(tombstone);
  }

  async set(mapping: WhatsAppManagedConversationMapping): Promise<void> {
    assertScope(mapping.ref);
    if (mapping.parentCommunityRef) assertScope(mapping.parentCommunityRef);
    await this.authStore.applyTransaction({
      signalKeys: {
        [MAPPING_CATEGORY]: {
          [mapping.role]: serializeMapping(mapping),
        },
      },
    });
  }

  async deleteRoles(roles: readonly WhatsAppManagedConversationRole[]): Promise<void> {
    if (roles.length === 0) return;
    await this.authStore.applyTransaction({
      signalKeys: {
        [MAPPING_CATEGORY]: Object.fromEntries(roles.map((role) => [role, null])),
      },
    });
  }

  async tombstone(tombstone: WhatsAppGroupTombstone): Promise<void> {
    assertScope(tombstone.ref);
    const existing = await this.listPendingRetirements(SCOPE);
    const ids = new Set(existing.map((entry) => entry.ref.conversationId));
    ids.add(tombstone.ref.conversationId);
    await this.authStore.applyTransaction({
      signalKeys: {
        [TOMBSTONE_CATEGORY]: {
          [tombstone.ref.conversationId]: serializeTombstone(tombstone),
          [TOMBSTONE_INDEX_ID]: [...ids],
        },
      },
    });
  }

  runExclusive<T>(scope: WhatsAppGroupScope, operation: () => Promise<T>): Promise<T> {
    assertScope(scope);
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class DeferredWhatsAppGroupMappingPort implements WhatsAppGroupMappingPort {
  private readonly pendingMappings = new Map<
    WhatsAppManagedConversationRole,
    WhatsAppManagedConversationMapping
  >();

  constructor(private readonly persistent: EncryptedAuthGroupMappingStore) {}

  async get(scope: WhatsAppGroupScope, role: WhatsAppManagedConversationRole) {
    return this.pendingMappings.get(role) ?? this.persistent.get(scope, role);
  }

  async findByConversation(scope: WhatsAppGroupScope, conversationId: RelayConversationId) {
    for (const mapping of this.pendingMappings.values()) {
      if (mapping.ref.conversationId === conversationId) return mapping;
    }
    return this.persistent.findByConversation(scope, conversationId);
  }

  getPendingRetirement(scope: WhatsAppGroupScope, conversationId: RelayConversationId) {
    return this.persistent.getPendingRetirement(scope, conversationId);
  }

  listPendingRetirements(scope: WhatsAppGroupScope) {
    return this.persistent.listPendingRetirements(scope);
  }

  prepareRetirement(tombstone: WhatsAppGroupTombstone) {
    return this.persistent.prepareRetirement(tombstone);
  }

  async set(mapping: WhatsAppManagedConversationMapping): Promise<void> {
    this.pendingMappings.set(mapping.role, mapping);
  }

  tombstone(tombstone: WhatsAppGroupTombstone) {
    return this.persistent.tombstone(tombstone);
  }

  runExclusive<T>(scope: WhatsAppGroupScope, operation: () => Promise<T>): Promise<T> {
    return this.persistent.runExclusive(scope, operation);
  }

  async commit(): Promise<void> {
    for (const role of MANAGED_ROLES) {
      const mapping = this.pendingMappings.get(role);
      if (mapping) await this.persistent.set(mapping);
    }
  }
}

export function createBaileysGroupSocketPort(socket: ManagedGroupSocket): WhatsAppGroupSocketPort {
  const localMetadata = new Map<string, ManagedGroupMetadata>();
  const localLinkedGroups = new Map<string, Set<string>>();
  const cacheMetadata = (metadata: ManagedGroupMetadata): ManagedGroupMetadata => {
    const cached = localMetadata.get(metadata.id);
    const merged = {
      ...cached,
      ...metadata,
      participants: metadata.participants ?? cached?.participants ?? [],
      ...(metadata.linkedParent ?? cached?.linkedParent
        ? { linkedParent: metadata.linkedParent ?? cached?.linkedParent }
        : {}),
    };
    localMetadata.set(merged.id, merged);
    if (merged.linkedParent) {
      const linked = localLinkedGroups.get(merged.linkedParent) ?? new Set<string>();
      linked.add(merged.id);
      localLinkedGroups.set(merged.linkedParent, linked);
    }
    return merged;
  };
  const readMetadata = async () => {
    const participatingGroups = await runGroupOperation("list-groups", () =>
      socket.groupFetchAllParticipating(),
    );
    const participatingCommunities = socket.communityFetchAllParticipating
      ? await runGroupOperation("list-communities", () =>
          socket.communityFetchAllParticipating!(),
        )
      : {};
    for (const metadata of Object.values(participatingGroups)) {
      if (!metadata.isCommunityAnnounce && hasUsableIdentity(metadata)) {
        cacheMetadata(metadata);
      }
    }
    for (const metadata of Object.values(participatingCommunities)) {
      if (hasUsableIdentity(metadata)) {
        cacheMetadata({ ...metadata, isCommunity: true });
      }
    }
    return [...localMetadata.values()];
  };
  const findMetadata = async (conversationId: RelayConversationId) =>
    (await readMetadata()).find((metadata) => metadata.id === conversationId);

  return {
    listGroupMetadata: async () => (await readMetadata()).flatMap(toSocketMetadata),
    getConversationMetadata: async (conversationId, kind) => {
      const cached = localMetadata.get(conversationId);
      if (cached) {
        const normalized = toSocketMetadata(cached)[0];
        if (normalized) return normalized;
      }
      try {
        const metadata = await runGroupOperation(
          kind === "community" ? "get-community" : "get-group",
          () =>
            kind === "community"
              ? socket.communityMetadata(conversationId)
              : socket.groupMetadata(conversationId),
        );
        const normalized = toSocketMetadata(cacheMetadata(metadata))[0];
        return normalized;
      } catch (error) {
        if (extractStatusCode(error) === 404) return undefined;
        throw error;
      }
    },
    createCommunity: async (title) => {
      const created = await runGroupOperation("create-community", () =>
        socket.communityCreate(title, ""),
      );
      if (!created) throw new Error("WhatsApp did not return the created community");
      cacheMetadata({ ...created, isCommunity: true });
      return { id: created.id };
    },
    createGroup: async (title, participantIds) => {
      const created = await runGroupOperation("create-group", () =>
        socket.groupCreate(title, [...participantIds]),
      );
      cacheMetadata(created);
      return { id: created.id };
    },
    createCommunityGroup: async (communityId, title, participantIds) => {
      const created = await runGroupOperation("create-community-group", () =>
        socket.communityCreateGroup(title, [...participantIds], communityId),
      );
      if (!created) throw new Error("WhatsApp did not return the created community group");
      cacheMetadata({ ...created, linkedParent: communityId });
      return { id: created.id };
    },
    renameConversation: async (conversationId, title) => {
      const metadata = await findMetadata(conversationId);
      if (metadata?.isCommunity) {
        await runGroupOperation("rename-community", () =>
          socket.communityUpdateSubject(conversationId, title),
        );
      } else {
        await runGroupOperation("rename-group", () =>
          socket.groupUpdateSubject(conversationId, title),
        );
      }
      if (metadata) cacheMetadata({ ...metadata, subject: title });
    },
    updateParticipants: async (groupId, participantIds, action) => {
      await runGroupOperation("update-participants", () =>
        socket.groupParticipantsUpdate(groupId, [...participantIds], action),
      );
    },
    listLinkedGroupIds: async (communityId) => {
      const cached = localLinkedGroups.get(communityId) ?? new Set<string>();
      try {
        const linked = await runGroupOperation("list-linked-groups", () =>
          socket.communityFetchLinkedGroups(communityId),
        );
        for (const group of linked.linkedGroups) {
          if (group.id) cached.add(group.id);
        }
        localLinkedGroups.set(communityId, cached);
        return [...cached];
      } catch (error) {
        const community = localMetadata.get(communityId);
        if (community?.isCommunity) return [...cached];
        throw error;
      }
    },
    linkGroup: async (communityId, groupId) => {
      await runGroupOperation("link-group", () =>
        socket.communityLinkGroup(groupId, communityId),
      );
      const linked = localLinkedGroups.get(communityId) ?? new Set<string>();
      linked.add(groupId);
      localLinkedGroups.set(communityId, linked);
      const group = localMetadata.get(groupId);
      if (group) cacheMetadata({ ...group, linkedParent: communityId });
    },
    unlinkGroup: async (communityId, groupId) => {
      await runGroupOperation("unlink-group", () =>
        socket.communityUnlinkGroup(groupId, communityId),
      );
      localLinkedGroups.get(communityId)?.delete(groupId);
      const group = localMetadata.get(groupId);
      if (group) {
        const { linkedParent: _linkedParent, ...unlinked } = group;
        localMetadata.set(groupId, unlinked);
      }
    },
    revokeInvite: async (groupId) => {
      await runGroupOperation("revoke-invite", () => socket.groupRevokeInvite(groupId));
    },
    leaveConversation: async (conversationId) => {
      const metadata = await findMetadata(conversationId);
      if (metadata?.isCommunity) {
        await runGroupOperation("leave-community", () => socket.communityLeave(conversationId));
      } else {
        await runGroupOperation("leave-group", () => socket.groupLeave(conversationId));
      }
      localMetadata.delete(conversationId);
      localLinkedGroups.delete(conversationId);
      for (const linked of localLinkedGroups.values()) linked.delete(conversationId);
    },
    sendText: async (conversationId, text) => {
      await runGroupOperation("send-notice", () => socket.sendMessage(conversationId, { text }));
    },
  };
}

async function runGroupOperation<T>(operation: string, run: () => Promise<T>): Promise<T> {
  for (const delayMs of [0, 1_000, 2_000, 4_000]) {
    if (delayMs > 0) await delay(delayMs);
    try {
      return await run();
    } catch (error) {
      if (error instanceof WhatsAppGroupProvisioningOperationError) throw error;
      if (delayMs < 4_000 && isRateLimitedError(error)) continue;
      throw new WhatsAppGroupProvisioningOperationError(operation, extractStatusCode(error), {
        cause: error,
      });
    }
  }
  throw new Error("Unreachable WhatsApp group operation retry state");
}

function extractStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.statusCode === "number") return error.statusCode;
  const output = error.output;
  if (isRecord(output) && typeof output.statusCode === "number") return output.statusCode;
  const data = error.data;
  if (isRecord(data) && typeof data.statusCode === "number") return data.statusCode;
  return undefined;
}

function isRateLimitedError(error: unknown): boolean {
  if (extractStatusCode(error) === 429) return true;
  if (error instanceof Error && /rate[- ]?overlimit|rate[- ]?limit/i.test(error.message)) {
    return true;
  }
  if (!isRecord(error)) return false;
  return Object.values(error).some(
    (value) => typeof value === "string" && /rate[- ]?overlimit|rate[- ]?limit/i.test(value),
  );
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/[A-Za-z0-9._:-]+@(g\.us|s\.whatsapp\.net|lid)/gi, "[conversation]")
    .replace(/\b\d{10,}\b/g, "[identifier]");
}

function findInvalidMappingRoles(
  snapshot: WhatsAppRemoteTopologySnapshot,
): WhatsAppManagedConversationRole[] {
  const invalid: WhatsAppManagedConversationRole[] = [];
  if (snapshot.community.mappedId && !snapshot.community.remote) {
    invalid.push("community");
  }

  for (const { role, title } of MARSHAL_WHATSAPP_FIXED_GROUPS) {
    const group = snapshot.groups[role];
    if (
      group.mappedId &&
      (!group.remote ||
        group.remote.subject !== title ||
        group.remote.parentCommunityId !== snapshot.community.remote?.id ||
        !group.linkedFromCommunity)
    ) {
      invalid.push(role);
    }
  }
  return invalid;
}

function findRecoverableCommunity(
  communities: readonly WhatsAppRemoteTopologyEntry[],
): WhatsAppRemoteTopologyEntry | undefined {
  const exact = communities.filter((entry) => entry.subject === "Marshal Community");
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const legacy = communities.filter((entry) => entry.subject === "Marshal");
  return legacy.length === 1 ? legacy[0] : undefined;
}

async function waitForRemoteConvergence(
  socket: ManagedGroupSocket,
  provisioning: MarshalWhatsAppCommunityProvisioning,
): Promise<void> {
  const delays = [0, 500, 1_000, 2_000, 4_000, 8_000, 12_000];
  for (const delayMs of delays) {
    if (delayMs > 0) await delay(delayMs);
    if (await isRemoteTopologyConverged(socket, provisioning)) return;
  }
  throw new WhatsAppGroupProvisioningOperationError(
    "remote-convergence",
    undefined,
    { cause: new Error("Created WhatsApp conversations did not become remotely visible") },
  );
}

async function isRemoteTopologyConverged(
  socket: ManagedGroupSocket,
  provisioning: MarshalWhatsAppCommunityProvisioning,
): Promise<boolean> {
  try {
    const community = await socket.communityMetadata(provisioning.community.conversationId);
    if (
      community.id !== provisioning.community.conversationId ||
      community.subject !== "Marshal Community"
    ) {
      return false;
    }
    const linkedIds = await readLinkedGroupIds(socket, provisioning.community.conversationId);
    for (const { role, title } of MARSHAL_WHATSAPP_FIXED_GROUPS) {
      const expected = provisioning.groups[role];
      const remote = await socket.groupMetadata(expected.conversationId);
      if (
        remote.id !== expected.conversationId ||
        remote.subject !== title ||
        remote.linkedParent !== provisioning.community.conversationId ||
        !linkedIds.includes(expected.conversationId)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRemoteTopology(socket: ManagedGroupSocket): Promise<{
  communities: WhatsAppRemoteTopologyEntry[];
  groups: WhatsAppRemoteTopologyEntry[];
  communityQueryError?: string;
}> {
  const rawGroups = await runGroupOperation("inspect-groups", () =>
    socket.groupFetchAllParticipating(),
  );
  let rawCommunities: Record<string, ManagedGroupMetadata> = {};
  let communityQueryError: string | undefined;
  if (socket.communityFetchAllParticipating) {
    try {
      rawCommunities = await runGroupOperation("inspect-communities", () =>
        socket.communityFetchAllParticipating!(),
      );
    } catch (error) {
      communityQueryError = describeWhatsAppGroupProvisioningError(error);
    }
  }
  const participating = await hydrateRemoteEntries(socket, "group", Object.values(rawGroups));
  const communities = await hydrateRemoteEntries(
    socket,
    "community",
    Object.values(rawCommunities),
  );
  return {
    groups: participating.filter((entry) => entry.kind === "group"),
    communities: dedupeRemoteEntries([
      ...participating.filter((entry) => entry.kind === "community"),
      ...communities,
    ]),
    ...(communityQueryError ? { communityQueryError } : {}),
  };
}

async function hydrateRemoteEntries(
  socket: ManagedGroupSocket,
  kind: "community" | "group",
  entries: readonly ManagedGroupMetadata[],
): Promise<WhatsAppRemoteTopologyEntry[]> {
  const hydrated = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isCommunityAnnounce) return undefined;
      if (!hasUsableIdentity(entry) && kind === "group") return undefined;
      const metadata =
        hasUsableIdentity(entry)
          ? entry
          : await runGroupOperation("inspect-community", () =>
              socket.communityMetadata(entry.id),
            );
      return toRemoteEntry(metadata);
    }),
  );
  return hydrated.filter((entry): entry is WhatsAppRemoteTopologyEntry => entry !== undefined);
}

async function readRemoteEntry(
  socket: ManagedGroupSocket,
  kind: "community" | "group",
  id: string,
  entries: readonly WhatsAppRemoteTopologyEntry[],
): Promise<WhatsAppRemoteTopologyEntry | undefined> {
  const listed = entries.find((entry) => entry.id === id);
  if (listed) return listed;
  try {
    const metadata = await runGroupOperation(`inspect-mapped-${kind}`, () =>
      kind === "community" ? socket.communityMetadata(id) : socket.groupMetadata(id),
    );
    return toRemoteEntry(metadata);
  } catch (error) {
    if (extractStatusCode(error) === 404) return undefined;
    throw error;
  }
}

async function readLinkedGroupIds(
  socket: ManagedGroupSocket,
  communityId: string,
): Promise<string[]> {
  const linked = await runGroupOperation("inspect-linked-groups", () =>
    socket.communityFetchLinkedGroups(communityId),
  );
  return linked.linkedGroups.flatMap(({ id }) => (id ? [id] : []));
}

function findExactTitle(
  entries: readonly WhatsAppRemoteTopologyEntry[],
  title: string,
): WhatsAppRemoteTopologyEntry | undefined {
  const candidates = entries.filter((entry) => entry.subject === title);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function toRemoteEntry(metadata: ManagedGroupMetadata): WhatsAppRemoteTopologyEntry | undefined {
  if (!hasUsableIdentity(metadata)) return undefined;
  return {
    id: metadata.id,
    subject: metadata.subject,
    kind: metadata.isCommunity ? "community" : "group",
    ...(metadata.linkedParent ? { parentCommunityId: metadata.linkedParent } : {}),
  };
}

function dedupeRemoteEntries(
  entries: readonly WhatsAppRemoteTopologyEntry[],
): WhatsAppRemoteTopologyEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

function toSocketMetadata(metadata: ManagedGroupMetadata): readonly WhatsAppGroupSocketMetadata[] {
  if (metadata.isCommunityAnnounce || !hasUsableIdentity(metadata)) {
    return [];
  }
  return [{
    id: metadata.id,
    kind: metadata.isCommunity ? "community" : "group",
    title: metadata.subject,
    ...(metadata.linkedParent ? { parentCommunityId: metadata.linkedParent } : {}),
    participantIds: (metadata.participants ?? []).flatMap((participant) =>
      typeof participant.id === "string" &&
      participant.id.length > 0 &&
      participant.id.trim() === participant.id
        ? [participant.id]
        : [],
    ),
  }];
}

function hasUsableIdentity(metadata: ManagedGroupMetadata): boolean {
  return (
    typeof metadata.id === "string" &&
    metadata.id.trim() === metadata.id &&
    metadata.id.length > 0 &&
    typeof metadata.subject === "string" &&
    metadata.subject.trim() === metadata.subject &&
    metadata.subject.length > 0
  );
}

function serializeMapping(mapping: WhatsAppManagedConversationMapping): Record<string, unknown> {
  return {
    role: mapping.role,
    title: mapping.title,
    ref: serializeRef(mapping.ref),
    ...(mapping.parentCommunityRef
      ? { parentCommunityRef: serializeRef(mapping.parentCommunityRef) }
      : {}),
  };
}

function parseMapping(
  value: unknown,
  scope: WhatsAppGroupScope,
  expectedRole: WhatsAppManagedConversationRole,
): WhatsAppManagedConversationMapping {
  if (!isRecord(value) || value.role !== expectedRole || typeof value.title !== "string") {
    throw new Error(`Stored WhatsApp mapping for ${expectedRole} is invalid`);
  }
  return {
    role: expectedRole,
    title: value.title,
    ref: parseRef(value.ref, scope),
    ...(value.parentCommunityRef === undefined
      ? {}
      : { parentCommunityRef: requireCommunityRef(parseRef(value.parentCommunityRef, scope)) }),
  };
}

function serializeTombstone(tombstone: WhatsAppGroupTombstone): Record<string, unknown> {
  return {
    ref: serializeRef(tombstone.ref),
    retiredAt: tombstone.retiredAt,
    reason: tombstone.reason,
  };
}

function parseTombstone(
  value: unknown,
  scope: WhatsAppGroupScope,
  conversationId: RelayConversationId,
): WhatsAppGroupTombstone {
  if (
    !isRecord(value) ||
    typeof value.retiredAt !== "string" ||
    typeof value.reason !== "string"
  ) {
    throw new Error("Stored WhatsApp retirement mapping is invalid");
  }
  const ref = parseRef(value.ref, scope);
  if (ref.conversationId !== conversationId) {
    throw new Error("Stored WhatsApp retirement mapping has a mismatched conversation");
  }
  return {
    ref,
    retiredAt: value.retiredAt,
    reason: value.reason,
  };
}

function parseTombstoneIndex(value: unknown): readonly RelayConversationId[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("Stored WhatsApp retirement index is invalid");
  }
  return value.map((entry) => createWhatsAppGroupRef(SCOPE, entry).conversationId);
}

function serializeRef(ref: WhatsAppConversationRef): Record<string, unknown> {
  return {
    kind: ref.kind,
    conversationId: ref.conversationId,
  };
}

function parseRef(value: unknown, scope: WhatsAppGroupScope): WhatsAppConversationRef {
  if (
    !isRecord(value) ||
    (value.kind !== "group" && value.kind !== "community") ||
    typeof value.conversationId !== "string"
  ) {
    throw new Error("Stored WhatsApp conversation reference is invalid");
  }
  return value.kind === "community"
    ? createWhatsAppCommunityRef(scope, value.conversationId)
    : createWhatsAppGroupRef(scope, value.conversationId);
}

function requireCommunityRef(ref: WhatsAppConversationRef) {
  if (ref.kind !== "community") {
    throw new Error("Stored WhatsApp parent reference is not a community");
  }
  return ref;
}

function assertScope(scope: WhatsAppGroupScope): void {
  if (scope.providerId !== SCOPE.providerId || scope.accountId !== SCOPE.accountId) {
    throw new Error("WhatsApp managed-group mapping scope mismatch");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
