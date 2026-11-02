import { describe, expect, it } from "vitest";

import {
  MARSHAL_WHATSAPP_COMMUNITY_TITLE,
  MARSHAL_WHATSAPP_FIXED_GROUPS,
  WhatsAppCommunityProvisioner,
  WhatsAppProvisioningAmbiguityError,
} from "./community-provisioner";
import {
  WhatsAppGroupAdministration,
  WhatsAppGroupRelationshipError,
  createWhatsAppCommunityRef,
  createWhatsAppGroupRef,
} from "./group-admin";
import {
  InMemoryWhatsAppGroupMappingPort,
  TEST_WHATSAPP_SCOPE,
  WhatsAppGroupSocketFixture,
  communityMapping,
  groupMapping,
} from "./group-admin.test-fixtures";

describe("WhatsAppCommunityProvisioner", () => {
  it("reuses remote creation after a failed mapping write and stays idempotent across retries", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    const mappings = new InMemoryWhatsAppGroupMappingPort();
    mappings.failNextSet("community");

    await expect(createProvisioner(fixture, mappings).provision()).rejects.toThrow(
      "Forced mapping failure",
    );
    expect(fixture.countByTitle(MARSHAL_WHATSAPP_COMMUNITY_TITLE)).toBe(1);

    const provisioned = await createProvisioner(fixture, mappings).provision();
    const mutatingOperations = [...fixture.operations];
    const repeated = await createProvisioner(fixture, mappings).provision();

    expect(repeated).toEqual(provisioned);
    expect(fixture.operations).toEqual(mutatingOperations);
    expect(fixture.countByTitle(MARSHAL_WHATSAPP_COMMUNITY_TITLE)).toBe(1);
    for (const group of MARSHAL_WHATSAPP_FIXED_GROUPS) {
      expect(fixture.countByTitle(group.title)).toBe(1);
    }
    expect(
      mappings
        .list(TEST_WHATSAPP_SCOPE)
        .map((mapping) => mapping.role)
        .sort(),
    ).toEqual(["community", "information-control", "new-chats", "progress"]);
  });

  it("serializes concurrent provisioners for the same provider account", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    const mappings = new InMemoryWhatsAppGroupMappingPort();

    const [first, second] = await Promise.all([
      createProvisioner(fixture, mappings).provision(),
      createProvisioner(fixture, mappings).provision(),
    ]);

    expect(second).toEqual(first);
    expect(fixture.countByTitle(MARSHAL_WHATSAPP_COMMUNITY_TITLE)).toBe(1);
    for (const group of MARSHAL_WHATSAPP_FIXED_GROUPS) {
      expect(fixture.countByTitle(group.title)).toBe(1);
    }
  });

  it("serializes retirement behind topology validation and mapping persistence", async () => {
    const operations: string[] = [];
    const fixture = new WhatsAppGroupSocketFixture({ operationLog: operations });
    const mappings = new InMemoryWhatsAppGroupMappingPort(operations);
    const pause = mappings.pauseNextSet("community");
    const provisioning = createProvisioner(fixture, mappings).provision();
    await pause.entered;
    const progress = fixture.findByTitle("Progress")[0];
    if (!progress) throw new Error("Expected the progress group before mapping persistence");
    const progressRef = createWhatsAppGroupRef(TEST_WHATSAPP_SCOPE, progress.id);
    const retirement = createAdministration(fixture, mappings).retire({
      providerId: progressRef.providerId,
      accountId: progressRef.accountId,
      conversationId: progressRef.conversationId,
    });

    expect(fixture.get(progress.id)).toBeDefined();
    expect(operations).not.toContain(`leave:${progress.id}`);

    pause.release();
    await Promise.all([provisioning, retirement]);

    expect(fixture.get(progress.id)).toBeUndefined();
    expect(operations.indexOf("mapping-set:information-control:group-3")).toBeLessThan(
      operations.indexOf(`leave:${progress.id}`),
    );
  });

  it("does not reactivate a group with pending retirement intent", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    fixture.seed({
      id: "marshal-community",
      kind: "community",
      title: MARSHAL_WHATSAPP_COMMUNITY_TITLE,
    });
    fixture.seed({
      id: "retiring-progress",
      kind: "group",
      title: "Progress",
      parentCommunityId: "marshal-community",
    });
    const mappings = new InMemoryWhatsAppGroupMappingPort();
    mappings.seed(communityMapping("marshal-community", MARSHAL_WHATSAPP_COMMUNITY_TITLE));
    mappings.seed(groupMapping("progress", "retiring-progress", "Progress", "marshal-community"));
    fixture.failNextLeave();
    const retiringRef = createWhatsAppGroupRef(TEST_WHATSAPP_SCOPE, "retiring-progress");

    await expect(
      createAdministration(fixture, mappings).retireConversation(retiringRef),
    ).rejects.toThrow("Forced leave failure");
    expect(await mappings.listPendingRetirements(TEST_WHATSAPP_SCOPE)).toHaveLength(1);
    expect(fixture.get("retiring-progress")?.parentCommunityId).toBeUndefined();
    fixture.operations.length = 0;

    const provisioned = await createProvisioner(fixture, mappings).provision();

    expect(provisioned.groups.progress.conversationId).not.toBe("retiring-progress");
    expect(fixture.get("retiring-progress")?.parentCommunityId).toBeUndefined();
    expect(fixture.operations).not.toContain("link:marshal-community:retiring-progress");
    await expect(mappings.get(TEST_WHATSAPP_SCOPE, "progress")).resolves.toMatchObject({
      ref: { conversationId: provisioned.groups.progress.conversationId },
    });
  });

  it("replaces child mappings whose parent community is pending retirement", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    fixture.seed({
      id: "retiring-community",
      kind: "community",
      title: MARSHAL_WHATSAPP_COMMUNITY_TITLE,
    });
    for (const group of MARSHAL_WHATSAPP_FIXED_GROUPS) {
      fixture.seed({
        id: `retiring-${group.role}`,
        kind: "group",
        title: group.title,
        parentCommunityId: "retiring-community",
      });
    }
    const mappings = new InMemoryWhatsAppGroupMappingPort();
    mappings.seed(communityMapping("retiring-community", MARSHAL_WHATSAPP_COMMUNITY_TITLE));
    for (const group of MARSHAL_WHATSAPP_FIXED_GROUPS) {
      mappings.seed(
        groupMapping(group.role, `retiring-${group.role}`, group.title, "retiring-community"),
      );
    }
    fixture.failNextLeave();
    const retiringCommunity = createWhatsAppCommunityRef(TEST_WHATSAPP_SCOPE, "retiring-community");

    await expect(
      createAdministration(fixture, mappings).retireConversation(retiringCommunity),
    ).rejects.toThrow("Forced leave failure");

    const provisioned = await createProvisioner(fixture, mappings).provision();

    expect(provisioned.community.conversationId).not.toBe("retiring-community");
    for (const group of MARSHAL_WHATSAPP_FIXED_GROUPS) {
      expect(provisioned.groups[group.role].conversationId).not.toBe(`retiring-${group.role}`);
    }
  });

  it("recovers partial mappings and an unlinked remote group after restart", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    fixture.seed({
      id: "marshal-community",
      kind: "community",
      title: MARSHAL_WHATSAPP_COMMUNITY_TITLE,
    });
    fixture.seed({
      id: "new-chats",
      kind: "group",
      title: "New Chats",
      parentCommunityId: "marshal-community",
    });
    fixture.seed({ id: "progress", kind: "group", title: "Progress" });
    const mappings = new InMemoryWhatsAppGroupMappingPort();
    mappings.seed(communityMapping("marshal-community", MARSHAL_WHATSAPP_COMMUNITY_TITLE));
    mappings.seed(groupMapping("new-chats", "new-chats", "New Chats", "marshal-community"));

    const provisioned = await createProvisioner(fixture, mappings).provision();

    expect(provisioned.community.conversationId).toBe("marshal-community");
    expect(provisioned.groups["new-chats"].conversationId).toBe("new-chats");
    expect(provisioned.groups.progress.conversationId).toBe("progress");
    expect(fixture.linkedGroupIds("marshal-community")).toContain("progress");
    expect(fixture.operations).toContain("link:marshal-community:progress");
    expect(fixture.operations.some((operation) => operation.includes(":New Chats"))).toBe(false);
    expect(fixture.operations.some((operation) => operation.includes(":Progress"))).toBe(false);
    expect(fixture.countByTitle("Information & Control")).toBe(1);
  });

  it("disambiguates duplicate titles by validated community parentage", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    fixture.seed({
      id: "duplicate-community",
      kind: "community",
      title: MARSHAL_WHATSAPP_COMMUNITY_TITLE,
    });
    fixture.seed({
      id: "marshal-community",
      kind: "community",
      title: MARSHAL_WHATSAPP_COMMUNITY_TITLE,
    });
    fixture.seed({
      id: "right-new-chats",
      kind: "group",
      title: "New Chats",
      parentCommunityId: "marshal-community",
    });
    fixture.seed({
      id: "right-information-control",
      kind: "group",
      title: "Information & Control",
      parentCommunityId: "marshal-community",
    });
    fixture.seed({
      id: "wrong-progress",
      kind: "group",
      title: "Progress",
      parentCommunityId: "duplicate-community",
    });
    fixture.seed({ id: "unlinked-progress", kind: "group", title: "Progress" });
    const mappings = new InMemoryWhatsAppGroupMappingPort();

    const provisioned = await createProvisioner(fixture, mappings).provision();

    expect(provisioned.community.conversationId).toBe("marshal-community");
    expect(provisioned.groups["new-chats"].conversationId).toBe("right-new-chats");
    expect(provisioned.groups.progress.conversationId).toBe("unlinked-progress");
    expect(fixture.linkedGroupIds("marshal-community")).toContain("unlinked-progress");
    expect(fixture.linkedGroupIds("duplicate-community")).toContain("wrong-progress");
  });

  it("rejects indistinguishable duplicate communities instead of choosing by list order", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    fixture.seed({
      id: "community-a",
      kind: "community",
      title: MARSHAL_WHATSAPP_COMMUNITY_TITLE,
    });
    fixture.seed({
      id: "community-b",
      kind: "community",
      title: MARSHAL_WHATSAPP_COMMUNITY_TITLE,
    });

    await expect(
      createProvisioner(fixture, new InMemoryWhatsAppGroupMappingPort()).provision(),
    ).rejects.toBeInstanceOf(WhatsAppProvisioningAmbiguityError);
    expect(fixture.operations).toEqual([]);
  });

  it("scores duplicate communities by distinct fixed roles rather than duplicate titles", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    fixture.seed({
      id: "duplicate-heavy",
      kind: "community",
      title: MARSHAL_WHATSAPP_COMMUNITY_TITLE,
    });
    fixture.seed({
      id: "complete-community",
      kind: "community",
      title: MARSHAL_WHATSAPP_COMMUNITY_TITLE,
    });
    for (const id of ["duplicate-1", "duplicate-2", "duplicate-3", "duplicate-4"]) {
      fixture.seed({
        id,
        kind: "group",
        title: "New Chats",
        parentCommunityId: "duplicate-heavy",
      });
    }
    fixture.seed({
      id: "complete-new-chats",
      kind: "group",
      title: "New Chats",
      parentCommunityId: "complete-community",
    });
    fixture.seed({
      id: "complete-progress",
      kind: "group",
      title: "Progress",
      parentCommunityId: "complete-community",
    });
    fixture.seed({
      id: "complete-information",
      kind: "group",
      title: "Information & Control",
      parentCommunityId: "complete-community",
    });

    const provisioned = await createProvisioner(
      fixture,
      new InMemoryWhatsAppGroupMappingPort(),
    ).provision();

    expect(provisioned.community.conversationId).toBe("complete-community");
  });

  it("surfaces typed capability failures without creating a fallback-shaped result", async () => {
    const fixture = new WhatsAppGroupSocketFixture({
      disabledCapabilities: ["create-community"],
    });

    await expect(
      createProvisioner(fixture, new InMemoryWhatsAppGroupMappingPort()).provision(),
    ).rejects.toMatchObject({
      name: "WhatsAppGroupCapabilityError",
      capability: "create-community",
    });
  });

  it("rejects a recovered group mapping linked to another community", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    fixture.seed({
      id: "marshal-community",
      kind: "community",
      title: MARSHAL_WHATSAPP_COMMUNITY_TITLE,
    });
    fixture.seed({ id: "other-community", kind: "community", title: "Other" });
    fixture.seed({
      id: "mapped-new-chats",
      kind: "group",
      title: "New Chats",
      parentCommunityId: "other-community",
    });
    const mappings = new InMemoryWhatsAppGroupMappingPort();
    mappings.seed(communityMapping("marshal-community", MARSHAL_WHATSAPP_COMMUNITY_TITLE));
    mappings.seed(groupMapping("new-chats", "mapped-new-chats", "New Chats", "other-community"));

    await expect(createProvisioner(fixture, mappings).provision()).rejects.toBeInstanceOf(
      WhatsAppGroupRelationshipError,
    );
    expect(fixture.operations).toEqual([]);
  });

  it("rejects duplicate role mappings before mutating any remote conversation", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    fixture.seed({
      id: "marshal-community",
      kind: "community",
      title: MARSHAL_WHATSAPP_COMMUNITY_TITLE,
    });
    fixture.seed({
      id: "shared-group",
      kind: "group",
      title: "New Chats",
      parentCommunityId: "marshal-community",
    });
    const mappings = new InMemoryWhatsAppGroupMappingPort();
    mappings.seed(communityMapping("marshal-community", MARSHAL_WHATSAPP_COMMUNITY_TITLE));
    mappings.seed(groupMapping("new-chats", "shared-group", "New Chats", "marshal-community"));
    mappings.seed(groupMapping("progress", "shared-group", "Progress", "marshal-community"));

    await expect(createProvisioner(fixture, mappings).provision()).rejects.toThrow(
      'managed roles "new-chats" and "progress" map to the same conversation',
    );
    expect(fixture.operations).toEqual([]);
    expect(fixture.get("shared-group")?.title).toBe("New Chats");
  });

  it("preflights mapped-group capabilities before renaming", async () => {
    const fixture = new WhatsAppGroupSocketFixture({
      disabledCapabilities: ["list-community-groups"],
    });
    fixture.seed({
      id: "marshal-community",
      kind: "community",
      title: MARSHAL_WHATSAPP_COMMUNITY_TITLE,
    });
    fixture.seed({
      id: "mapped-new-chats",
      kind: "group",
      title: "Legacy Name",
      parentCommunityId: "marshal-community",
    });
    const mappings = new InMemoryWhatsAppGroupMappingPort();
    mappings.seed(communityMapping("marshal-community", MARSHAL_WHATSAPP_COMMUNITY_TITLE));
    mappings.seed(groupMapping("new-chats", "mapped-new-chats", "New Chats", "marshal-community"));

    await expect(createProvisioner(fixture, mappings).provision()).rejects.toMatchObject({
      name: "WhatsAppGroupCapabilityError",
      capability: "list-community-groups",
    });
    expect(fixture.get("mapped-new-chats")?.title).toBe("Legacy Name");
    expect(fixture.operations).toEqual([]);
  });

  it("reserves groups mapped to later roles during title fallback", async () => {
    const fixture = new WhatsAppGroupSocketFixture();
    fixture.seed({
      id: "marshal-community",
      kind: "community",
      title: MARSHAL_WHATSAPP_COMMUNITY_TITLE,
    });
    fixture.seed({
      id: "mapped-progress",
      kind: "group",
      title: "New Chats",
      parentCommunityId: "marshal-community",
    });
    const mappings = new InMemoryWhatsAppGroupMappingPort();
    mappings.seed(communityMapping("marshal-community", MARSHAL_WHATSAPP_COMMUNITY_TITLE));
    mappings.seed(groupMapping("progress", "mapped-progress", "Progress", "marshal-community"));

    const provisioned = await createProvisioner(fixture, mappings).provision();

    expect(provisioned.groups["new-chats"].conversationId).not.toBe(
      provisioned.groups.progress.conversationId,
    );
    expect(provisioned.groups.progress.conversationId).toBe("mapped-progress");
    expect(fixture.get("mapped-progress")?.title).toBe("Progress");
    expect(fixture.countByTitle("New Chats")).toBe(1);
  });
});

function createProvisioner(
  fixture: WhatsAppGroupSocketFixture,
  mappings: InMemoryWhatsAppGroupMappingPort,
): WhatsAppCommunityProvisioner {
  return new WhatsAppCommunityProvisioner({
    administration: createAdministration(fixture, mappings),
    mappings,
  });
}

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
