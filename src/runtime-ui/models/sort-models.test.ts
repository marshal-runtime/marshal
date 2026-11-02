import { describe, it, expect } from "vitest";

import type { ModelInfo } from "@/types/electron";

import { sortModels } from "./sort-models";

const m = (id: string, name?: string): ModelInfo => ({ id, name: name ?? id });

describe("runtime-ui model ordering", () => {
  it("groups Claude before OpenAI before others", () => {
    const sorted = sortModels([
      m("gpt-4.1", "GPT-4.1"),
      m("custom-model", "Custom Model"),
      m("claude-sonnet-4", "Claude Sonnet 4"),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["claude-sonnet-4", "gpt-4.1", "custom-model"]);
  });

  it("orders Claude models by version descending", () => {
    const sorted = sortModels([
      m("claude-sonnet-4", "Claude Sonnet 4"),
      m("claude-opus-4.7", "Claude Opus 4.7"),
      m("claude-haiku-4.5", "Claude Haiku 4.5"),
      m("claude-opus-4.6", "Claude Opus 4.6"),
    ]);
    expect(sorted.map((x) => x.name)).toEqual([
      "Claude Opus 4.7",
      "Claude Opus 4.6",
      "Claude Haiku 4.5",
      "Claude Sonnet 4",
    ]);
  });

  it("orders OpenAI models by version descending — GPT-5.5 lands at the top of the GPT block", () => {
    const sorted = sortModels([
      m("gpt-4.1", "GPT-4.1"),
      m("gpt-5.4-mini", "GPT-5.4 mini"),
      m("gpt-5.5", "GPT-5.5"),
      m("gpt-5.2", "GPT-5.2"),
    ]);
    expect(sorted.map((x) => x.name)).toEqual(["GPT-5.5", "GPT-5.4 mini", "GPT-5.2", "GPT-4.1"]);
  });

  it("places variants of the same model immediately after the base via name tiebreak", () => {
    const sorted = sortModels([
      m("claude-opus-4.7-extra", "Claude Opus 4.7 (Extra high reasoning)"),
      m("claude-opus-4.7-1m", "Claude Opus 4.7 (1M context)(Internal only)"),
      m("claude-opus-4.7", "Claude Opus 4.7"),
      m("claude-opus-4.7-high", "Claude Opus 4.7 (High reasoning)"),
    ]);
    expect(sorted.map((x) => x.name)).toEqual([
      "Claude Opus 4.7",
      "Claude Opus 4.7 (1M context)(Internal only)",
      "Claude Opus 4.7 (Extra high reasoning)",
      "Claude Opus 4.7 (High reasoning)",
    ]);
  });

  it("treats o-series reasoning models as OpenAI (incl. future o5+, double-digit families)", () => {
    // Future-proofing the /^o\d/ branch: includes o9 (single digit > 5) and
    // o10 (double-digit) so a future maintainer who tightens the regex would
    // see this break. o2 doesn't exist yet — OpenAI skipped it for trademark
    // reasons — so it's not in the fixture.
    const sorted = sortModels([
      m("custom", "Custom"),
      m("o10-turbo", "o10-turbo"),
      m("o9-future", "o9-future"),
      m("o3-mini", "o3-mini"),
      m("o1-preview", "o1-preview"),
      m("claude-opus-4.7", "Claude Opus 4.7"),
    ]);
    // claude -> o-series sorted by descending major version -> other.
    expect(sorted.map((x) => x.id)).toEqual([
      "claude-opus-4.7",
      "o10-turbo",
      "o9-future",
      "o3-mini",
      "o1-preview",
      "custom",
    ]);
  });

  it("ranks 4.10 above 4.7 (does not parse versions as floats)", () => {
    const sorted = sortModels([
      m("claude-opus-4.7", "Claude Opus 4.7"),
      m("claude-opus-4.10", "Claude Opus 4.10"),
      m("claude-opus-4.2", "Claude Opus 4.2"),
    ]);
    expect(sorted.map((x) => x.name)).toEqual([
      "Claude Opus 4.10",
      "Claude Opus 4.7",
      "Claude Opus 4.2",
    ]);
  });

  it("handles models without a parseable version (treats as 0)", () => {
    const sorted = sortModels([
      m("claude-experimental", "Claude Experimental"),
      m("claude-opus-4.7", "Claude Opus 4.7"),
    ]);
    expect(sorted[0].name).toBe("Claude Opus 4.7");
    expect(sorted[1].name).toBe("Claude Experimental");
  });

  it("does not mutate the input array", () => {
    const input = [m("gpt-4.1", "GPT-4.1"), m("claude-opus-4.7", "Claude Opus 4.7")];
    const inputCopy = [...input];
    sortModels(input);
    expect(input).toEqual(inputCopy);
  });

  it("returns an empty array for empty input", () => {
    expect(sortModels([])).toEqual([]);
  });
});
