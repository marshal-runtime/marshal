import { describe, expect, it, vi } from "vitest";

import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayProviderId,
} from "../../../../common/relay-contract";
import { testDouble } from "../../../testing/harness";
import type { RelayHostMediaAdapter } from "../../host-media-adapter";
import { createLiveWhatsAppProviderComposition } from "./live-composition";
import type { WhatsAppService } from "./service";

const ACCOUNT_ID = parseRelayAccountId("primary");
const ADDRESS = {
  providerId: parseRelayProviderId("whatsapp-baileys"),
  accountId: ACCOUNT_ID,
  conversationId: parseRelayConversationId("session@g.us"),
};

describe("live WhatsApp provider composition", () => {
  it("retires a session access point by unlinking and leaving through the sidecar", async () => {
    const retireSessionGroup = vi.fn<WhatsAppService["retireSessionGroup"]>().mockResolvedValue({
      type: "retire-session-group",
      conversationId: ADDRESS.conversationId,
      unlinked: true,
      left: true,
    });
    const service = testDouble<WhatsAppService>({
      getManagedGroupIds: () => ({
        community: "community@g.us",
        fixed: {
          "new-chats": "new-chats@g.us",
          progress: "progress@g.us",
          "information-control": "information@g.us",
        },
      }),
      retireSessionGroup,
      getStatus: () =>
        testDouble({
          initialized: true,
          connection: "connected",
        }),
      subscribeStatus: () => () => undefined,
    });
    const composition = createLiveWhatsAppProviderComposition({
      service,
      hostMedia: testDouble<RelayHostMediaAdapter>({}),
      accountId: ACCOUNT_ID,
      now: () => "2026-08-08T12:00:00.000Z",
    });

    await expect(
      composition.managedGroupAdministration.retireGroup({
        address: ADDRESS,
        idempotencyKey: "retire-1",
        requestedAt: "2026-08-08T12:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { state: "retired", role: "session" },
    });
    expect(retireSessionGroup).toHaveBeenCalledWith({
      conversationId: ADDRESS.conversationId,
      communityConversationId: "community@g.us",
    });
    expect(composition.provider.capabilities(ACCOUNT_ID).retireConversation).toBe(true);
  });
});
