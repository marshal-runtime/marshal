import { describe, expect, it, vi } from "vitest";

import { parseRelayAccountId, parseRelayProviderId } from "../../../../../common/relay-contract";
import {
  createWhatsAppCommunityRef,
  createWhatsAppGroupRef,
  type WhatsAppGroupTombstone,
  type WhatsAppManagedConversationMapping,
} from "../group-admin";
import type { WhatsAppSidecarAuthStorePort } from "./auth-port";
import {
  EncryptedAuthGroupMappingStore,
  provisionMarshalWhatsAppGroups,
  type ManagedGroupMetadata,
  type ManagedGroupSocket,
} from "./group-provisioning";

const SCOPE = {
  providerId: parseRelayProviderId("whatsapp-baileys"),
  accountId: parseRelayAccountId("primary"),
};

class FakeAuthStore implements WhatsAppSidecarAuthStorePort {
  private readonly values = new Map<string, Map<string, object | string | number | boolean | bigint>>();

  async readCredentials() {
    return null;
  }

  async readSignalKeys(category: string, ids: readonly string[]) {
    const categoryValues = this.values.get(category);
    return Object.fromEntries(
      ids.flatMap((id) => {
        const value = categoryValues?.get(id);
        return value === undefined ? [] : [[id, value]];
      }),
    );
  }

  async applyTransaction(update: {
    credentials?: object | string | number | boolean | bigint | null;
    signalKeys?: Record<
      string,
      Record<string, object | string | number | boolean | bigint | null>
    >;
  }) {
    for (const [category, entries] of Object.entries(update.signalKeys ?? {})) {
      const categoryValues = this.values.get(category) ?? new Map();
      this.values.set(category, categoryValues);
      for (const [id, value] of Object.entries(entries)) {
        if (value === null) categoryValues.delete(id);
        else categoryValues.set(id, value);
      }
    }
  }

  async reset(): Promise<void> {
    this.values.clear();
  }
}

describe("EncryptedAuthGroupMappingStore", () => {
  it("recovers mappings and retirement tombstones across store instances", async () => {
    const authStore = new FakeAuthStore();
    const first = new EncryptedAuthGroupMappingStore(authStore);
    const community = createWhatsAppCommunityRef(SCOPE, "community@g.us");
    const group = createWhatsAppGroupRef(SCOPE, "progress@g.us");
    const mapping: WhatsAppManagedConversationMapping = {
      role: "progress",
      title: "Progress",
      ref: group,
      parentCommunityRef: community,
    };
    const tombstone: WhatsAppGroupTombstone = {
      ref: createWhatsAppGroupRef(SCOPE, "retired@g.us"),
      retiredAt: "2026-08-07T08:00:00.000Z",
      reason: "replaced",
    };

    await first.set(mapping);
    await first.tombstone(tombstone);

    const reopened = new EncryptedAuthGroupMappingStore(authStore);
    await expect(reopened.get(SCOPE, "progress")).resolves.toEqual(mapping);
    await expect(reopened.findByConversation(SCOPE, group.conversationId)).resolves.toEqual(mapping);
    await expect(reopened.listPendingRetirements(SCOPE)).resolves.toEqual([tombstone]);
  });
});

describe("provisionMarshalWhatsAppGroups", () => {
  it("creates the fixed topology once and recovers it idempotently", async () => {
    const authStore = new FakeAuthStore();
    const metadata = new Map<string, ManagedGroupMetadata>();
    let sequence = 0;
    const createMetadata = (
      subject: string,
      options: { community?: boolean; parent?: string } = {},
    ): ManagedGroupMetadata => {
      sequence += 1;
      return {
        id: `${sequence}@g.us`,
        owner: undefined,
        subject,
        participants: [],
        ...(options.community ? { isCommunity: true } : {}),
        ...(options.parent ? { linkedParent: options.parent } : {}),
      };
    };
    const socket: ManagedGroupSocket = {
      groupFetchAllParticipating: vi.fn(async () =>
        Object.fromEntries([...metadata].filter(([, entry]) => !entry.isCommunity)),
      ),
      communityFetchAllParticipating: vi.fn(async () =>
        Object.fromEntries([...metadata].filter(([, entry]) => entry.isCommunity)),
      ),
      groupMetadata: vi.fn(async (jid) => metadata.get(jid)!),
      communityMetadata: vi.fn(async (jid) => metadata.get(jid)!),
      communityCreate: vi.fn(async (subject) => {
        const created = createMetadata(subject, { community: true });
        metadata.set(created.id, created);
        return created;
      }),
      communityCreateGroup: vi.fn(async (subject, _participants, parent) => {
        const created = createMetadata(subject, { parent });
        metadata.set(created.id, created);
        return created;
      }),
      groupCreate: vi.fn(async (subject) => {
        const created = createMetadata(subject);
        metadata.set(created.id, created);
        return created;
      }),
      communityFetchLinkedGroups: vi.fn(async (communityJid) => ({
        communityJid,
        isCommunity: true,
        linkedGroups: [...metadata.values()]
          .filter((entry) => entry.linkedParent === communityJid)
          .map((entry) => ({
            id: entry.id,
            subject: entry.subject,
            creation: entry.creation,
            owner: entry.owner,
            size: entry.size,
          })),
      })),
      communityLinkGroup: vi.fn(async (groupJid, parentCommunityJid) => {
        const group = metadata.get(groupJid);
        if (group) group.linkedParent = parentCommunityJid;
      }),
      communityUnlinkGroup: vi.fn(async (groupJid) => {
        const group = metadata.get(groupJid);
        if (group) delete group.linkedParent;
      }),
      communityUpdateSubject: vi.fn(async (jid, subject) => {
        const entry = metadata.get(jid);
        if (entry) entry.subject = subject;
      }),
      groupUpdateSubject: vi.fn(async (jid, subject) => {
        const entry = metadata.get(jid);
        if (entry) entry.subject = subject;
      }),
      groupParticipantsUpdate: vi.fn(async () => []),
      groupRevokeInvite: vi.fn(async () => undefined),
      communityLeave: vi.fn(async (jid) => {
        metadata.delete(jid);
      }),
      groupLeave: vi.fn(async (jid) => {
        metadata.delete(jid);
      }),
      sendMessage: vi.fn(async () => undefined),
    };

    const first = await provisionMarshalWhatsAppGroups(socket, authStore);
    const second = await provisionMarshalWhatsAppGroups(socket, authStore);

    expect(first).toEqual(second);
    expect(socket.communityCreate).toHaveBeenCalledOnce();
    expect(socket.communityCreateGroup).toHaveBeenCalledTimes(3);
    expect([...metadata.values()].map((entry) => entry.subject).sort()).toEqual(
      ["Information & Control", "Marshal Community", "New Chats", "Progress"].sort(),
    );
  });

  it("uses successful create responses while WhatsApp metadata catches up", async () => {
    const authStore = new FakeAuthStore();
    let sequence = 0;
    const created: ManagedGroupMetadata[] = [];
    const createMetadata = (
      subject: string,
      options: { community?: boolean; parent?: string } = {},
    ): ManagedGroupMetadata => ({
      id: `${++sequence}@g.us`,
      owner: undefined,
      subject,
      participants: [],
      ...(options.community ? { isCommunity: true } : {}),
      ...(options.parent ? { linkedParent: options.parent } : {}),
    });
    const socket: ManagedGroupSocket = {
      groupFetchAllParticipating: vi.fn(async () => ({})),
      communityFetchAllParticipating: vi.fn(async () => ({})),
      groupMetadata: vi.fn(async (jid) => created.find((entry) => entry.id === jid)!),
      communityMetadata: vi.fn(async (jid) => created.find((entry) => entry.id === jid)!),
      communityCreate: vi.fn(async (subject) => {
        const metadata = createMetadata(subject, { community: true });
        created.push(metadata);
        return metadata;
      }),
      communityCreateGroup: vi.fn(async (subject, _participants, parent) => {
        const metadata = createMetadata(subject, { parent });
        created.push(metadata);
        return metadata;
      }),
      groupCreate: vi.fn(async (subject) => {
        const metadata = createMetadata(subject);
        created.push(metadata);
        return metadata;
      }),
      communityFetchLinkedGroups: vi.fn(async (communityJid) => ({
        communityJid,
        isCommunity: true,
        linkedGroups: created
          .filter((entry) => entry.linkedParent === communityJid)
          .map((entry) => ({ id: entry.id, subject: entry.subject })),
      })),
      communityLinkGroup: vi.fn(async () => undefined),
      communityUnlinkGroup: vi.fn(async () => undefined),
      communityUpdateSubject: vi.fn(async () => undefined),
      groupUpdateSubject: vi.fn(async () => undefined),
      groupParticipantsUpdate: vi.fn(async () => []),
      groupRevokeInvite: vi.fn(async () => undefined),
      communityLeave: vi.fn(async () => undefined),
      groupLeave: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
    };

    const result = await provisionMarshalWhatsAppGroups(socket, authStore);

    expect(result.community.conversationId).toBe(created[0]?.id);
    expect(Object.keys(result.groups)).toEqual([
      "new-chats",
      "progress",
      "information-control",
    ]);
    expect(created.map((entry) => entry.subject)).toEqual([
      "Marshal Community",
      "New Chats",
      "Progress",
      "Information & Control",
    ]);
  });

  it("ignores incomplete and announcement metadata returned during account sync", async () => {
    const authStore = new FakeAuthStore();
    const metadata = new Map<string, ManagedGroupMetadata>([
      [
        "announce@g.us",
        {
          id: "announce@g.us",
          subject: "",
          participants: [],
          isCommunityAnnounce: true,
        },
      ],
    ]);
    let sequence = 0;
    const createMetadata = (
      subject: string,
      options: { community?: boolean; parent?: string } = {},
    ): ManagedGroupMetadata => ({
      id: `managed-${++sequence}@g.us`,
      subject,
      participants: [],
      ...(options.community ? { isCommunity: true } : {}),
      ...(options.parent ? { linkedParent: options.parent } : {}),
    });
    const socket: ManagedGroupSocket = {
      groupFetchAllParticipating: vi.fn(async () =>
        Object.fromEntries([...metadata].filter(([, entry]) => !entry.isCommunity)),
      ),
      communityFetchAllParticipating: vi.fn(async () =>
        Object.fromEntries([...metadata].filter(([, entry]) => entry.isCommunity)),
      ),
      groupMetadata: vi.fn(async (jid) => metadata.get(jid)!),
      communityMetadata: vi.fn(async (jid) => metadata.get(jid)!),
      communityCreate: vi.fn(async (subject) => {
        const created = createMetadata(subject, { community: true });
        metadata.set(created.id, created);
        return created;
      }),
      communityCreateGroup: vi.fn(async (subject, _participants, parent) => {
        const created = createMetadata(subject, { parent });
        metadata.set(created.id, created);
        return created;
      }),
      groupCreate: vi.fn(async (subject) => createMetadata(subject)),
      communityFetchLinkedGroups: vi.fn(async (communityJid) => ({
        communityJid,
        isCommunity: true,
        linkedGroups: [...metadata.values()]
          .filter((entry) => entry.linkedParent === communityJid)
          .map((entry) => ({ id: entry.id, subject: entry.subject })),
      })),
      communityLinkGroup: vi.fn(async () => undefined),
      communityUnlinkGroup: vi.fn(async () => undefined),
      communityUpdateSubject: vi.fn(async () => undefined),
      groupUpdateSubject: vi.fn(async () => undefined),
      groupParticipantsUpdate: vi.fn(async () => []),
      groupRevokeInvite: vi.fn(async () => undefined),
      communityLeave: vi.fn(async () => undefined),
      groupLeave: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
    };

    const result = await provisionMarshalWhatsAppGroups(socket, authStore);

    expect(result.community.conversationId).toBe("managed-1@g.us");
    expect(socket.communityCreateGroup).toHaveBeenCalledTimes(3);
  });

  it("recovers existing managed topology without creating duplicates", async () => {
    const authStore = new FakeAuthStore();
    const full = new Map<string, ManagedGroupMetadata>([
      [
        "community@g.us",
        {
          id: "community@g.us",
          subject: "Marshal Community",
          participants: [],
          isCommunity: true,
        },
      ],
      [
        "new-chats@g.us",
        {
          id: "new-chats@g.us",
          subject: "New Chats",
          participants: [],
          linkedParent: "community@g.us",
        },
      ],
      [
        "progress@g.us",
        {
          id: "progress@g.us",
          subject: "Progress",
          participants: [],
          linkedParent: "community@g.us",
        },
      ],
      [
        "information-control@g.us",
        {
          id: "information-control@g.us",
          subject: "Information & Control",
          participants: [],
          linkedParent: "community@g.us",
        },
      ],
    ]);
    const socket: ManagedGroupSocket = {
      groupFetchAllParticipating: vi.fn(async () =>
        Object.fromEntries(
          [...full].filter(([, entry]) => !entry.isCommunity),
        ),
      ),
      communityFetchAllParticipating: vi.fn(async () => ({
        "community@g.us": full.get("community@g.us")!,
      })),
      groupMetadata: vi.fn(async (jid) => full.get(jid)!),
      communityMetadata: vi.fn(async (jid) => full.get(jid)!),
      communityCreate: vi.fn(async () => null),
      communityCreateGroup: vi.fn(async () => null),
      groupCreate: vi.fn(async () => {
        throw new Error("unexpected create");
      }),
      communityFetchLinkedGroups: vi.fn(async (communityJid) => ({
        communityJid,
        isCommunity: true,
        linkedGroups: [...full.values()]
          .filter((entry) => entry.linkedParent === communityJid)
          .map((entry) => ({ id: entry.id, subject: entry.subject })),
      })),
      communityLinkGroup: vi.fn(async () => undefined),
      communityUnlinkGroup: vi.fn(async () => undefined),
      communityUpdateSubject: vi.fn(async () => undefined),
      groupUpdateSubject: vi.fn(async () => undefined),
      groupParticipantsUpdate: vi.fn(async () => []),
      groupRevokeInvite: vi.fn(async () => undefined),
      communityLeave: vi.fn(async () => undefined),
      groupLeave: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
    };

    const result = await provisionMarshalWhatsAppGroups(socket, authStore);

    expect(result.community.conversationId).toBe("community@g.us");
    expect(socket.communityCreate).not.toHaveBeenCalled();
    expect(socket.communityCreateGroup).not.toHaveBeenCalled();
    expect(socket.groupMetadata).toHaveBeenCalled();
    expect(socket.communityMetadata).toHaveBeenCalled();
  });
});
