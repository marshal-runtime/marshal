// Marshal-owned test
import { describe, it, expect } from "vitest";

import {
  GATEWAY_SUPPORTED_MODEL_SUGGESTIONS,
  GatewayUnsupportedModelError,
  isGatewaySupportedModel,
  normalizeGatewayModelId,
} from "./model-id";

describe("normalizeGatewayModelId", () => {
  it("translates dotted Opus aliases to canonical hyphenated ids", () => {
    expect(normalizeGatewayModelId("claude-opus-4.7")).toBe("claude-opus-4-7");
    expect(normalizeGatewayModelId("claude-opus-4.6")).toBe("claude-opus-4-6");
  });

  it("passes already-canonical hyphenated Opus ids through unchanged", () => {
    expect(normalizeGatewayModelId("claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(normalizeGatewayModelId("claude-opus-4-6")).toBe("claude-opus-4-6");
  });

  it("passes non-Opus ids through unchanged — only Opus needs the fix", () => {
    // Sonnet's dotted form is aliased server-side; we deliberately don't translate it.
    expect(normalizeGatewayModelId("claude-sonnet-4.6")).toBe("claude-sonnet-4.6");
    expect(normalizeGatewayModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
    expect(normalizeGatewayModelId("gpt-5.4")).toBe("gpt-5.4");
    expect(normalizeGatewayModelId("gemini-3-pro-preview")).toBe("gemini-3-pro-preview");
  });

  it("passes undefined and empty string through (the create() caller pipes opts.model directly)", () => {
    expect(normalizeGatewayModelId(undefined)).toBeUndefined();
    expect(normalizeGatewayModelId("")).toBe("");
  });

  it("does not normalize unrelated strings that contain similar substrings", () => {
    // Defensive: the map is exact-match. A future Opus 4.10 with a dot
    // wouldn't be silently translated to claude-opus-4-10 unless added here.
    expect(normalizeGatewayModelId("claude-opus-4.10")).toBe("claude-opus-4.10");
    expect(normalizeGatewayModelId("custom-claude-opus-4.7")).toBe("custom-claude-opus-4.7");
  });
});

describe("isGatewaySupportedModel", () => {
  it("accepts canonical hyphenated Claude ids", () => {
    expect(isGatewaySupportedModel("claude-opus-4-7")).toBe(true);
    expect(isGatewaySupportedModel("claude-opus-4-6")).toBe(true);
    expect(isGatewaySupportedModel("claude-sonnet-4-6")).toBe(true);
    expect(isGatewaySupportedModel("claude-haiku-4-5-20251001")).toBe(true);
  });

  it("accepts dotted legacy aliases (translated at the wire boundary)", () => {
    expect(isGatewaySupportedModel("claude-opus-4.7")).toBe(true);
    expect(isGatewaySupportedModel("claude-opus-4.6")).toBe(true);
    expect(isGatewaySupportedModel("claude-sonnet-4.6")).toBe(true);
  });

  it("rejects non-Anthropic models — they're not on the gateway routing path", () => {
    expect(isGatewaySupportedModel("gpt-5.4")).toBe(false);
    expect(isGatewaySupportedModel("gpt-4o")).toBe(false);
    expect(isGatewaySupportedModel("gemini-3-pro-preview")).toBe(false);
  });

  it("treats undefined and empty string as supported — gateway picks its own default", () => {
    // SessionManager passes opts.model=undefined when no explicit model is set.
    // We don't want to error in either case; the gateway will choose for us.
    expect(isGatewaySupportedModel(undefined)).toBe(true);
    expect(isGatewaySupportedModel("")).toBe(true);
  });
});

describe("GatewayUnsupportedModelError", () => {
  it("includes the offending model id and the suggestion list in the message", () => {
    const err = new GatewayUnsupportedModelError("gpt-5.4");
    expect(err.modelId).toBe("gpt-5.4");
    expect(err.message).toContain("gpt-5.4");
    expect(err.message).toContain("claude-opus-4-7");
    expect(err.message).toContain("claude-sonnet-4-6");
    expect(err.supportedIds).toBe(GATEWAY_SUPPORTED_MODEL_SUGGESTIONS);
  });

  it("only lists canonical hyphenated ids — nudges users away from the dotted aliases", () => {
    const err = new GatewayUnsupportedModelError("anything");
    expect(err.message).not.toContain("claude-opus-4.7");
    expect(err.message).not.toContain("claude-sonnet-4.6");
  });
});
