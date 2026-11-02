import type { RuntimeUiInstance } from "@common/runtime-ui";
import { describe, expect, it } from "vitest";

import { placeConversationCards } from "./cardPlacement";

const MESSAGES = [
  { id: "m1", at: Date.parse("2026-09-26T10:00:00.000Z") },
  { id: "m2", at: Date.parse("2026-09-26T10:05:00.000Z") },
  { id: "m3", at: Date.parse("2026-09-26T10:10:00.000Z") },
];

function card(
  instanceId: string,
  openedAt: string,
  anchor?: RuntimeUiInstance["anchor"],
): RuntimeUiInstance {
  return {
    instanceId,
    owner: {
      sessionId: "session-1",
      workspaceName: "marshal",
      extensionId: "marshal.react-ui",
      applicationId: `render-${instanceId}`,
    },
    surface: "inline-card",
    content: { kind: "text", text: instanceId },
    idempotencyKey: `open-${instanceId}`,
    revision: 1,
    openedAt,
    updatedAt: openedAt,
    focusedAt: openedAt,
    ...(anchor ? { anchor } : {}),
  };
}

function ids(placement: ReturnType<typeof placeConversationCards>) {
  return {
    after: Object.fromEntries(
      [...placement.afterMessage].map(([messageId, cards]) => [
        messageId,
        cards.map((entry) => entry.instanceId),
      ]),
    ),
    trailing: placement.trailing.map((entry) => entry.instanceId),
  };
}

describe("placeConversationCards", () => {
  it("anchors a card after the last message committed before it opened", () => {
    const placement = placeConversationCards(
      [card("mid", "2026-09-26T10:06:00.000Z"), card("early", "2026-09-26T09:00:00.000Z")],
      MESSAGES,
      new Set(),
    );
    expect(ids(placement)).toEqual({ after: { m2: ["mid"], m1: ["early"] }, trailing: [] });
  });

  it("trails cards opened after the last message and honors an explicit anchor", () => {
    const placement = placeConversationCards(
      [
        card("live", "2026-09-26T10:11:00.000Z"),
        card("pinned", "2026-09-26T10:12:00.000Z", { afterMessageId: "m1" }),
        card("stale-anchor", "2026-09-26T10:13:00.000Z", { afterMessageId: "gone" }),
      ],
      MESSAGES,
      new Set(),
    );
    expect(ids(placement)).toEqual({
      after: { m1: ["pinned"] },
      trailing: ["live", "stale-anchor"],
    });
  });

  it("leaves a slot-bound card to its message while the slot is mounted", () => {
    const slotted = card("slotted", "2026-09-26T10:06:00.000Z", { slot: "demo" });
    expect(ids(placeConversationCards([slotted], MESSAGES, new Set(["demo"])))).toEqual({
      after: {},
      trailing: [],
    });
    expect(ids(placeConversationCards([slotted], MESSAGES, new Set()))).toEqual({
      after: { m2: ["slotted"] },
      trailing: [],
    });
  });

  it("holds a new slot card during a live turn until its marker renders", () => {
    const pending = card("pending", "2026-09-26T10:11:00.000Z", { slot: "reply" });
    const plain = card("plain", "2026-09-26T10:11:30.000Z");
    expect(ids(placeConversationCards([pending, plain], MESSAGES, new Set(), true))).toEqual({
      after: {},
      trailing: ["plain"],
    });
    expect(ids(placeConversationCards([pending, plain], MESSAGES, new Set(), false))).toEqual({
      after: {},
      trailing: ["pending", "plain"],
    });
  });
});
