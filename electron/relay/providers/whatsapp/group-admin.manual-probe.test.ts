import { describe, expect, it } from "vitest";

import { WhatsAppGroupAdministration } from "./group-admin";
import {
  WHATSAPP_GROUP_MANUAL_PROBE_CONFIRMATION,
  runWhatsAppGroupManualProbe,
} from "./group-admin.manual-probe";
import {
  InMemoryWhatsAppGroupMappingPort,
  TEST_WHATSAPP_SCOPE,
  WhatsAppGroupSocketFixture,
} from "./group-admin.test-fixtures";

describe("runWhatsAppGroupManualProbe", () => {
  it("does not touch the socket without the explicit live-probe confirmation", async () => {
    const fixture = seededFixture();
    const administration = createAdministration(fixture);

    await expect(
      runWhatsAppGroupManualProbe(administration, {
        confirmation: "not-confirmed",
        scope: TEST_WHATSAPP_SCOPE,
        communityId: "community-a",
        groupId: "group-a",
        expectedTitle: "Probe Target",
        temporaryTitle: "Probe Target (temporary)",
      }),
    ).rejects.toThrow("requires confirmation");
    expect(fixture.operations).toEqual([]);
  });

  it("validates the explicit parent and restores the title in a fixture-only dry run", async () => {
    const fixture = seededFixture();
    const administration = createAdministration(fixture);

    await expect(
      runWhatsAppGroupManualProbe(administration, {
        confirmation: WHATSAPP_GROUP_MANUAL_PROBE_CONFIRMATION,
        scope: TEST_WHATSAPP_SCOPE,
        communityId: "community-a",
        groupId: "group-a",
        expectedTitle: "Probe Target",
        temporaryTitle: "Probe Target (temporary)",
      }),
    ).resolves.toEqual({
      validatedParent: true,
      originalTitle: "Probe Target",
      restoredTitle: "Probe Target",
    });
    expect(fixture.operations).toEqual([
      "rename:group-a:Probe Target (temporary)",
      "rename:group-a:Probe Target",
    ]);
  });

  it("restores the original title when post-rename verification fails", async () => {
    const fixture = seededFixture();
    fixture.failNextMetadataReadAfterRename();
    const administration = createAdministration(fixture);

    await expect(
      runWhatsAppGroupManualProbe(administration, {
        confirmation: WHATSAPP_GROUP_MANUAL_PROBE_CONFIRMATION,
        scope: TEST_WHATSAPP_SCOPE,
        communityId: "community-a",
        groupId: "group-a",
        expectedTitle: "Probe Target",
        temporaryTitle: "Probe Target (temporary)",
      }),
    ).rejects.toThrow("failed after restoring the original title");
    expect(fixture.get("group-a")?.title).toBe("Probe Target");
    expect(fixture.operations).toEqual([
      "rename:group-a:Probe Target (temporary)",
      "rename:group-a:Probe Target",
    ]);
  });
});

function seededFixture(): WhatsAppGroupSocketFixture {
  const fixture = new WhatsAppGroupSocketFixture();
  fixture.seed({ id: "community-a", kind: "community", title: "Community" });
  fixture.seed({
    id: "group-a",
    kind: "group",
    title: "Probe Target",
    parentCommunityId: "community-a",
  });
  return fixture;
}

function createAdministration(fixture: WhatsAppGroupSocketFixture): WhatsAppGroupAdministration {
  return new WhatsAppGroupAdministration({
    scope: TEST_WHATSAPP_SCOPE,
    socket: fixture.socket,
    mappings: new InMemoryWhatsAppGroupMappingPort(),
  });
}
