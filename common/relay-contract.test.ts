import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayMessageId,
  parseRelayProviderId,
} from "./relay-contract";
import type { RelayAccountId, RelayProviderId } from "./relay-contract";

describe("relay identifiers", () => {
  it("preserves opaque identifier values", () => {
    expect(parseRelayProviderId("provider:opaque/value")).toBe("provider:opaque/value");
    expect(parseRelayAccountId("account|opaque")).toBe("account|opaque");
    expect(parseRelayConversationId("conversation#opaque")).toBe("conversation#opaque");
    expect(parseRelayMessageId("message?opaque")).toBe("message?opaque");
  });

  it("rejects empty, untrimmed, and non-string values", () => {
    const parsers = [
      parseRelayProviderId,
      parseRelayAccountId,
      parseRelayConversationId,
      parseRelayMessageId,
    ];

    for (const parse of parsers) {
      expect(() => parse("")).toThrow("non-empty, trimmed string");
      expect(() => parse(" value")).toThrow("non-empty, trimmed string");
      expect(() => parse("value ")).toThrow("non-empty, trimmed string");
      expect(() => parse(42)).toThrow("non-empty, trimmed string");
    }
  });

  it("keeps identifier kinds nominally distinct", () => {
    const providerId = parseRelayProviderId("provider");

    expectTypeOf(providerId).toMatchTypeOf<string>();
    expectTypeOf(providerId).not.toEqualTypeOf<RelayAccountId>();
    expectTypeOf(providerId).toEqualTypeOf<RelayProviderId>();
  });
});
