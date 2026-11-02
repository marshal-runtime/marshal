import { describe, expect, it } from "vitest";

import {
  appendToMessageWindow,
  calculatePrependScrollTop,
  CHAT_MESSAGE_WINDOW_SIZE,
  prependToMessageWindow,
  trimMessageWindow,
} from "./messageWindow";

const messages = (count: number, offset = 0) =>
  Array.from({ length: count }, (_, index) => ({ id: `m${offset + index}` }));

describe("messageWindow", () => {
  it("collapses consecutive assistant copies with the same content", () => {
    const result = appendToMessageWindow(
      [
        { id: "u1", role: "user", content: "think for ten second" },
        { id: "a1", role: "assistant", content: "Done—I waited ten seconds." },
      ],
      [{ id: "a2", role: "assistant", content: "Done—I waited ten seconds." }],
    );

    expect(result.messages.map((message) => message.id)).toEqual(["u1", "a2"]);
    expect(result.addedCount).toBe(0);
    expect(result.replacedCount).toBe(1);
  });

  it("collapses consecutive assistant copies already in the window", () => {
    const result = appendToMessageWindow(
      [
        { id: "u1", role: "user", content: "think for ten second" },
        { id: "a1", role: "assistant", content: "Done—I waited ten seconds." },
        { id: "a2", role: "assistant", content: "Done—I waited ten seconds." },
      ],
      [],
    );

    expect(result.messages.map((message) => message.id)).toEqual(["u1", "a2"]);
    expect(result.removedDuplicateCount).toBe(1);
  });

  it("keeps only the newest 20 messages", () => {
    expect(trimMessageWindow(messages(50)).map((message) => message.id)).toEqual(
      messages(CHAT_MESSAGE_WINDOW_SIZE, 30).map((message) => message.id),
    );
  });

  it("dedupes live messages and keeps only the newest 20", () => {
    const result = appendToMessageWindow(messages(20), [
      { id: "m19" },
      { id: "m20" },
      { id: "m21" },
    ]);

    expect(result.addedCount).toBe(2);
    expect(result.removedDuplicateCount).toBe(0);
    expect(result.trimmedCount).toBe(2);
    expect(result.messages).toHaveLength(CHAT_MESSAGE_WINDOW_SIZE);
    expect(result.messages[0].id).toBe("m2");
    expect(result.messages.at(-1)?.id).toBe("m21");
  });

  it("replaces an optimistic duplicate with the committed message", () => {
    const result = appendToMessageWindow(
      [{ id: "shared", content: "optimistic", optimistic: true }],
      [{ id: "shared", content: "committed", optimistic: false }],
    );

    expect(result.messages).toEqual([{ id: "shared", content: "committed", optimistic: false }]);
    expect(result.addedCount).toBe(0);
  });

  it("replaces a correlated optimistic id with the canonical server id in time order", () => {
    type CorrelatedMessage = {
      id: string;
      clientMessageId?: string;
      timestamp: Date;
      optimistic?: boolean;
    };
    const existing: CorrelatedMessage[] = [
      { id: "older", timestamp: new Date(1) },
      {
        id: "client-id",
        clientMessageId: "client-id",
        timestamp: new Date(3),
        optimistic: true,
      },
      { id: "newer", timestamp: new Date(4) },
    ];
    const incoming: CorrelatedMessage[] = [
      {
        id: "server-id",
        clientMessageId: "client-id",
        timestamp: new Date(3),
        optimistic: false,
      },
    ];
    const result = appendToMessageWindow(existing, incoming);

    expect(result.messages.map((message) => message.id)).toEqual(["older", "server-id", "newer"]);
    expect(result.addedCount).toBe(0);
  });

  it("prepends older pages with stable dedupe while preserving newer entries", () => {
    const existing = [
      { id: "m2", content: "stale existing copy" },
      { id: "m2", content: "newer copy" },
      { id: "m3", content: "newest" },
    ];
    const result = prependToMessageWindow(existing, [
      { id: "m0", content: "oldest" },
      { id: "m1", content: "older" },
      { id: "m1", content: "duplicate in page" },
      { id: "m2", content: "stale overlap" },
    ]);

    expect(result.messages.map((message) => message.id)).toEqual(["m0", "m1", "m2", "m3"]);
    expect(result.messages[2]).toBe(existing[1]);
    expect(result.addedCount).toBe(2);
    expect(result.removedDuplicateCount).toBe(1);
  });

  it("collapses expanded history back to the newest 20 when a commit arrives", () => {
    const result = appendToMessageWindow(messages(40), [{ id: "m40" }]);

    expect(result.messages).toHaveLength(CHAT_MESSAGE_WINDOW_SIZE);
    expect(result.messages[0].id).toBe("m21");
    expect(result.messages.at(-1)?.id).toBe("m40");
    expect(result.trimmedCount).toBe(21);
  });

  it("can preserve explicitly loaded older history while reconciling messages", () => {
    const result = appendToMessageWindow(messages(40), [{ id: "m40" }], {
      preserveLoadedHistory: true,
    });

    expect(result.messages).toHaveLength(41);
    expect(result.messages[0].id).toBe("m0");
    expect(result.messages.at(-1)?.id).toBe("m40");
    expect(result.trimmedCount).toBe(0);
  });

  it("preserves the visible scroll anchor by the prepended height delta", () => {
    expect(
      calculatePrependScrollTop(
        {
          scrollTop: 120,
          scrollHeight: 1_000,
        },
        1_460,
      ),
    ).toBe(580);
  });

  it("uses the retained row anchor instead of concurrent growth below the viewport", () => {
    expect(
      calculatePrependScrollTop(
        {
          scrollTop: 120,
          scrollHeight: 1_000,
          anchorMessageId: "m20",
          anchorTop: 100,
        },
        1_700,
        560,
      ),
    ).toBe(580);
  });
});
