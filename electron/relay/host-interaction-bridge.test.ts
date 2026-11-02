import { describe, expect, it, vi } from "vitest";

import type { PermissionAction } from "../../common/marshal-constants";
import type { MessageQuestion } from "../../common/marshal-ipc-contract";
import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayMessageId,
  parseRelayProviderId,
} from "../../common/relay-contract";
import type { SessionManager } from "../sessions";
import { testDouble } from "../testing/harness";
import type { RelayExperienceCoordinator } from "./experience-coordinator";
import { RelayHostInteractionBridge } from "./host-interaction-bridge";

const ADDRESS = {
  providerId: parseRelayProviderId("whatsapp-baileys"),
  accountId: parseRelayAccountId("primary"),
  conversationId: parseRelayConversationId("group@g.us"),
};
const SECOND_ADDRESS = {
  providerId: parseRelayProviderId("example-chat"),
  accountId: parseRelayAccountId("default"),
  conversationId: parseRelayConversationId("legacy-bot"),
};

describe("RelayHostInteractionBridge", () => {
  it("resolves the existing permission waiter from an authorized native selection", async () => {
    const resolve = vi.fn<(action: PermissionAction) => void>();
    const coordinator = coordinatorDouble(["allow"]);
    const bridge = new RelayHostInteractionBridge(
      coordinator,
      testDouble<SessionManager>({ getActiveRelayPublicationOrigin: () => undefined }),
    );

    bridge.presentPermission({
      requestId: "permission-1",
      sessionId: "session-1",
      title: "Permission",
      message: "Allow this action?",
      detail: "",
      buttons: ["Allow", "Deny"],
      resolve,
    });

    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith("allow"));
  });

  it.each(["allow", "open-in-app"])(
    "never resolves a forget-completely card from a relay %s reply",
    async (selected) => {
      const resolve = vi.fn<(action: PermissionAction) => void>();
      const coordinator = coordinatorDouble([selected]);
      const bridge = new RelayHostInteractionBridge(
        coordinator,
        testDouble<SessionManager>({ getActiveRelayPublicationOrigin: () => undefined }),
      );

      bridge.presentPermission({
        requestId: "permission-1",
        sessionId: "session-1",
        title: "Forget Memory Completely",
        message: "Marshal wants to erase a memory permanently. Review it in Marshal.",
        detail: "",
        buttons: ["Open in Marshal", "Deny"],
        resolve,
      });

      await vi.waitFor(() => expect(coordinator.interactions.present).toHaveBeenCalledOnce());
      await new Promise((settle) => setTimeout(settle, 0));
      const [prompt] = vi.mocked(coordinator.interactions.present).mock.calls[0];
      expect(prompt.options.map(({ optionId }) => optionId)).toEqual(["open-in-app", "deny"]);
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it("still lets a relay deny a forget-completely card", async () => {
    const resolve = vi.fn<(action: PermissionAction) => void>();
    const bridge = new RelayHostInteractionBridge(
      coordinatorDouble(["deny"]),
      testDouble<SessionManager>({ getActiveRelayPublicationOrigin: () => undefined }),
    );

    bridge.presentPermission({
      requestId: "permission-1",
      sessionId: "session-1",
      title: "Forget Memory Completely",
      message: "Review it in Marshal.",
      detail: "",
      buttons: ["Open in Marshal", "Deny"],
      resolve,
    });

    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith("deny"));
  });

  it("delivers a valid choice through the durable relay turn path without mirroring text", async () => {
    const sendRelayMessageToSession = vi
      .fn<SessionManager["sendRelayMessageToSession"]>()
      .mockResolvedValue({
        success: true,
        accepted: true,
        messageId: "relay-choice-1",
        deliveryState: "accepted",
      });
    const sessions = testDouble<SessionManager>({
      getActiveRelayPublicationOrigin: () => undefined,
      sendRelayMessageToSession,
    });
    const coordinator = coordinatorDouble(["option-2"]);
    const bridge = new RelayHostInteractionBridge(coordinator, sessions);
    const question: MessageQuestion = {
      question: "Choose a deployment",
      answers: [{ title: "Canary" }, { title: "Production" }],
    };

    bridge.presentChoice("session-1", question, "choice-1");

    await vi.waitFor(() => expect(sendRelayMessageToSession).toHaveBeenCalledOnce());
    expect(sendRelayMessageToSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        deliveryMode: "interrupt",
        idempotencyKey: "relay-interaction:choice:session-1:choice-1",
        message: expect.stringContaining("B. Production"),
      }),
    );
  });

  it("persists and continues a choice on the access point that originated the turn", async () => {
    const sendRelayMessageToSession = vi
      .fn<SessionManager["sendRelayMessageToSession"]>()
      .mockResolvedValue({
        success: true,
        accepted: true,
        messageId: "relay-choice-origin",
        deliveryState: "accepted",
      });
    const sessions = testDouble<SessionManager>({
      getActiveRelayPublicationOrigin: () => SECOND_ADDRESS,
      sendRelayMessageToSession,
    });
    const coordinator = coordinatorDouble(["option-1"], SECOND_ADDRESS);
    vi.mocked(coordinator.getSessionOrigin).mockReturnValue(ADDRESS);
    vi.mocked(coordinator.listSessionAccessPoints).mockReturnValue([ADDRESS, SECOND_ADDRESS]);
    const bridge = new RelayHostInteractionBridge(coordinator, sessions);

    bridge.presentChoice(
      "session-1",
      {
        question: "Choose a deployment",
        answers: [{ title: "Canary" }, { title: "Production" }],
      },
      "choice-origin",
    );

    await vi.waitFor(() => expect(sendRelayMessageToSession).toHaveBeenCalledOnce());
    expect(coordinator.interactions.present).toHaveBeenCalledWith(
      expect.objectContaining({ address: SECOND_ADDRESS }),
    );
    expect(sendRelayMessageToSession).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          providerId: SECOND_ADDRESS.providerId,
          accountId: SECOND_ADDRESS.accountId,
          conversationId: SECOND_ADDRESS.conversationId,
        }),
      }),
    );
  });
});

function coordinatorDouble(
  selectedOptionIds: string[],
  selectionAddress = ADDRESS,
): RelayExperienceCoordinator {
  return testDouble<RelayExperienceCoordinator>({
    getSessionOrigin: vi.fn<RelayExperienceCoordinator["getSessionOrigin"]>(() => ADDRESS),
    listSessionAccessPoints: vi.fn<RelayExperienceCoordinator["listSessionAccessPoints"]>(() => [
      ADDRESS,
    ]),
    interactions: testDouble<RelayExperienceCoordinator["interactions"]>({
      present: vi.fn<RelayExperienceCoordinator["interactions"]["present"]>().mockResolvedValue({
        state: "resolved",
        selection: {
          interactionId: "interaction-1",
          address: selectionAddress,
          providerPromptMessageId: parseRelayMessageId("poll-1"),
          selectedOptionIds,
          responder: { primaryId: "owner" },
          selectedAt: "2026-08-08T12:00:00.000Z",
        },
      }),
      cancelPendingChoicesForSession:
        vi.fn<RelayExperienceCoordinator["interactions"]["cancelPendingChoicesForSession"]>(),
      cancelBySourceRequestId:
        vi.fn<RelayExperienceCoordinator["interactions"]["cancelBySourceRequestId"]>(),
    }),
  });
}
