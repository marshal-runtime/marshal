import { describe, expect, it } from "vitest";

import { parseRelayAccountId, parseRelayProviderId } from "../../../../common/relay-contract";
import {
  WhatsAppGroupAdministration,
  WhatsAppGroupRelationshipError,
  WhatsAppGroupScopeError,
  WhatsAppGroupUnsupportedError,
  createWhatsAppCommunityRef,
  createWhatsAppGroupRef,
  createWhatsAppParticipantRef,
} from "./group-admin";
import {
  InMemoryWhatsAppGroupMappingPort,
  TEST_WHATSAPP_SCOPE,
  WhatsAppGroupSocketFixture,
  groupMapping,
} from "./group-admin.test-fixtures";

describe("WhatsAppGroupAdministration", () => {
  it("renames, manages participants, links, unlinks, revokes invites, and leaves", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    fixture.seed({ id: "community-a", kind: "community", title: "Community" });
    fixture.seed({
      id: "group-a",
      kind: "group",
      title: "Original",
      parentCommunityId: "community-a",
      participantIds: ["existing-user"],
    });
    const mappings = new InMemoryWhatsAppGroupMappingPort(fixture.operations);
    const administration = createAdministration(fixture, mappings);
    const communityRef = createWhatsAppCommunityRef(TEST_WHATSAPP_SCOPE, "community-a");
    const groupRef = createWhatsAppGroupRef(TEST_WHATSAPP_SCOPE, "group-a");
    const participant = createWhatsAppParticipantRef(TEST_WHATSAPP_SCOPE, "managed-user");

    await administration.renameConversation(groupRef, "Renamed");
    await administration.addParticipants(groupRef, [participant, participant]);
    await administration.removeParticipants(groupRef, [participant]);
    await administration.revokeInvite(groupRef);
    await administration.unlinkGroup(communityRef, groupRef);
    await administration.linkGroup(communityRef, groupRef);
    await administration.leaveConversation(groupRef);

    expect(fixture.get("group-a")).toBeUndefined();
    expect(fixture.operations).toEqual([
      "rename:group-a:Renamed",
      "add-participants:group-a:managed-user",
      "remove-participants:group-a:managed-user",
      "revoke-invite:group-a",
      "unlink:community-a:group-a",
      "link:community-a:group-a",
      "leave:group-a",
    ]);
  });

  it("rejects conflicting parent metadata instead of relinking a mapped group", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    fixture.seed({ id: "community-a", kind: "community", title: "Community A" });
    fixture.seed({ id: "community-b", kind: "community", title: "Community B" });
    fixture.seed({
      id: "group-a",
      kind: "group",
      title: "Group",
      parentCommunityId: "community-b",
    });
    const administration = createAdministration(fixture, new InMemoryWhatsAppGroupMappingPort());

    await expect(
      administration.linkGroup(
        createWhatsAppCommunityRef(TEST_WHATSAPP_SCOPE, "community-a"),
        createWhatsAppGroupRef(TEST_WHATSAPP_SCOPE, "group-a"),
      ),
    ).rejects.toBeInstanceOf(WhatsAppGroupRelationshipError);
    expect(fixture.operations).toEqual([]);
  });

  it("rejects a group linked under more than one community during parent validation", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    fixture.seed({ id: "community-a", kind: "community", title: "Community A" });
    fixture.seed({ id: "community-b", kind: "community", title: "Community B" });
    fixture.seed({
      id: "group-a",
      kind: "group",
      title: "Group",
      parentCommunityId: "community-a",
    });
    fixture.setLinked("community-b", "group-a", true);
    const administration = createAdministration(fixture, new InMemoryWhatsAppGroupMappingPort());

    await expect(
      administration.validateLinkedParent(
        createWhatsAppCommunityRef(TEST_WHATSAPP_SCOPE, "community-a"),
        createWhatsAppGroupRef(TEST_WHATSAPP_SCOPE, "group-a"),
      ),
    ).rejects.toBeInstanceOf(WhatsAppGroupRelationshipError);
  });

  it("validates a conversation reference kind before leaving", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    fixture.seed({ id: "community-a", kind: "community", title: "Community" });
    const administration = createAdministration(fixture, new InMemoryWhatsAppGroupMappingPort());

    await expect(
      administration.leaveConversation(createWhatsAppGroupRef(TEST_WHATSAPP_SCOPE, "community-a")),
    ).rejects.toBeInstanceOf(WhatsAppGroupRelationshipError);
    expect(fixture.get("community-a")).toBeDefined();
    expect(fixture.operations).toEqual([]);
  });

  it("validates a group reference kind before unlinking", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    fixture.seed({ id: "community-a", kind: "community", title: "Community" });
    const administration = createAdministration(fixture, new InMemoryWhatsAppGroupMappingPort());

    await expect(
      administration.unlinkGroup(
        createWhatsAppCommunityRef(TEST_WHATSAPP_SCOPE, "community-a"),
        createWhatsAppGroupRef(TEST_WHATSAPP_SCOPE, "community-a"),
      ),
    ).rejects.toBeInstanceOf(WhatsAppGroupRelationshipError);
    expect(fixture.operations).toEqual([]);
  });

  it("uses typed capability, unsupported-operation, and scope errors", async () => {
    const fixture = new WhatsAppGroupSocketFixture({
      disabledCapabilities: ["rename-conversation"],
    });
    fixture.seed({ id: "group-a", kind: "group", title: "Original" });
    const administration = createAdministration(fixture, new InMemoryWhatsAppGroupMappingPort());
    const groupRef = createWhatsAppGroupRef(TEST_WHATSAPP_SCOPE, "group-a");

    await expect(administration.renameConversation(groupRef, "Changed")).rejects.toMatchObject({
      name: "WhatsAppGroupCapabilityError",
      code: "WHATSAPP_GROUP_CAPABILITY_UNAVAILABLE",
      capability: "rename-conversation",
    });
    await expect(
      administration.create(TEST_WHATSAPP_SCOPE.accountId, {
        kind: "channel",
        displayName: "Unsupported",
      }),
    ).rejects.toBeInstanceOf(WhatsAppGroupUnsupportedError);
    await expect(
      administration.list(parseRelayAccountId("another-account")),
    ).rejects.toBeInstanceOf(WhatsAppGroupScopeError);
    expect(() => administration.deleteGlobally(groupRef)).toThrow(WhatsAppGroupUnsupportedError);
  });

  it("retires operationally in notice, unlink, participant removal, leave, tombstone order", async () => {
    const operations: string[] = [];
    const fixture = new WhatsAppGroupSocketFixture({ operationLog: operations });
    fixture.seed({ id: "community-a", kind: "community", title: "Community" });
    fixture.seed({
      id: "group-a",
      kind: "group",
      title: "Retiring",
      parentCommunityId: "community-a",
      participantIds: ["managed-a", "managed-b", "other"],
    });
    const mappings = new InMemoryWhatsAppGroupMappingPort(operations);
    const administration = createAdministration(fixture, mappings);
    const groupRef = createWhatsAppGroupRef(TEST_WHATSAPP_SCOPE, "group-a");
    mappings.seed({
      role: "progress",
      title: "Retiring",
      ref: groupRef,
      parentCommunityRef: createWhatsAppCommunityRef(TEST_WHATSAPP_SCOPE, "community-a"),
    });
    operations.length = 0;

    await administration.retireConversation(groupRef, {
      noticeText: "This managed group is retiring.",
      managedParticipants: [
        createWhatsAppParticipantRef(TEST_WHATSAPP_SCOPE, "managed-a"),
        createWhatsAppParticipantRef(TEST_WHATSAPP_SCOPE, "managed-b"),
      ],
      reason: "provisioning-retirement",
    });

    expect(operations).toEqual([
      "send-notice:group-a:This managed group is retiring.",
      "unlink:community-a:group-a",
      "remove-participants:group-a:managed-a,managed-b",
      "leave:group-a",
      "tombstone:group-a",
    ]);
    expect(mappings.tombstones).toEqual([
      expect.objectContaining({
        ref: groupRef,
        reason: "provisioning-retirement",
      }),
    ]);
  });

  it("skips managed-participant removal during retirement when the socket cannot support it", async () => {
    const operations: string[] = [];
    const fixture = new WhatsAppGroupSocketFixture({
      disabledCapabilities: ["manage-participants"],
      operationLog: operations,
    });
    fixture.seed({ id: "group-a", kind: "group", title: "Retiring" });
    const mappings = new InMemoryWhatsAppGroupMappingPort(operations);
    const administration = createAdministration(fixture, mappings);

    await administration.retireConversation(
      createWhatsAppGroupRef(TEST_WHATSAPP_SCOPE, "group-a"),
      {
        managedParticipants: [createWhatsAppParticipantRef(TEST_WHATSAPP_SCOPE, "managed-a")],
      },
    );

    expect(operations).toEqual(["leave:group-a", "tombstone:group-a"]);
  });

  it("tombstones an already-left conversation when retirement retries after persistence failure", async () => {
    const operations: string[] = [];
    const fixture = new WhatsAppGroupSocketFixture({ operationLog: operations });
    fixture.seed({ id: "group-a", kind: "group", title: "Retiring" });
    const mappings = new InMemoryWhatsAppGroupMappingPort(operations);
    const groupRef = createWhatsAppGroupRef(TEST_WHATSAPP_SCOPE, "group-a");
    mappings.seed({
      role: "progress",
      title: "Retiring",
      ref: groupRef,
    });
    mappings.failNextTombstone();
    const administration = createAdministration(fixture, mappings);

    const address = {
      providerId: groupRef.providerId,
      accountId: groupRef.accountId,
      conversationId: groupRef.conversationId,
    };

    await expect(administration.retire(address)).rejects.toThrow("Forced tombstone failure");
    expect(fixture.get("group-a")).toBeUndefined();
    expect(mappings.list(TEST_WHATSAPP_SCOPE)).toHaveLength(1);
    expect(await mappings.listPendingRetirements(TEST_WHATSAPP_SCOPE)).toHaveLength(1);

    await administration.retire(address);

    expect(operations).toEqual(["leave:group-a", "tombstone:group-a"]);
    expect(mappings.list(TEST_WHATSAPP_SCOPE)).toEqual([]);
    expect(await mappings.listPendingRetirements(TEST_WHATSAPP_SCOPE)).toEqual([]);
  });

  it("recovers an unmapped retirement after leaving but before tombstoning", async () => {
    const operations: string[] = [];
    const fixture = new WhatsAppGroupSocketFixture({ operationLog: operations });
    fixture.seed({ id: "group-a", kind: "group", title: "Retiring" });
    const mappings = new InMemoryWhatsAppGroupMappingPort(operations);
    mappings.failNextTombstone();
    const administration = createAdministration(fixture, mappings);
    const groupRef = createWhatsAppGroupRef(TEST_WHATSAPP_SCOPE, "group-a");
    const address = {
      providerId: groupRef.providerId,
      accountId: groupRef.accountId,
      conversationId: groupRef.conversationId,
    };

    await expect(administration.retire(address)).rejects.toThrow("Forced tombstone failure");
    expect(fixture.get("group-a")).toBeUndefined();
    expect(mappings.list(TEST_WHATSAPP_SCOPE)).toEqual([]);
    expect(await mappings.listPendingRetirements(TEST_WHATSAPP_SCOPE)).toHaveLength(1);

    await administration.retire(address);

    expect(operations).toEqual(["leave:group-a", "tombstone:group-a"]);
    expect(await mappings.listPendingRetirements(TEST_WHATSAPP_SCOPE)).toEqual([]);
  });

  it("validates retirement metadata before any remote side effect", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    fixture.seed({ id: "group-a", kind: "group", title: "Retiring" });
    const administration = createAdministration(fixture, new InMemoryWhatsAppGroupMappingPort());

    await expect(
      administration.retireConversation(createWhatsAppGroupRef(TEST_WHATSAPP_SCOPE, "group-a"), {
        reason: "   ",
      }),
    ).rejects.toThrow("retirement reason");
    expect(fixture.get("group-a")).toBeDefined();
    expect(fixture.operations).toEqual([]);
  });

  it("keeps opaque provider and account scopes distinct in the mapping fixture", async () => {
    const scopeOne = {
      providerId: parseRelayProviderId("provider"),
      accountId: parseRelayAccountId("account\u0000suffix"),
    };
    const scopeTwo = {
      providerId: parseRelayProviderId("provider\u0000account"),
      accountId: parseRelayAccountId("suffix"),
    };
    const mappings = new InMemoryWhatsAppGroupMappingPort();
    mappings.seed(groupMapping("progress", "group-one", "Progress", "community-one", scopeOne));
    mappings.seed(groupMapping("progress", "group-two", "Progress", "community-two", scopeTwo));

    await expect(mappings.get(scopeOne, "progress")).resolves.toMatchObject({
      ref: { conversationId: "group-one" },
    });
    await expect(mappings.get(scopeTwo, "progress")).resolves.toMatchObject({
      ref: { conversationId: "group-two" },
    });
  });
});

function createAdministration(
  fixture: WhatsAppGroupSocketFixture,
  mappings: InMemoryWhatsAppGroupMappingPort,
): WhatsAppGroupAdministration {
  return new WhatsAppGroupAdministration({
    scope: TEST_WHATSAPP_SCOPE,
    socket: fixture.socket,
    mappings,
    now: () => "2026-08-07T00:00:00.000Z",
  });
}
