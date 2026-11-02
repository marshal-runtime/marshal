import type {
  WhatsAppCommunityRef,
  WhatsAppGroupCapability,
  WhatsAppGroupMappingPort,
  WhatsAppGroupRef,
  WhatsAppManagedConversation,
  WhatsAppManagedConversationMapping,
  WhatsAppManagedConversationRole,
} from "./group-admin";
import { WhatsAppGroupAdministration, WhatsAppGroupRelationshipError } from "./group-admin";

export const MARSHAL_WHATSAPP_COMMUNITY_TITLE = "Marshal Community";

export const MARSHAL_WHATSAPP_FIXED_GROUPS = [
  { role: "new-chats", title: "New Chats" },
  { role: "progress", title: "Progress" },
  { role: "information-control", title: "Information & Control" },
] as const satisfies readonly {
  readonly role: Exclude<WhatsAppManagedConversationRole, "community">;
  readonly title: string;
}[];

export type MarshalWhatsAppFixedGroupRole = (typeof MARSHAL_WHATSAPP_FIXED_GROUPS)[number]["role"];

type MarshalWhatsAppFixedGroupSpecification = (typeof MARSHAL_WHATSAPP_FIXED_GROUPS)[number];

export interface MarshalWhatsAppCommunityProvisioning {
  readonly community: WhatsAppCommunityRef;
  readonly groups: Readonly<Record<MarshalWhatsAppFixedGroupRole, WhatsAppGroupRef>>;
}

export interface WhatsAppCommunityProvisionerOptions {
  readonly administration: WhatsAppGroupAdministration;
  readonly mappings: WhatsAppGroupMappingPort;
  readonly communityTitle?: string;
}

export class WhatsAppProvisioningAmbiguityError extends Error {
  readonly name = "WhatsAppProvisioningAmbiguityError";
  readonly code = "WHATSAPP_PROVISIONING_AMBIGUOUS";

  constructor(
    readonly role: WhatsAppManagedConversationRole,
    readonly candidateCount: number,
  ) {
    super(
      `WhatsApp provisioning found ${candidateCount} indistinguishable candidates for "${role}"`,
    );
  }
}

export class WhatsAppCommunityProvisioner {
  private readonly administration: WhatsAppGroupAdministration;
  private readonly mappings: WhatsAppGroupMappingPort;
  private readonly communityTitle: string;
  private inFlight: Promise<MarshalWhatsAppCommunityProvisioning> | undefined;

  constructor(options: WhatsAppCommunityProvisionerOptions) {
    this.administration = options.administration;
    this.mappings = options.mappings;
    this.communityTitle = requireProvisioningTitle(
      "community title",
      options.communityTitle ?? MARSHAL_WHATSAPP_COMMUNITY_TITLE,
    );
  }

  provision(): Promise<MarshalWhatsAppCommunityProvisioning> {
    if (this.inFlight) return this.inFlight;
    const run = this.mappings.runExclusive(this.administration.scope, () => this.provisionOnce());
    const tracked = run.finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined;
    });
    this.inFlight = tracked;
    return tracked;
  }

  private async provisionOnce(): Promise<MarshalWhatsAppCommunityProvisioning> {
    const conversations = await this.administration.listWhatsAppConversations();
    const pendingRetirementIds = new Set(
      (await this.mappings.listPendingRetirements(this.administration.scope)).map(
        (tombstone) => tombstone.ref.conversationId,
      ),
    );
    const existingMappings = excludePendingMappings(
      await this.loadMappings(),
      pendingRetirementIds,
    );
    assertUniqueMappedConversationRoles(existingMappings);
    const reservedGroupRoles = reserveMappedGroupRoles(existingMappings);
    const community = await this.ensureCommunity(
      conversations,
      existingMappings,
      pendingRetirementIds,
    );

    const provisionedGroups = await this.provisionFixedGroups(
      community,
      existingMappings,
      reservedGroupRoles,
      pendingRetirementIds,
      MARSHAL_WHATSAPP_FIXED_GROUPS,
    );
    const groups = new Map(provisionedGroups);
    assertUniqueProvisionedGroups(groups);
    await this.persistMapping("community", this.communityTitle, community);
    await this.persistFixedGroupMappings(community, groups, MARSHAL_WHATSAPP_FIXED_GROUPS);

    return {
      community,
      groups: {
        "new-chats": requireProvisionedGroup(groups, "new-chats"),
        progress: requireProvisionedGroup(groups, "progress"),
        "information-control": requireProvisionedGroup(groups, "information-control"),
      },
    };
  }

  private async provisionFixedGroups(
    community: WhatsAppCommunityRef,
    existingMappings: ReadonlyMap<
      WhatsAppManagedConversationRole,
      WhatsAppManagedConversationMapping
    >,
    reservedGroupRoles: Map<WhatsAppGroupRef["conversationId"], MarshalWhatsAppFixedGroupRole>,
    pendingRetirementIds: ReadonlySet<WhatsAppGroupRef["conversationId"]>,
    remaining: readonly MarshalWhatsAppFixedGroupSpecification[],
  ): Promise<readonly (readonly [MarshalWhatsAppFixedGroupRole, WhatsAppGroupRef])[]> {
    const specification = remaining[0];
    if (!specification) return [];
    const currentConversations = await this.administration.listWhatsAppConversations();
    const group = await this.ensureGroup(
      specification.role,
      specification.title,
      community,
      currentConversations,
      existingMappings.get(specification.role),
      reservedGroupRoles,
      pendingRetirementIds,
    );
    if (pendingRetirementIds.has(group.conversationId)) {
      throw new WhatsAppGroupRelationshipError(
        `${specification.role} resolved to a conversation pending retirement`,
      );
    }
    const reservedRole = reservedGroupRoles.get(group.conversationId);
    if (reservedRole && reservedRole !== specification.role) {
      throw new WhatsAppGroupRelationshipError(
        `managed roles "${reservedRole}" and "${specification.role}" resolved to the same conversation`,
      );
    }
    reservedGroupRoles.set(group.conversationId, specification.role);
    const rest = await this.provisionFixedGroups(
      community,
      existingMappings,
      reservedGroupRoles,
      pendingRetirementIds,
      remaining.slice(1),
    );
    return [[specification.role, group], ...rest];
  }

  private async persistFixedGroupMappings(
    community: WhatsAppCommunityRef,
    groups: ReadonlyMap<MarshalWhatsAppFixedGroupRole, WhatsAppGroupRef>,
    remaining: readonly MarshalWhatsAppFixedGroupSpecification[],
  ): Promise<void> {
    const specification = remaining[0];
    if (!specification) return;
    await this.persistMapping(
      specification.role,
      specification.title,
      requireProvisionedGroup(groups, specification.role),
      community,
    );
    await this.persistFixedGroupMappings(community, groups, remaining.slice(1));
  }

  private async loadMappings(): Promise<
    ReadonlyMap<WhatsAppManagedConversationRole, WhatsAppManagedConversationMapping>
  > {
    const roles: readonly WhatsAppManagedConversationRole[] = [
      "community",
      ...MARSHAL_WHATSAPP_FIXED_GROUPS.map((group) => group.role),
    ];
    const mappings = await Promise.all(
      roles.map(async (role) => {
        const mapping = await this.mappings.get(this.administration.scope, role);
        return [role, mapping] as const;
      }),
    );
    return new Map(
      mappings.filter(
        (
          entry,
        ): entry is readonly [
          WhatsAppManagedConversationRole,
          WhatsAppManagedConversationMapping,
        ] => entry[1] !== undefined,
      ),
    );
  }

  private async ensureCommunity(
    conversations: readonly WhatsAppManagedConversation[],
    mappings: ReadonlyMap<WhatsAppManagedConversationRole, WhatsAppManagedConversationMapping>,
    pendingRetirementIds: ReadonlySet<WhatsAppCommunityRef["conversationId"]>,
  ): Promise<WhatsAppCommunityRef> {
    const mapped = mappings.get("community");
    if (mapped) {
      if (mapped.ref.kind !== "community") {
        throw new WhatsAppGroupRelationshipError("community mapping points at a group reference");
      }
      const existing = await this.administration.getConversation(mapped.ref);
      if (existing) {
        if (existing.title !== this.communityTitle) {
          await this.administration.renameConversation(mapped.ref, this.communityTitle);
        }
        return mapped.ref;
      }
    }

    const candidates = conversations.filter(
      (conversation) =>
        conversation.ref.kind === "community" &&
        conversation.title === this.communityTitle &&
        !pendingRetirementIds.has(conversation.ref.conversationId),
    );
    if (candidates.length === 1) {
      return requireCommunityRef(candidates[0]);
    }
    if (candidates.length > 1) {
      return this.disambiguateCommunities(
        candidates,
        conversations,
        mappings,
        pendingRetirementIds,
      );
    }
    const created = await this.administration.createCommunity(this.communityTitle);
    return requireCommunityRef(created);
  }

  private disambiguateCommunities(
    candidates: readonly WhatsAppManagedConversation[],
    conversations: readonly WhatsAppManagedConversation[],
    mappings: ReadonlyMap<WhatsAppManagedConversationRole, WhatsAppManagedConversationMapping>,
    pendingRetirementIds: ReadonlySet<WhatsAppManagedConversation["ref"]["conversationId"]>,
  ): WhatsAppCommunityRef {
    const mappedChildParents = new Set(
      [...mappings.entries()]
        .filter(([role]) => role !== "community")
        .map(([, mapping]) => mapping.parentCommunityRef?.conversationId)
        .filter((id): id is WhatsAppCommunityRef["conversationId"] => id !== undefined),
    );
    const mappedMatches = candidates.filter((candidate) =>
      mappedChildParents.has(candidate.ref.conversationId),
    );
    if (mappedMatches.length === 1) return requireCommunityRef(mappedMatches[0]);

    const fixedTitles = new Set<string>(MARSHAL_WHATSAPP_FIXED_GROUPS.map((group) => group.title));
    const scored = candidates.map((candidate) => {
      const matchedTitles = new Set(
        conversations
          .filter(
            (conversation) =>
              conversation.ref.kind === "group" &&
              !pendingRetirementIds.has(conversation.ref.conversationId) &&
              conversation.parentCommunityRef?.conversationId === candidate.ref.conversationId &&
              fixedTitles.has(conversation.title),
          )
          .map((conversation) => conversation.title),
      );
      return { candidate, score: matchedTitles.size };
    });
    const highestScore = Math.max(...scored.map((entry) => entry.score));
    const highest = scored.filter((entry) => entry.score === highestScore);
    if (highestScore > 0 && highest.length === 1) {
      return requireCommunityRef(highest[0].candidate);
    }
    throw new WhatsAppProvisioningAmbiguityError("community", candidates.length);
  }

  private async ensureGroup(
    role: MarshalWhatsAppFixedGroupRole,
    title: string,
    communityRef: WhatsAppCommunityRef,
    conversations: readonly WhatsAppManagedConversation[],
    mapped: WhatsAppManagedConversationMapping | undefined,
    reservedGroupRoles: ReadonlyMap<
      WhatsAppGroupRef["conversationId"],
      MarshalWhatsAppFixedGroupRole
    >,
    pendingRetirementIds: ReadonlySet<WhatsAppGroupRef["conversationId"]>,
  ): Promise<WhatsAppGroupRef> {
    if (mapped) {
      if (mapped.ref.kind !== "group") {
        throw new WhatsAppGroupRelationshipError(`${role} mapping points at a community`);
      }
      const existing = await this.administration.getConversation(mapped.ref);
      if (existing) {
        if (
          existing.parentCommunityRef &&
          existing.parentCommunityRef.conversationId !== communityRef.conversationId
        ) {
          throw new WhatsAppGroupRelationshipError(
            `${role} mapping is linked to a different community`,
          );
        }
        const requiredCapabilities: WhatsAppGroupCapability[] = ["list-community-groups"];
        if (!existing.parentCommunityRef) {
          requiredCapabilities.push("link-group");
        }
        if (existing.title !== title) {
          requiredCapabilities.push("rename-conversation");
        }
        this.administration.assertCapabilities(
          requiredCapabilities,
          `${role} managed-group reconciliation`,
        );
        if (!existing.parentCommunityRef) {
          await this.administration.linkGroup(communityRef, mapped.ref);
        } else {
          await this.administration.validateLinkedParent(communityRef, mapped.ref);
        }
        if (existing.title !== title) {
          await this.administration.renameConversation(mapped.ref, title);
        }
        return mapped.ref;
      }
    }

    const sameTitle = conversations.filter(
      (conversation) =>
        conversation.ref.kind === "group" &&
        conversation.title === title &&
        !pendingRetirementIds.has(conversation.ref.conversationId) &&
        isAvailableForRole(conversation.ref.conversationId, role, reservedGroupRoles),
    );
    const linkedToTarget = sameTitle.filter(
      (conversation) =>
        conversation.parentCommunityRef?.conversationId === communityRef.conversationId,
    );
    if (linkedToTarget.length > 1) {
      throw new WhatsAppProvisioningAmbiguityError(role, linkedToTarget.length);
    }
    if (linkedToTarget.length === 1) {
      const ref = requireGroupRef(linkedToTarget[0]);
      await this.administration.validateLinkedParent(communityRef, ref);
      return ref;
    }

    const unlinked = sameTitle.filter(
      (conversation) => conversation.parentCommunityRef === undefined,
    );
    if (unlinked.length > 1) {
      throw new WhatsAppProvisioningAmbiguityError(role, unlinked.length);
    }
    if (unlinked.length === 1) {
      const ref = requireGroupRef(unlinked[0]);
      await this.administration.linkGroup(communityRef, ref);
      return ref;
    }

    const created = await this.administration.createGroup(title, communityRef);
    const ref = requireGroupRef(created);
    await this.administration.validateLinkedParent(communityRef, ref);
    return ref;
  }

  private persistMapping(
    role: WhatsAppManagedConversationRole,
    title: string,
    ref: WhatsAppCommunityRef | WhatsAppGroupRef,
    parentCommunityRef?: WhatsAppCommunityRef,
  ): Promise<void> {
    return this.mappings.set({
      role,
      title,
      ref,
      parentCommunityRef,
    });
  }
}

function requireCommunityRef(conversation: WhatsAppManagedConversation): WhatsAppCommunityRef {
  if (conversation.ref.kind !== "community") {
    throw new WhatsAppGroupRelationshipError("expected a community conversation");
  }
  return conversation.ref;
}

function requireGroupRef(conversation: WhatsAppManagedConversation): WhatsAppGroupRef {
  if (conversation.ref.kind !== "group") {
    throw new WhatsAppGroupRelationshipError("expected a group conversation");
  }
  return conversation.ref;
}

function requireProvisionedGroup(
  groups: ReadonlyMap<MarshalWhatsAppFixedGroupRole, WhatsAppGroupRef>,
  role: MarshalWhatsAppFixedGroupRole,
): WhatsAppGroupRef {
  const group = groups.get(role);
  if (!group) throw new Error(`WhatsApp provisioning did not resolve "${role}"`);
  return group;
}

function assertUniqueMappedConversationRoles(
  mappings: ReadonlyMap<WhatsAppManagedConversationRole, WhatsAppManagedConversationMapping>,
): void {
  const rolesByConversation = new Map<
    WhatsAppManagedConversationMapping["ref"]["conversationId"],
    WhatsAppManagedConversationRole
  >();
  for (const [role, mapping] of mappings) {
    const existingRole = rolesByConversation.get(mapping.ref.conversationId);
    if (existingRole) {
      throw new WhatsAppGroupRelationshipError(
        `managed roles "${existingRole}" and "${role}" map to the same conversation`,
      );
    }
    rolesByConversation.set(mapping.ref.conversationId, role);
  }
}

function excludePendingMappings(
  mappings: ReadonlyMap<WhatsAppManagedConversationRole, WhatsAppManagedConversationMapping>,
  pendingRetirementIds: ReadonlySet<WhatsAppManagedConversationMapping["ref"]["conversationId"]>,
): ReadonlyMap<WhatsAppManagedConversationRole, WhatsAppManagedConversationMapping> {
  return new Map(
    [...mappings].filter(
      ([, mapping]) =>
        !pendingRetirementIds.has(mapping.ref.conversationId) &&
        !(
          mapping.parentCommunityRef &&
          pendingRetirementIds.has(mapping.parentCommunityRef.conversationId)
        ),
    ),
  );
}

function reserveMappedGroupRoles(
  mappings: ReadonlyMap<WhatsAppManagedConversationRole, WhatsAppManagedConversationMapping>,
): Map<WhatsAppGroupRef["conversationId"], MarshalWhatsAppFixedGroupRole> {
  const reserved = new Map<WhatsAppGroupRef["conversationId"], MarshalWhatsAppFixedGroupRole>();
  for (const specification of MARSHAL_WHATSAPP_FIXED_GROUPS) {
    const mapping = mappings.get(specification.role);
    if (mapping) reserved.set(mapping.ref.conversationId, specification.role);
  }
  return reserved;
}

function assertUniqueProvisionedGroups(
  groups: ReadonlyMap<MarshalWhatsAppFixedGroupRole, WhatsAppGroupRef>,
): void {
  const rolesByConversation = new Map<
    WhatsAppGroupRef["conversationId"],
    MarshalWhatsAppFixedGroupRole
  >();
  for (const [role, group] of groups) {
    const existingRole = rolesByConversation.get(group.conversationId);
    if (existingRole) {
      throw new WhatsAppGroupRelationshipError(
        `managed roles "${existingRole}" and "${role}" resolved to the same conversation`,
      );
    }
    rolesByConversation.set(group.conversationId, role);
  }
}

function isAvailableForRole(
  conversationId: WhatsAppGroupRef["conversationId"],
  role: MarshalWhatsAppFixedGroupRole,
  reservedGroupRoles: ReadonlyMap<
    WhatsAppGroupRef["conversationId"],
    MarshalWhatsAppFixedGroupRole
  >,
): boolean {
  const reservedRole = reservedGroupRoles.get(conversationId);
  return reservedRole === undefined || reservedRole === role;
}

function requireProvisioningTitle(label: string, value: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty, trimmed string`);
  }
  return value;
}
