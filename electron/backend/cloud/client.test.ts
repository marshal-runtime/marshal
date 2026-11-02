import { it, expect } from "vitest";

import type {
  SessionView as MobileView,
  PermissionCardData as MobileCard,
} from "../../../../marshal-cloud-workers/src/mobile-contract";
import type { SessionView, PermissionCardData } from "../../../common/marshal-ipc-contract";
import { normalizeEvent } from "../normalize-event";
import { cloudRuntimeEvent, cloudTranscript } from "./client";
const portableView = (view: MobileView): SessionView => view;
const portableCard = (card: MobileCard): PermissionCardData => card;
it("maps stable completion IDs, imported context, tool results and transcript recovery to the normal backend contract", () => {
  const raw = {
    sequence: 1,
    eventId: "event",
    at: "2026-10-02T00:00:00Z",
    type: "assistant.message",
    data: { text: "done", messageId: "turn" },
  };
  const e = cloudRuntimeEvent(raw)!;
  expect(normalizeEvent(e)).toMatchObject([
    { type: "turn-complete", message: { id: "event", content: "done" } },
  ]);
  const imported = cloudRuntimeEvent({
    ...raw,
    type: "session.created",
    data: {
      conversation: {
        version: 1,
        sourceRuntimeId: "claude",
        messages: [{ role: "user", content: "Earlier" }],
      },
    },
  })!;
  expect(cloudTranscript([imported, e])).toMatchObject([
    { role: "user", content: "Earlier" },
    { role: "assistant", content: "done" },
  ]);
  expect(
    normalizeEvent({
      id: "snapshot",
      timestamp: raw.at,
      parentId: null,
      type: "session.history_snapshot",
      data: { messages: cloudTranscript([imported, e]) },
    })[0],
  ).toMatchObject({ type: "history-snapshot" });
  expect(
    portableView({
      status: "ready",
      streamingText: "",
      reasoning: null,
      toolStatuses: [],
      tokenUsage: null,
      lastTurnUsage: null,
      error: null,
      sessionStatus: null,
    }).status,
  ).toBe("ready");
  expect(
    portableCard({
      id: "a",
      kind: "custom-tool",
      title: "Bash",
      message: "Permission",
      detail: "git status",
      buttons: ["Allow", "Deny"],
      canPersistAlwaysAllow: false,
    }).kind,
  ).toBe("custom-tool");
});
